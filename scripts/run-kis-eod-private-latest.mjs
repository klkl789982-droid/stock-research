import path from "node:path";
import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { getKisEodLocalClock } from "./run-kis-eod.mjs";
import { runPrivateKisModels } from "./run-kis-eod-private-models.mjs";
import { createPrivateProvider } from "./observe-kis-eod.mjs";
import { auditKisEodPrivate } from "./audit-kis-eod-private.mjs";
import { buildPrivateResearchReplay } from "./replay-kis-eod-private-models.mjs";
import { kisEodPrivateStoreFromEnv } from "../lib/kis-eod-private-store.mjs";
import { queryLatestPrivateModelTop, persistPrivateModelBundle, recordPrivateModelOperation } from "../lib/kis-eod-private-models.mjs";

const fail = (code) => { throw Object.assign(new Error(code), { code }); };
// A bounded exact-calendar search. Never falls back from unavailable TODAY bars
// to yesterday. A candidate still needs Y/Y. Official KIS samples explicitly
// define opnd_yn as the orderable/open day: N/Y is NOT an open session, so it may
// be skipped in THIS private lookback only. Provider/Daily/LIVE rules stay intact.
export async function selectLatestClosedKisDate(provider, now = () => new Date()) {
  const instant = new Date(now()), local = getKisEodLocalClock(instant);
  if (local.time < "15:30:00") return { status: "PENDING", reason: "BEFORE_MARKET_CLOSE" };
  for (let offset = 0; offset < 15; offset += 1) {
    const date = new Date(`${local.referenceDate}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() - offset);
    const referenceDate = date.toISOString().slice(0, 10);
    const calendar = await provider.getTradingDay(referenceDate), fields = calendar?.sourceFields;
    if (calendar?.source !== "KIS" || calendar.operation !== "chk-holiday" || calendar.referenceDate !== referenceDate
      || fields?.bass_dt !== referenceDate.replaceAll("-", "") || !Number.isFinite(Date.parse(calendar.receivedAt))
      || Date.parse(calendar.receivedAt) > new Date(now()).getTime()) fail("KIS_LATEST_CALENDAR_INVALID");
    if (calendar.isTradingDay === true && fields.opnd_yn === "Y" && fields.tr_day_yn === "Y") return { status: "READY", referenceDate, calendar };
    if (!(fields.opnd_yn === "N" && ["Y", "N"].includes(fields.tr_day_yn))) return { status: "PENDING", reason: "CALENDAR_UNKNOWN" };
  }
  return { status: "PENDING", reason: "LATEST_TRADING_DAY_NOT_FOUND" };
}

export async function runPrivateLatest({ root = process.cwd(), now = () => new Date(), collectPrivate = false,
  enabled = process.env.KIS_EOD_COLLECTION_ENABLED, store = null, provider = null,
  runCurrent = runPrivateKisModels, audit = auditKisEodPrivate, replay = buildPrivateResearchReplay,
  onProgress = () => {}, runId = randomUUID() } = {}) {
  if (!collectPrivate) return runCurrent({ root, now, collectPrivate: false });
  if (enabled !== "true") return { status: "BLOCKED", reason: "COLLECTION_NOT_ENABLED" };
  if (getKisEodLocalClock(now()).time < "15:30:00") return { status: "PENDING", reason: "BEFORE_MARKET_CLOSE" };
  const privateStore = store ?? kisEodPrivateStoreFromEnv();
  let referenceDate = getKisEodLocalClock(now()).referenceDate, mode = "live", result;
  try {
    await privateStore.preflight();
    const source = provider ?? createPrivateProvider(now, []);
    const selected = await selectLatestClosedKisDate(source, now);
    if (selected.status !== "READY") result = selected;
    else {
      referenceDate = selected.referenceDate;
      mode = referenceDate === getKisEodLocalClock(now()).referenceDate ? "live" : "research";
      const latest = await queryLatestPrivateModelTop(privateStore);
      if (latest.referenceDate > referenceDate) fail("PRIVATE_LATEST_FUTURE_HEAD");
      if (latest.referenceDate === referenceDate && mode === "research") result = { status: "ALREADY_STORED", reason: "LATEST_DATE_ALREADY_STORED" };
      else if (mode === "live") result = await runCurrent({ root, now, collectPrivate: true, enabled: "true", store: privateStore, runId, collectorOptions: { provider: source } });
      else {
        // Reuse the existing strict historical audit, retaining ACTUAL receipt
        // times. No current-date quality rule or LIVE artifact is weakened.
        const collected = await audit({ root, referenceDate, now, collectPrivate: true, provider: source, onProgress });
        if (!collected.privateReportPath || collected.unattemptedCount || collected.attemptedCount !== collected.requestedCount
          || collected.failures.some((failure) => !/^[0-9A-Z]{6}$/u.test(failure.code))) fail("PRIVATE_LATEST_COLLECTION_INCOMPLETE");
        const directory = path.resolve(root, collected.privateReportPath, "..", "..", "..");
        const bundle = await replay({ root, directory });
        if (bundle.research.referenceDate !== referenceDate) fail("PRIVATE_LATEST_DATE_MISMATCH");
        result = { ...await persistPrivateModelBundle({ store: privateStore, ...bundle, mode: "research", runId }),
          reason: "PRIVATE_MODEL_HEAD_VERIFIED", requestedCount: collected.requestedCount, collectedCount: collected.collectedCount,
          failedCount: collected.failedCount, quarantineCount: collected.quarantineCount, rankingCounts: bundle.summary.rankingCounts };
      }
    }
  } catch (error) {
    result = { status: "FAILED", reason: /^(?:PRIVATE|KIS)_[A-Z0-9_]{1,70}$/u.test(error?.code ?? "") ? error.code : "PRIVATE_LATEST_COLLECTION_FAILED" };
  }
  try { await recordPrivateModelOperation(privateStore, { mode, status: result.status, reason: result.reason,
    checkedAt: new Date(now()).toISOString(), referenceDate, runId }); }
  catch { return { status: "FAILED", reason: "PRIVATE_OPERATION_RECORD_FAILED", previousHeadPreserved: true }; }
  return { ...result, referenceDate, storageMode: mode, publicationEligible: false, productionChanged: false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.length !== 1 || !["--dry-run", "--collect-private"].includes(args[0])) { console.log('KIS_PRIVATE_LATEST_JSON={"status":"BLOCKED","reason":"INVALID_CLI_ARGUMENTS"}'); process.exitCode = 1; }
  else {
    const result = await runPrivateLatest({ collectPrivate: args[0] === "--collect-private",
      onProgress: (progress) => console.log(`KIS_PRIVATE_PROGRESS=${JSON.stringify(progress)}`) });
    console.log(`KIS_PRIVATE_LATEST_JSON=${JSON.stringify(result)}`);
    if (process.env.GITHUB_ACTIONS === "true" && process.env.GITHUB_OUTPUT) await fs.appendFile(process.env.GITHUB_OUTPUT,
      `stored=${["PRIVATE_STORED_AND_VERIFIED", "ALREADY_STORED"].includes(result.status)}\nreference_date=${/^\d{4}-\d{2}-\d{2}$/u.test(result.referenceDate ?? "") ? result.referenceDate : ""}\n`);
    if (["FAILED", "BLOCKED"].includes(result.status)) process.exitCode = 1;
  }
}
