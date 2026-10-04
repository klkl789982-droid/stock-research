import fs from "node:fs/promises";
import path from "node:path";
import { sha256Canonical } from "./snapshot-quality-pipeline.mjs";
import { FUTURE_RETURN_HORIZONS } from "./future-return-resolver.mjs";
import { normalizeStockCode } from "./stock-code.mjs";
import { createHistoricalOutcomeCalendarEvidence, mergeCalendarEvidence } from "./historical-outcome-calendar-evidence.mjs";

export const OUTCOME_COVERAGE_SCHEMA_VERSION = 1;
export const OUTCOME_COVERAGE_STATUSES = Object.freeze(["PENDING", "MATURE", "DATA_MISSING"]);

const isValidDate = (value) => /^\d{4}-\d{2}-\d{2}$/u.test(value ?? "");
const isValidClose = (value) => Number.isFinite(value) && value > 0;
const nextDate = (date) => {
  const result = new Date(`${date}T00:00:00Z`);
  result.setUTCDate(result.getUTCDate() + 1);
  return result.toISOString().slice(0, 10);
};
const isWeekend = (date) => {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return day === 0 || day === 6;
};

export function locateCoverageTarget(calendar, signalDate, offset, coverageAsOfDate) {
  const dates = calendar?.dates ?? {};
  const maximumCheckedDate = Object.keys(dates).sort().at(-1) ?? null;
  let cursor = nextDate(signalDate);
  let tradingDays = 0;
  while (!maximumCheckedDate || cursor <= maximumCheckedDate) {
    const entry = dates[cursor];
    if (!entry) {
      if (isWeekend(cursor)) {
        cursor = nextDate(cursor);
        continue;
      }
      return { status: "DATA_MISSING", targetDate: cursor, reason: "calendarMissing" };
    }
    if (entry.status === "marketClosed") {
      cursor = nextDate(cursor);
      continue;
    }
    if (entry.status !== "tradingDay") return { status: "DATA_MISSING", targetDate: cursor, reason: `calendar${entry.status}` };
    tradingDays += 1;
    if (tradingDays === offset) return { status: "TARGET", targetDate: cursor, entry };
    cursor = nextDate(cursor);
  }
  if (coverageAsOfDate >= cursor) return { status: "DATA_MISSING", targetDate: cursor, reason: "calendarCoverageIncomplete" };
  return { status: "PENDING", targetDate: null, reason: "futureTradingDayNotYetChecked" };
}

function ledgerIndex(ledger) {
  return new Map((ledger?.records ?? []).map((record) => [normalizeStockCode(record.code), record]).filter(([code]) => code));
}

function historicalOneDayCoverage(ledger, sourceSnapshotHash, code) {
  if (!ledger || ledger.sourceSnapshotHash !== sourceSnapshotHash) return null;
  const record = ledger.records?.find((item) => item.ticker === code);
  if (!record) return { horizon: "1D", targetDate: ledger.targetTradingDate, status: "DATA_MISSING", reason: "symbolPriceMissing", calendarStatus: "observedByHistoricalOutcomeLedger", priceLedgerStatus: "created", modelSnapshotStatus: null };
  return { horizon: "1D", targetDate: ledger.targetTradingDate, status: record.status, reason: record.reason, calendarStatus: "observedByHistoricalOutcomeLedger", priceLedgerStatus: "created", modelSnapshotStatus: null };
}

function horizonCoverage({ horizon, calendar, signalDate, sourceSnapshotHash, historicalOneDayLedger, coverageAsOfDate, sourceLedger, targetLedgerByDate, snapshotsByDate, code }) {
  if (horizon.offset === 1) {
    const historical = historicalOneDayCoverage(historicalOneDayLedger, sourceSnapshotHash, code);
    if (historical) return historical;
  }
  const target = locateCoverageTarget(calendar, signalDate, horizon.offset, coverageAsOfDate);
  const base = { horizon: `${horizon.offset}D`, targetDate: target.targetDate, status: target.status, reason: target.reason ?? null, calendarStatus: target.entry?.status ?? null, priceLedgerStatus: target.entry?.marketPriceLedger ?? null, modelSnapshotStatus: target.entry?.modelSnapshot ?? null };
  if (target.status !== "TARGET") return base;
  const sourceRecord = sourceLedger?.get(code);
  if (!sourceRecord || !isValidClose(sourceRecord.closePrice)) return { ...base, status: "DATA_MISSING", reason: "signalCloseUnavailable" };
  if (target.entry?.marketPriceLedger !== "created") return { ...base, status: "DATA_MISSING", reason: "priceLedgerMissing" };
  if (target.entry?.modelSnapshot !== "created" || !snapshotsByDate.has(target.targetDate)) return { ...base, status: "DATA_MISSING", reason: "targetSnapshotMissing" };
  const targetLedger = targetLedgerByDate.get(target.targetDate);
  if (!targetLedger) return { ...base, status: "DATA_MISSING", reason: "priceLedgerMissing" };
  const targetRecord = targetLedger.get(code);
  if (!targetRecord) return { ...base, status: "DATA_MISSING", reason: "symbolPriceMissing" };
  if (!isValidClose(targetRecord.closePrice)) return { ...base, status: "DATA_MISSING", reason: targetRecord.executable === false ? "symbolNotExecutable" : "targetCloseUnavailable" };
  return { ...base, status: "MATURE", reason: null };
}

export function reconcileOutcomeCoverage({ snapshots, marketPriceLedgers, tradingCalendar, coverageAsOfDate, calendarEvidence = null, historicalOneDayPriceLedgers = [] }) {
  if (!isValidDate(coverageAsOfDate)) throw new Error("coverageAsOfDate가 YYYY-MM-DD 형식이어야 합니다.");
  const effectiveCalendar = calendarEvidence ? mergeCalendarEvidence(tradingCalendar, calendarEvidence) : tradingCalendar;
  const snapshotsByDate = new Map(snapshots.map((snapshot) => [snapshot.asOfDate, snapshot]));
  const ledgersByDate = new Map(marketPriceLedgers.map((ledger) => [ledger.date, ledgerIndex(ledger)]));
  const historicalOneDayBySignalDate = new Map(historicalOneDayPriceLedgers.map((ledger) => [ledger.signalDate, ledger]));
  const artifacts = [...snapshots].sort((a, b) => a.asOfDate.localeCompare(b.asOfDate)).map((snapshot) => {
    const signalDate = snapshot.asOfDate;
    const sourceSnapshotHash = snapshot.contentHash ?? sha256Canonical(snapshot);
    const sourceLedger = ledgersByDate.get(signalDate);
    const records = [...snapshot.records].map((record) => {
      const ticker = normalizeStockCode(record.code);
      const sourceRecord = sourceLedger?.get(ticker);
      const horizons = Object.fromEntries(FUTURE_RETURN_HORIZONS.map((horizon) => [
        `${horizon.offset}D`, horizonCoverage({ horizon, calendar: effectiveCalendar, signalDate, sourceSnapshotHash, historicalOneDayLedger: historicalOneDayBySignalDate.get(signalDate), coverageAsOfDate, sourceLedger, targetLedgerByDate: ledgersByDate, snapshotsByDate, code: ticker }),
      ]));
      return {
        ticker,
        sourcePrice: { ledgerPresent: Boolean(sourceLedger), closeAvailable: isValidClose(sourceRecord?.closePrice), executable: sourceRecord?.executable ?? null },
        horizons,
      };
    }).sort((left, right) => left.ticker.localeCompare(right.ticker));
    const counts = Object.fromEntries(FUTURE_RETURN_HORIZONS.map((horizon) => {
      const key = `${horizon.offset}D`;
      return [key, Object.fromEntries(OUTCOME_COVERAGE_STATUSES.map((status) => [status, records.filter((record) => record.horizons[key].status === status).length]))];
    }));
    const base = {
      schemaVersion: OUTCOME_COVERAGE_SCHEMA_VERSION,
      dataset: "daily-outcome-coverage",
      signalDate,
      coverageAsOfDate,
      sourceSnapshotHash,
      trackingUniverse: { count: records.length, codesHash: sha256Canonical(records.map((record) => record.ticker)) },
      calendarMaximumCheckedDate: Object.keys(effectiveCalendar?.dates ?? {}).sort().at(-1) ?? null,
      calendarEvidence: calendarEvidence ? { contentHash: calendarEvidence.contentHash, derivedDateCount: Object.keys(calendarEvidence.entries ?? {}).length } : null,
      counts,
      records,
    };
    return { ...base, contentHash: sha256Canonical(base) };
  });
  return { artifacts, summary: { signalDates: artifacts.length, coverageAsOfDate } };
}

async function loadJsonDirectory(directory) {
  try {
    const names = (await fs.readdir(directory)).filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/u.test(name)).sort();
    return Promise.all(names.map((name) => fs.readFile(path.join(directory, name), "utf8").then(JSON.parse)));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

export async function writeOutcomeCoverageArtifacts({ root = process.cwd(), coverageAsOfDate }) {
  const [snapshots, marketPriceLedgers, tradingCalendar, historicalOneDayPriceLedgers] = await Promise.all([
    loadJsonDirectory(path.join(root, "data", "history")),
    loadJsonDirectory(path.join(root, "data", "market-prices")),
    fs.readFile(path.join(root, "data", "trading-calendar", "status.json"), "utf8").then(JSON.parse),
    loadJsonDirectory(path.join(root, "data", "historical-outcome-prices")),
  ]);
  const calendarEvidence = createHistoricalOutcomeCalendarEvidence({ snapshots, marketPriceLedgers, tradingCalendar });
  const result = reconcileOutcomeCoverage({ snapshots, marketPriceLedgers, tradingCalendar, coverageAsOfDate, calendarEvidence, historicalOneDayPriceLedgers });
  const directory = path.join(root, "data", "outcome-coverage");
  await fs.mkdir(directory, { recursive: true });
  const changedPaths = [];
  const evidencePath = path.join(directory, "calendar-evidence.json");
  const evidenceContent = `${JSON.stringify(calendarEvidence, null, 2)}\n`;
  let currentEvidence = null;
  try { currentEvidence = await fs.readFile(evidencePath, "utf8"); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  if (currentEvidence !== evidenceContent) {
    await fs.writeFile(evidencePath, evidenceContent, "utf8");
    changedPaths.push("data/outcome-coverage/calendar-evidence.json");
  }
  for (const artifact of result.artifacts) {
    const target = path.join(directory, `${artifact.signalDate}.json`);
    let existing = null;
    try { existing = JSON.parse(await fs.readFile(target, "utf8")); } catch (error) { if (error?.code !== "ENOENT") throw error; }
    if (existing?.contentHash === artifact.contentHash) continue;
    await fs.writeFile(target, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
    changedPaths.push(`data/outcome-coverage/${artifact.signalDate}.json`);
  }
  return { ...result, calendarEvidence, changedPaths };
}
