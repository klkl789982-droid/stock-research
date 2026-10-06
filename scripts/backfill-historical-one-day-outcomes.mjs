import fs from "node:fs/promises";
import path from "node:path";
import { buildHistoricalOneDayBackfillPlan, createHistoricalOneDayPriceLedger, reconcileHistoricalOneDayOutcomes, summarizeHistoricalOneDayModelOutcomes, writeHistoricalOneDayOutcomeArtifacts } from "../lib/historical-one-day-outcome-backfill.mjs";
import { createPublicEodQuery, createPublicEodRequestShape, normalizePublicEodRows } from "../lib/public-eod-request.mjs";
import { DEFAULT_PUBLIC_EOD_MAX_ATTEMPTS, runPublicEodRequestWithRetry } from "../lib/public-eod-retry-policy.mjs";
import { classifyPublicEodRequestError } from "../lib/public-eod-request-observability.mjs";
import { normalizeStockCode } from "../lib/stock-code.mjs";

const ROOT = process.cwd();
const PRICE_URL = "https://apis.data.go.kr/1160100/service/GetStockSecuritiesInfoService/getStockPriceInfo";
const REQUEST_TIMEOUT_MS = 15_000;
// The public operation accepts one stock code per request. Historical backfill
// deliberately uses one in-flight request with a small gap to avoid turning a
// single signal-date reconciliation into a provider burst.
const CONCURRENCY = 1;
const REQUEST_INTERVAL_MS = 250;
const DISCOVERY_WINDOW_DAYS = 14;
const execute = process.argv.includes("--execute");
const dryRun = process.argv.includes("--dry-run");
if (execute === dryRun) throw new Error("--dry-run 또는 --execute 중 하나를 지정해야 합니다.");
const signalDateOption = process.argv.find((argument) => argument.startsWith("--signal-date="));
const selectedSignalDate = signalDateOption ? signalDateOption.slice("--signal-date=".length) : null;
if (selectedSignalDate && !/^\d{4}-\d{2}-\d{2}$/u.test(selectedSignalDate)) throw new Error("--signal-date는 YYYY-MM-DD 형식이어야 합니다.");

const toKstDate = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const compact = (date) => date.replaceAll("-", "");
const dashed = (date) => `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
const validClose = (value) => Number.isFinite(value) && value > 0;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const nextCompactDay = (date) => {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + 1);
  return value.toISOString().slice(0, 10).replaceAll("-", "");
};

async function readSnapshots() {
  const directory = path.join(ROOT, "data", "history");
  const files = (await fs.readdir(directory)).filter((file) => /^2026-(08-13|09-22|09-28|09-30)\.json$/u.test(file)).sort();
  return Promise.all(files.map(async (file) => JSON.parse(await fs.readFile(path.join(directory, file), "utf8"))));
}

async function mapConcurrent(items, mapper) {
  const results = Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await mapper(items[index], index);
    }
  }));
  return results;
}

function publicError(message, extra = {}) {
  const error = new Error(message);
  Object.assign(error, extra);
  return error;
}

async function requestRows({ serviceKey, code, beginBasDt, endBasDt, purpose }) {
  const shape = createPublicEodRequestShape({ code, purpose, beginBasDt, endBasDt, pageNo: 1, numOfRows: 20, resultType: "json" });
  const startedAt = new Date();
  const result = await runPublicEodRequestWithRetry({
    maxAttempts: DEFAULT_PUBLIC_EOD_MAX_ATTEMPTS,
    latestMode: false,
    execute: async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      let response;
      try { response = await fetch(`${PRICE_URL}?serviceKey=${serviceKey}&${createPublicEodQuery(shape)}`, { signal: controller.signal }); }
      finally { clearTimeout(timer); }
      if (!response.ok) throw publicError("공식 EOD HTTP 응답 실패", { httpStatus: response.status });
      let payload;
      try { payload = await response.json(); }
      catch { throw publicError("공식 EOD JSON 응답 형식 오류", { observabilityOutcome: "invalidResponse" }); }
      const businessCode = String(payload?.response?.header?.resultCode ?? "");
      if (businessCode && businessCode !== "00") throw publicError("공식 EOD 업무 응답 실패", { businessCode });
      try {
        const normalized = normalizePublicEodRows(payload?.response?.body?.items?.item, { code: shape.code });
        return normalized.rows;
      } catch { throw publicError("공식 EOD 응답 정규화 오류", { observabilityOutcome: "invalidResponse" }); }
    },
  });
  return { rows: result.value, attemptCount: result.attemptCount, elapsedMs: Date.now() - startedAt.getTime() };
}

async function discoverTargetTradingDate({ signal, serviceKey }) {
  const code = signal.trackingCodes.includes("005930") ? "005930" : signal.trackingCodes[0];
  const { rows, attemptCount } = await requestRows({ serviceKey, code, beginBasDt: signal.discoveryWindow.beginBasDt, endBasDt: signal.discoveryWindow.endBasDt, purpose: "historicalOneDayTradingDateDiscovery" });
  const candidates = rows.map((row) => String(row.basDt)).filter((date) => /^\d{8}$/u.test(date) && date >= signal.discoveryWindow.beginBasDt && date <= signal.discoveryWindow.endBasDt).sort();
  if (candidates.length === 0) throw publicError("공식 EOD가 discovery 범위에서 거래일을 반환하지 않았습니다.", { observabilityOutcome: "invalidResponse" });
  return { targetTradingDate: dashed(candidates[0]), discoveryCode: code, attemptCount };
}

async function collectTargetPrices({ snapshot, targetTradingDate, serviceKey }) {
  const targetCompact = compact(targetTradingDate);
  const codes = snapshot.records.map((record) => normalizeStockCode(record.code)).filter(Boolean).sort();
  const stats = { requested: codes.length, succeeded: 0, missing: 0, failed: 0, retries: 0 };
  const prices = await mapConcurrent(codes, async (code, index) => {
    try {
      if (index > 0) await wait(REQUEST_INTERVAL_MS);
      // This operation returns an empty item set for an equal begin/end bound.
      // Keep the range to one calendar day beyond the target, then accept only
      // an exact target basDt below; no neighbouring date becomes an outcome.
      const response = await requestRows({ serviceKey, code, beginBasDt: targetCompact, endBasDt: nextCompactDay(targetTradingDate), purpose: "historicalOneDayOutcomeBackfill" });
      stats.retries += Math.max(0, response.attemptCount - 1);
      const exact = response.rows.filter((row) => String(row.basDt) === targetCompact);
      if (exact.length !== 1 || !validClose(Number(exact[0]?.clpr))) {
        stats.missing += 1;
        return { code, closePrice: null, sourceReferenceDate: null, missingReason: exact.length === 0 ? "targetDateNotReturned" : "targetCloseUnavailable" };
      }
      stats.succeeded += 1;
      return { code, closePrice: Number(exact[0].clpr), sourceReferenceDate: targetTradingDate };
    } catch (error) {
      stats.failed += 1;
      const classified = classifyPublicEodRequestError(error);
      return { code, closePrice: null, sourceReferenceDate: null, missingReason: `request${classified.errorCategory[0].toUpperCase()}${classified.errorCategory.slice(1)}` };
    } finally {
      if ((index + 1) % 100 === 0 || index + 1 === codes.length) console.log(`HISTORICAL_1D_BACKFILL_PROGRESS signalDate=${snapshot.asOfDate} completed=${index + 1} requested=${codes.length}`);
    }
  });
  return { prices, stats };
}

function filePaths(signalDate) {
  return [
    path.join(ROOT, "data", "historical-outcome-prices", `${signalDate}.json`),
    path.join(ROOT, "data", "historical-outcomes", "1d", `${signalDate}.json`),
  ];
}

async function assertArtifactsAbsent(signals) {
  for (const signal of signals) {
    for (const target of filePaths(signal.signalDate)) {
      try { await fs.access(target); throw new Error(`${path.relative(ROOT, target).replaceAll("\\", "/")}: immutable artifact가 이미 존재합니다.`); }
      catch (error) { if (error?.code !== "ENOENT") throw error; }
    }
  }
}

const snapshots = await readSnapshots();
const coverageAsOfDate = toKstDate();
const plan = buildHistoricalOneDayBackfillPlan({ snapshots, coverageAsOfDate, discoveryWindowDays: DISCOVERY_WINDOW_DAYS });
const enrichedSignals = plan.signals
  .filter((signal) => !selectedSignalDate || signal.signalDate === selectedSignalDate)
  .map((signal) => ({ ...signal, trackingCodes: snapshots.find((snapshot) => snapshot.asOfDate === signal.signalDate).records.map((record) => normalizeStockCode(record.code)).filter(Boolean) }));
if (selectedSignalDate && enrichedSignals.length !== 1) throw new Error(`${selectedSignalDate}: historical signal snapshot이 없습니다.`);
if (dryRun) {
  console.log(`HISTORICAL_1D_BACKFILL_PLAN_JSON=${JSON.stringify({ coverageAsOfDate, signals: enrichedSignals.map((signal) => ({ signalDate: signal.signalDate, status: signal.status, discoveryWindow: signal.discoveryWindow, expectedRequests: signal.targetCollection?.expectedRequests ?? 0 })), expectedRequests: enrichedSignals.reduce((sum, signal) => sum + (signal.targetCollection?.expectedRequests ?? 0), 0) })}`);
  process.exit(0);
}

const serviceKey = process.env.DATA_GO_KR_SERVICE_KEY;
if (!serviceKey) throw new Error("DATA_GO_KR_SERVICE_KEY가 없습니다.");
const runnable = enrichedSignals.filter((signal) => signal.status === "DISCOVERY_REQUIRED");
await assertArtifactsAbsent(runnable);
const collectedAt = new Date().toISOString();
const ledgers = [];
const runSignals = [];
for (const signal of runnable) {
  const snapshot = snapshots.find((item) => item.asOfDate === signal.signalDate);
  let discovery;
  console.log(`HISTORICAL_1D_BACKFILL_STAGE signalDate=${signal.signalDate} stage=discovering-target-date`);
  try { discovery = await discoverTargetTradingDate({ signal, serviceKey }); }
  catch (error) {
    runSignals.push({ signalDate: signal.signalDate, status: "DATA_MISSING", reason: "targetTradingDateDiscoveryFailed", detail: classifyPublicEodRequestError(error).errorCategory });
    continue;
  }
  console.log(`HISTORICAL_1D_BACKFILL_STAGE signalDate=${signal.signalDate} stage=collecting-target-prices targetTradingDate=${discovery.targetTradingDate} requested=${snapshot.records.length}`);
  const collection = await collectTargetPrices({ snapshot, targetTradingDate: discovery.targetTradingDate, serviceKey });
  const ledger = createHistoricalOneDayPriceLedger({ signalSnapshot: snapshot, targetTradingDate: discovery.targetTradingDate, collectedAt, targetPrices: collection.prices });
  const outcome = reconcileHistoricalOneDayOutcomes({ snapshots: [snapshot], priceLedgers: [ledger] })[0];
  await writeHistoricalOneDayOutcomeArtifacts({ root: ROOT, priceLedger: ledger, outcome });
  ledgers.push(ledger);
  runSignals.push({ signalDate: signal.signalDate, targetTradingDate: discovery.targetTradingDate, status: "COLLECTED", discoveryAttempts: discovery.attemptCount, ...collection.stats, mature: ledger.records.filter((record) => record.status === "MATURE").length, dataMissing: ledger.records.filter((record) => record.status === "DATA_MISSING").length });
}
const outcomes = reconcileHistoricalOneDayOutcomes({ snapshots, priceLedgers: ledgers });
const metrics = summarizeHistoricalOneDayModelOutcomes({ snapshots, outcomes });
console.log(`HISTORICAL_1D_BACKFILL_RESULT_JSON=${JSON.stringify({ coverageAsOfDate, signals: runSignals, pendingSignals: enrichedSignals.filter((signal) => signal.status === "PENDING").map((signal) => signal.signalDate), modelMetrics: metrics })}`);
