import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { verifyKisEodPrivateStorage } from "./verify-kis-eod-private-storage.mjs";
import { createPrivateProvider } from "./observe-kis-eod.mjs";
import { loadKisEodInputs, getKisEodLocalClock } from "./run-kis-eod.mjs";
import { KIS_EOD_OBSERVATION_TICKERS, KIS_EOD_OBSERVATION_SLOTS } from "../lib/kis-eod-observation.mjs";
import { validateKisEodInputHistory } from "../lib/kis-eod-pipeline.mjs";
import { kisEodPrivateStoreFromEnv } from "../lib/kis-eod-private-store.mjs";
import { storePrivateModelBlob, readPrivateModelBlob } from "../lib/kis-eod-private-models.mjs";
import { sha256Canonical } from "../lib/snapshot-quality-pipeline.mjs";

export async function preflightPrivateIntegration({ root = process.cwd(), env = process.env, now = () => new Date(),
  verifyStorage = verifyKisEodPrivateStorage, loadInputs = loadKisEodInputs, provider = null, store = null } = {}) {
  if (!env.KIS_APP_KEY || !env.KIS_APP_SECRET) throw Object.assign(new Error("KIS_CREDENTIALS_UNAVAILABLE"), { code: "KIS_CREDENTIALS_UNAVAILABLE" });
  const storage = await verifyStorage({ env });
  const local = getKisEodLocalClock(now()), inputs = await loadInputs({ root, referenceDate: local.referenceDate });
  const baselineDate = inputs.officialSnapshot.asOfDate;
  if (baselineDate > local.referenceDate) throw new Error("PREFLIGHT_FUTURE_BASELINE");
  const source = provider ?? createPrivateProvider(now, []), calendar = await source.getTradingDay(baselineDate);
  if (calendar?.isTradingDay !== true || calendar.referenceDate !== baselineDate || calendar.sourceFields?.bass_dt !== baselineDate.replaceAll("-", "")
    || calendar.sourceFields.opnd_yn !== "Y" || calendar.sourceFields.tr_day_yn !== "Y") throw Object.assign(new Error("KIS_CALENDAR_NOT_VERIFIED"), { code: "KIS_CALENDAR_NOT_VERIFIED" });
  // Three actual one-bar reads validate ticker/date/field/auth bindings. These
  // are NOT designated-slot observations, never uploaded or backdated as such.
  let quoteCount = 0;
  for (const ticker of KIS_EOD_OBSERVATION_TICKERS) {
    const history = await source.getHistory(ticker, baselineDate, { requiredRows: 1, maxPages: 1 });
    if (validateKisEodInputHistory(history.rows, baselineDate, history, "unadjusted") || history.symbolMapping?.status !== "VERIFIED_RESPONSE_TICKER"
      || history.symbolMapping.requestedCode !== ticker || history.symbolMapping.responseCode !== ticker
      || !Number.isFinite(Date.parse(history.requestedAt)) || !Number.isFinite(Date.parse(history.receivedAt))
      || Date.parse(history.requestedAt) > Date.parse(history.receivedAt) || Date.parse(history.receivedAt) > new Date(now()).getTime()) throw Object.assign(new Error("KIS_THREE_SYMBOL_PREFLIGHT_FAILED"), { code: "KIS_THREE_SYMBOL_PREFLIGHT_FAILED" });
    quoteCount += 1;
  }
  const privateStore = store ?? kisEodPrivateStoreFromEnv(env);
  const fixture = { namespace: "kis-private-model-integration-test", fixtureOnly: true, sourcePricesIncluded: false,
    note: "NO_MARKET_DATA_NO_SCORES_NO_LIVE_HEAD", runId: env.GITHUB_RUN_ID, attempt: env.GITHUB_RUN_ATTEMPT };
  const descriptor = await storePrivateModelBlob(privateStore, "model-top/fixture", fixture);
  if (sha256Canonical(await readPrivateModelBlob(privateStore, "model-top/fixture", descriptor)) !== descriptor.identity) throw new Error("PREFLIGHT_HASH_MISMATCH");
  const proof = { namespace: "kis-private-observation-activation-preflight", status: "READY", checkedAt: new Date(now()).toISOString(),
    mainCommit: /^[a-f0-9]{40}$/u.test(env.GITHUB_SHA ?? "") ? env.GITHUB_SHA : null,
    storage: storage.status, storageHash: storage.sha256, calendar: "EXACT_BASELINE_TRADING_DAY_VERIFIED",
    baselineDate, quoteCount, slots: [...KIS_EOD_OBSERVATION_SLOTS], tickers: [...KIS_EOD_OBSERVATION_TICKERS],
    modelBlobReadHash: descriptor.identity, sourcePricesIncluded: false, designatedSlotObservationsCreated: 0,
    fullCollectionEnabled: false, publicPublicationEnabled: false };
  await privateStore.writeImmutable(`preflight/activation/${sha256Canonical(proof)}.json`, proof);
  return proof;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  let result;
  try { if (process.argv.length !== 2) throw new Error("INVALID_CLI_ARGUMENTS"); result = await preflightPrivateIntegration(); }
  catch (error) {
    const reasons = new Set(["KIS_CREDENTIALS_UNAVAILABLE", "PRIVATE_STORE_TOKEN_UNAVAILABLE", "PRIVATE_STORE_AUTHORIZATION_FAILED", "KIS_CALENDAR_NOT_VERIFIED", "KIS_THREE_SYMBOL_PREFLIGHT_FAILED"]);
    result = { status: "FAILED", reason: reasons.has(error?.code) ? error.code : "PRIVATE_INTEGRATION_PREFLIGHT_FAILED", sourcePricesIncluded: false };
    process.exitCode = 1;
  }
  console.log(`KIS_PRIVATE_INTEGRATION_JSON=${JSON.stringify(result)}`);
  if (process.env.GITHUB_STEP_SUMMARY) await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, `Private integration preflight: ${result.status}; actual private storage + KIS calendar + three symbol reads; no raw prices uploaded, no slot observations created.\n`);
}
