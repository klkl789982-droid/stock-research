import path from "node:path";
import { pathToFileURL } from "node:url";
import { createKisTokenManager } from "../lib/kis-token-manager-core.mjs";
import { createKisApiClient } from "../lib/kis-api-client-core.mjs";
import { createKisEodProvider } from "../lib/kis-eod-provider.mjs";
import { getKisEodLocalClock } from "./run-kis-eod.mjs";
import { collectKisEodObservation, sanitizeKisEodObservationEvent, KIS_EOD_OBSERVATION_SLOTS, KIS_EOD_OBSERVATION_TICKERS } from "../lib/kis-eod-observation.mjs";

const waitDefault = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const instant = (now) => {
  const result = new Date(typeof now === "function" ? now() : now);
  if (!Number.isFinite(result.getTime())) throw new Error("KIS_EOD_OBSERVATION_CLOCK_INVALID");
  return result;
};
const outcome = (status, reason, detail = {}) => ({ status, reason, sourceFinality: "NOT_CONFIRMED", publicationEligible: false, productionChanged: false, ...detail });

function createPrivateProvider(now, telemetry) {
  const getCredentials = () => ({ appKey: process.env.KIS_APP_KEY, appSecret: process.env.KIS_APP_SECRET });
  const fetchImpl = (input, init = {}) => fetch(input, { ...init, redirect: "error", signal: init.signal ?? AbortSignal.timeout(15_000) });
  const tokenManager = createKisTokenManager({ fetchImpl, getCredentials, now: () => instant(now).getTime() });
  const client = createKisApiClient({ fetchImpl, tokenManager, getCredentials });
  return createKisEodProvider({ client, now: () => instant(now).getTime(), delayMs: 350, maxAttempts: 3, timeoutMs: 15_000,
    logger: (event) => { const safe = sanitizeKisEodObservationEvent(event); if (safe) telemetry.push(safe); } });
}

export async function runKisEodObservations({ root = process.cwd(), now = () => new Date(), wait = waitDefault, provider = null, telemetry = [],
  collectPrivate = false, observationEnabled = process.env.KIS_EOD_OBSERVATION_ENABLED, slot = null, waitForSlots = false, onResult = () => {} } = {}) {
  const started = instant(now), local = getKisEodLocalClock(started);
  if ((slot !== null && !KIS_EOD_OBSERVATION_SLOTS.includes(slot)) || (slot !== null && waitForSlots)) return [outcome("BLOCKED", "INVALID_SLOT")];
  if (!collectPrivate) return [outcome("DRY_RUN_READY", "PLAN_ONLY", { referenceDate: local.referenceDate, checkedAt: started.toISOString(), timezone: "Asia/Seoul",
    tickers: [...KIS_EOD_OBSERVATION_TICKERS], slots: [...KIS_EOD_OBSERVATION_SLOTS], startWindowMinutes: 5, observationEnabled: false, networkRequests: 0, filesWritten: 0 })];
  if (observationEnabled !== "true") return [outcome("BLOCKED", "OBSERVATION_NOT_ENABLED")];
  if (local.weekend) return [outcome("PENDING", "WEEKEND", { referenceDate: local.referenceDate, checkedAt: started.toISOString() })];
  const slots = slot ? [slot] : KIS_EOD_OBSERVATION_SLOTS;
  if (waitForSlots && new Date(`${local.referenceDate}T${slots[0]}:00+09:00`).getTime() - started.getTime() > 30 * 60_000)
    return [outcome("PENDING", "BEFORE_MARKET_CLOSE", { referenceDate: local.referenceDate, checkedAt: started.toISOString(), maximumPrewarmMinutes: 30 })];
  const source = provider ?? createPrivateProvider(now, telemetry), results = [];
  for (const target of slots) {
    if (waitForSlots) {
      const plannedAt = new Date(`${local.referenceDate}T${target}:00+09:00`).getTime();
      // This waits for real clock progress. No generated future instant is ever
      // passed into the provider or represented as a source observation.
      while (instant(now).getTime() < plannedAt) {
        if (getKisEodLocalClock(instant(now)).referenceDate !== local.referenceDate) break;
        await wait(Math.min(30_000, plannedAt - instant(now).getTime()));
      }
    }
    const current = instant(now);
    const result = getKisEodLocalClock(current).referenceDate !== local.referenceDate
      ? outcome("PENDING", "REFERENCE_DATE_CHANGED", { referenceDate: local.referenceDate, slot: target, checkedAt: current.toISOString() })
      : await collectKisEodObservation({ root, slot: target, now, provider: source, telemetry });
    results.push(result); await onResult(result);
  }
  return results;
}

export function parseKisEodObservationArgs(args) {
  const accepted = new Set(["--dry-run", "--collect-private", "--wait-for-slots", ...KIS_EOD_OBSERVATION_SLOTS.map((slot) => `--slot=${slot}`)]);
  if (args.some((arg) => !accepted.has(arg)) || new Set(args).size !== args.length || args.filter((arg) => arg.startsWith("--slot=")).length > 1
    || (args.includes("--dry-run") && args.includes("--collect-private")) || (args.includes("--wait-for-slots") && args.some((arg) => arg.startsWith("--slot="))))
    return null;
  return { collectPrivate: args.includes("--collect-private"), waitForSlots: args.includes("--wait-for-slots"), slot: args.find((arg) => arg.startsWith("--slot="))?.slice(7) ?? null };
}

async function cli() {
  const options = parseKisEodObservationArgs(process.argv.slice(2));
  let results, emitted = 0;
  if (!options) results = [outcome("BLOCKED", "INVALID_CLI_ARGUMENTS")];
  else {
    try { results = await runKisEodObservations({ ...options, onResult: (result) => { emitted += 1; console.log(`KIS_EOD_OBSERVATION_JSON=${JSON.stringify(result)}`); } }); }
    catch { results = [outcome("FAILED", "UNEXPECTED_FAILURE")]; }
  }
  // Each collected slot is reported immediately. Planning/gating returns before
  // onResult, so those read-only outcomes are printed here.
  if (emitted === 0) for (const result of results) console.log(`KIS_EOD_OBSERVATION_JSON=${JSON.stringify(result)}`);
  if (results.some((result) => ["FAILED", "PARTIAL", "BLOCKED"].includes(result.status))) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await cli();
