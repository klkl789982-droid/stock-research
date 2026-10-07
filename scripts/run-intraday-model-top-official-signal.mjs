import fs from "node:fs/promises";
import path from "node:path";
import { createKisApiClient } from "../lib/kis-api-client-core.mjs";
import { createKisTokenManager } from "../lib/kis-token-manager-core.mjs";
import { attachKisMinuteObservation, parseKisQuote } from "../lib/kis-quote-provider-core.mjs";
import { collectKisQuotes } from "../lib/kis-intraday-collector.mjs";
import { validateIntradayMarketSeed } from "../lib/intraday-market-seed.mjs";
import { buildIntradayModelTopSignal, calculateIntradayModelTopScores, OFFICIAL_SIGNAL_TIME, validateIntradayModelTopSignal } from "../lib/intraday-model-top-official-signal.mjs";
import { mergeProvisionalCandle } from "../lib/intraday-model-b-official-signal.mjs";
import { classifyOfficialSignalWindow, millisecondsUntilKstTime } from "../lib/intraday-model-top-time-policy.mjs";

const root = process.cwd();
const statusDir = path.join(root, "data", "intraday-signals", "model-top");
const kst = (date = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(date).reduce((out, part) => ({ ...out, [part.type]: part.value }), {});
const formatDate = (parts) => `${parts.year}-${parts.month}-${parts.day}`;
const writeLatest = async (value) => {
  await fs.mkdir(statusDir, { recursive: true });
  const target = path.join(statusDir, "latest.json");
  const temporary = `${target}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  await fs.rename(temporary, target);
};
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function main() {
  const now = new Date();
  const parts = kst(now);
  const today = formatDate(parts);
  const signalDate = process.argv.find((value) => value.startsWith("--signal-date="))?.slice(14) ?? today;
  const dryRun = process.argv.includes("--dry-run");
  const preflight = process.argv.includes("--preflight");
  const waitForWindow = process.argv.includes("--wait-for-window");
  if (dryRun && preflight) throw new Error("INTRADAY_MODEL_TOP_MODE_CONFLICT");
  if (signalDate !== today) throw new Error("OFFICIAL_SIGNAL_DATE_MUST_BE_TODAY");
  const signalDir = path.join(statusDir, signalDate);
  const signalPath = path.join(signalDir, "1430.json");
  if (!preflight) {
    try {
      const existing = JSON.parse(await fs.readFile(signalPath, "utf8"));
      const errors = validateIntradayModelTopSignal(existing);
      if (errors.length || existing.status !== "READY") throw new Error(`EXISTING_OFFICIAL_SIGNAL_INVALID:${errors.join(",")}`);
      console.log(`INTRADAY_MODEL_TOP_RESULT_JSON=${JSON.stringify({ status: "READY", signalDate, disposition: "existing", signalPath: path.relative(root, signalPath).replaceAll("\\", "/"), latestPath: "data/intraday-signals/model-top/latest.json", collection: existing.collection })}`);
      return;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  const seedDir = path.join(root, "data", "analysis", "market-seeds");
  const seedName = (await fs.readdir(seedDir)).filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/u.test(name) && name.slice(0, 10) < signalDate).sort().at(-1);
  if (!seedName) throw new Error("PRIOR_INTRADAY_SEED_MISSING");
  const seed = JSON.parse(await fs.readFile(path.join(seedDir, seedName), "utf8"));
  const seedErrors = validateIntradayMarketSeed(seed, seed.records?.length ?? 0);
  if (seedErrors.length) throw new Error(`INTRADAY_SEED_INVALID:${seedErrors.slice(0, 5).join(",")}`);
  if (seed.requestedDate >= signalDate) throw new Error("SEED_NOT_STRICTLY_PRIOR_TO_SIGNAL");
  if (dryRun) {
    console.log(`INTRADAY_MODEL_TOP_RESULT_JSON=${JSON.stringify({ status: "DRY_RUN_READY", observationType: "DRY_RUN", signalDate, seedReferenceDate: seed.requestedDate, eligibleCount: seed.records.filter((record) => record.eligible).length, liveObservationCreated: false, signalPath: null, latestPath: null })}`);
    return;
  }

  if (!preflight) {
    let currentParts = parts;
    let time = `${currentParts.hour}:${currentParts.minute}:${currentParts.second}`;
    let timing = classifyOfficialSignalWindow({ time, weekday: new Date(`${signalDate}T00:00:00+09:00`).getUTCDay() });
    if (timing === "WEEKEND") throw new Error("OFFICIAL_SIGNAL_WEEKEND");
    if (timing === "BEFORE_WINDOW" && waitForWindow) {
      const delayMs = millisecondsUntilKstTime({ date: signalDate, time: OFFICIAL_SIGNAL_TIME, nowMs: Date.now() });
      console.log(`INTRADAY_MODEL_TOP_WAITING_FOR_SIGNAL_WINDOW delayMs=${delayMs}`);
      await wait(delayMs);
      currentParts = kst(new Date());
      time = `${currentParts.hour}:${currentParts.minute}:${currentParts.second}`;
      timing = classifyOfficialSignalWindow({ time, weekday: new Date(`${signalDate}T00:00:00+09:00`).getUTCDay() });
    }
    if (timing !== "COLLECT") throw new Error("OFFICIAL_SIGNAL_OUTSIDE_COLLECTION_WINDOW");
  }

  const credentials = { appKey: process.env.KIS_APP_KEY ?? "", appSecret: process.env.KIS_APP_SECRET ?? "" };
  if (!credentials.appKey || !credentials.appSecret) throw new Error("KIS_CREDENTIALS_MISSING");
  const tokenManager = createKisTokenManager({ fetchImpl: fetch, getCredentials: () => credentials });
  const client = createKisApiClient({ fetchImpl: fetch, tokenManager, getCredentials: () => credentials });
  const fetchQuote = async (code) => {
    const observationParts = kst(new Date());
    const observationDate = formatDate(observationParts);
    const observationTime = `${observationParts.hour}${observationParts.minute}${observationParts.second}`;
    const response = await client.request(`https://openapi.koreainvestment.com:9443/uapi/domestic-stock/v1/quotations/inquire-price?FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD=${code}`, { headers: { "Content-Type": "application/json", tr_id: "FHKST01010100" } });
    if (!response.ok) throw new Error(`KIS_HTTP_${response.status}`);
    const quote = parseKisQuote(await response.json(), code, new Date().toISOString());
    const minuteResponse = await client.request(`https://openapi.koreainvestment.com:9443/uapi/domestic-stock/v1/quotations/inquire-time-itemchartprice?FID_ETC_CLS_CODE=&FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD=${code}&FID_INPUT_HOUR_1=${observationTime}&FID_PW_DATA_INCU_YN=N`, { headers: { "Content-Type": "application/json", tr_id: "FHKST03010200" } });
    if (!minuteResponse.ok) throw new Error(`KIS_MINUTE_HTTP_${minuteResponse.status}`);
    return attachKisMinuteObservation(quote, await minuteResponse.json(), { requestedDate: observationDate, requestedTime: observationTime });
  };
  const eligibleCodes = seed.records.filter((record) => record.eligible).map((record) => record.code);
  const collection = await collectKisQuotes({ codes: eligibleCodes, fetchQuote, delayMs: 150, concurrency: 2 });
  if (preflight) {
    const rowsByCode = new Map(seed.records.filter((record) => record.eligible).map((record) => [record.code, record.rows]));
    let calculated = 0;
    let calculationFailures = 0;
    let signalDateMatched = 0;
    for (const [code, quote] of collection.quotesByCode) {
      try {
        if (quote.asOfDate === signalDate) signalDateMatched += 1;
        else throw new Error("QUOTE_DATE_DOES_NOT_MATCH_PREFLIGHT_DATE");
        const rows = mergeProvisionalCandle(rowsByCode.get(code), quote);
        if (!rows) throw new Error("PROVISIONAL_CANDLE_INVALID");
        const scores = calculateIntradayModelTopScores(rows, quote).scores;
        if (!["A-v1", "B-v1", "C-v1", "D-v1"].every((modelVersion) => Number.isFinite(scores[modelVersion]))) throw new Error("MODEL_SCORE_INVALID");
        calculated += 1;
      } catch {
        calculationFailures += 1;
      }
    }
    const quoteTimes = [...collection.quotesByCode.values()].map((quote) => quote.asOfDate && quote.asOfTime ? `${quote.asOfDate}T${quote.asOfTime}` : null).filter(Boolean).sort();
    const failureSummary = Object.entries(collection.failures.reduce((counts, failure) => {
      const reason = /^(KIS_|KIS_MINUTE_|QUOTE_)/u.test(failure.reason) ? failure.reason : "quoteCollectionFailed";
      counts[reason] = (counts[reason] ?? 0) + 1;
      return counts;
    }, {})).sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])).slice(0, 3).map(([reason, count]) => ({ reason, count }));
    const preflightReady = collection.failures.length === 0 && quoteTimes.length === eligibleCodes.length && signalDateMatched === eligibleCodes.length && calculated === eligibleCodes.length && calculationFailures === 0;
    const authentication = collection.quotesByCode.size > 0 || failureSummary.some((failure) => failure.reason.startsWith("KIS_MINUTE_OBSERVATION_")) ? "verifiedByQuoteRequest" : "notVerified";
    console.log(`INTRADAY_MODEL_TOP_RESULT_JSON=${JSON.stringify({ status: preflightReady ? "PREFLIGHT_READY" : "PREFLIGHT_FAILED", observationType: "PREFLIGHT", signalDate, seedReferenceDate: seed.requestedDate, credentials: "present", authentication, collection: { requested: eligibleCodes.length, successful: collection.quotesByCode.size, failed: collection.failures.length, timestampComplete: quoteTimes.length, signalDateMatched, failureSummary }, calculations: { A_v1_B_v1_C_v1_D_v1: calculated, failed: calculationFailures }, quoteTimestampRange: { earliest: quoteTimes.at(0) ?? null, latest: quoteTimes.at(-1) ?? null }, liveObservationCreated: false, signalPath: null, latestPath: null })}`);
    if (!preflightReady) {
      process.exitCode = 1;
      return;
    }
    return;
  }
  const artifact = buildIntradayModelTopSignal({ seed, quotesByCode: collection.quotesByCode, signalDate, collectionStartedAt: collection.startedAt, collectionCompletedAt: collection.completedAt, observationType: "LIVE_OBSERVATION" });
  const validationErrors = validateIntradayModelTopSignal(artifact);
  if (validationErrors.length) throw new Error(`OFFICIAL_SIGNAL_INVALID:${validationErrors.join(",")}`);
  if (artifact.status !== "READY") throw new Error(`OFFICIAL_SIGNAL_COLLECTION_INCOMPLETE:${artifact.collection.failed}`);

  await fs.mkdir(signalDir, { recursive: true });
  await fs.writeFile(signalPath, `${JSON.stringify(artifact, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  const latest = { schemaVersion: 1, artifactType: "intradayModelTopLatestStatus", signalDate, officialSignalTime: OFFICIAL_SIGNAL_TIME, status: artifact.status, signalPath: path.relative(root, signalPath).replaceAll("\\", "/"), contentHash: artifact.contentHash, collection: artifact.collection, collectionStartedAt: artifact.collectionStartedAt, collectionCompletedAt: artifact.collectionCompletedAt, updatedAt: new Date().toISOString() };
  await writeLatest(latest);
  console.log(`INTRADAY_MODEL_TOP_RESULT_JSON=${JSON.stringify({ status: artifact.status, signalDate, disposition: "created", signalPath: latest.signalPath, latestPath: "data/intraday-signals/model-top/latest.json", collection: artifact.collection })}`);
}

await main().catch(async (error) => {
  if (process.argv.includes("--preflight") || process.argv.includes("--dry-run")) {
    const reason = error instanceof Error ? error.message.slice(0, 120) : "unknownFailure";
    console.error(`INTRADAY_MODEL_TOP_NON_OBSERVATIONAL_FAILED reason=${reason}`);
    console.log(`INTRADAY_MODEL_TOP_RESULT_JSON=${JSON.stringify({ status: process.argv.includes("--preflight") ? "PREFLIGHT_FAILED" : "DRY_RUN_FAILED", observationType: process.argv.includes("--preflight") ? "PREFLIGHT" : "DRY_RUN", liveObservationCreated: false, signalPath: null, latestPath: null, reason })}`);
    process.exitCode = 1;
    return;
  }
  const now = new Date();
  const date = formatDate(kst(now));
  const reason = error instanceof Error ? error.message.slice(0, 120) : "unknownFailure";
  await writeLatest({ schemaVersion: 1, artifactType: "intradayModelTopLatestStatus", signalDate: date, officialSignalTime: OFFICIAL_SIGNAL_TIME, status: "FAILED", reason, updatedAt: now.toISOString() });
  console.error(`INTRADAY_MODEL_TOP_FAILED reason=${reason}`);
  console.log(`INTRADAY_MODEL_TOP_RESULT_JSON=${JSON.stringify({ status: "FAILED", signalDate: date, latestPath: "data/intraday-signals/model-top/latest.json", reason })}`);
  process.exitCode = 1;
});
