import path from "node:path";
import { pathToFileURL } from "node:url";
import { createKisTokenManager } from "../lib/kis-token-manager-core.mjs";
import { createKisApiClient } from "../lib/kis-api-client-core.mjs";
import { createKisEodProvider } from "../lib/kis-eod-provider.mjs";
import { getKisEodLocalClock } from "./run-kis-eod.mjs";
import { collectKisEodObservation, restoreKisEodObservationEvidence, sanitizeKisEodObservationEvent, KIS_EOD_OBSERVATION_SLOTS, KIS_EOD_OBSERVATION_TICKERS } from "../lib/kis-eod-observation.mjs";
import { kisEodPrivateStoreFromEnv } from "../lib/kis-eod-private-store.mjs";
import { randomUUID } from "node:crypto";

const waitDefault = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const instant = (now) => {
  const result = new Date(typeof now === "function" ? now() : now);
  if (!Number.isFinite(result.getTime())) throw new Error("KIS_EOD_OBSERVATION_CLOCK_INVALID");
  return result;
};
const outcome = (status, reason, detail = {}) => ({ status, reason, sourceFinality: "NOT_CONFIRMED", publicationEligible: false, productionChanged: false, ...detail });

export function createPrivateProvider(now, telemetry) {
  const getCredentials = () => ({ appKey: process.env.KIS_APP_KEY, appSecret: process.env.KIS_APP_SECRET });
  const fetchImpl = (input, init = {}) => fetch(input, { ...init, redirect: "error", signal: init.signal ?? AbortSignal.timeout(15_000) });
  const tokenManager = createKisTokenManager({ fetchImpl, getCredentials, now: () => instant(now).getTime() });
  const client = createKisApiClient({ fetchImpl, tokenManager, getCredentials });
  return createKisEodProvider({ client, now: () => instant(now).getTime(), delayMs: 350, maxAttempts: 3, timeoutMs: 15_000,
    logger: (event) => { const safe = sanitizeKisEodObservationEvent(event); if (safe) telemetry.push(safe); } });
}

export async function runKisEodObservations({ root = process.cwd(), now = () => new Date(), wait = waitDefault, provider = null, telemetry = [],
  collectPrivate = false, observationEnabled = process.env.KIS_EOD_OBSERVATION_ENABLED, slot = null, waitForSlots = false, onResult = () => {},
  durableStore = null } = {}) {
  const started = instant(now), local = getKisEodLocalClock(started);
  if ((slot !== null && !KIS_EOD_OBSERVATION_SLOTS.includes(slot)) || (slot !== null && waitForSlots)) return [outcome("BLOCKED", "INVALID_SLOT")];
  if (!collectPrivate) return [outcome("DRY_RUN_READY", "PLAN_ONLY", { referenceDate: local.referenceDate, checkedAt: started.toISOString(), timezone: "Asia/Seoul",
    tickers: [...KIS_EOD_OBSERVATION_TICKERS], slots: [...KIS_EOD_OBSERVATION_SLOTS], startWindowMinutes: 5, observationEnabled: false, networkRequests: 0, filesWritten: 0 })];
  if (observationEnabled !== "true") return [outcome("BLOCKED", "OBSERVATION_NOT_ENABLED")];
  let store = durableStore;
  try { store ??= kisEodPrivateStoreFromEnv(process.env, { now, wait }); }
  catch { return [outcome("BLOCKED", "PRIVATE_STORE_NOT_CONFIGURED")]; }
  try { await store.preflight(); }
  catch { return [outcome("BLOCKED", "PRIVATE_STORE_PREFLIGHT_FAILED")]; }
  if (local.weekend) return [outcome("PENDING", "WEEKEND", { referenceDate: local.referenceDate, checkedAt: started.toISOString() })];
  const slots = slot ? [slot] : KIS_EOD_OBSERVATION_SLOTS;
  if (waitForSlots && new Date(`${local.referenceDate}T${slots[0]}:00+09:00`).getTime() - started.getTime() > 30 * 60_000)
    return [outcome("PENDING", "BEFORE_MARKET_CLOSE", { referenceDate: local.referenceDate, checkedAt: started.toISOString(), maximumPrewarmMinutes: 30 })];
  const source = provider ?? createPrivateProvider(now, telemetry), results = [], runId = randomUUID();
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
      : await collectKisEodObservation({ root, slot: target, now, provider: source, telemetry, durableStore: store, ownerId: runId,
        executionStartedAt: started.toISOString(), runnerBootstrapStartedAt: process.env.KIS_EOD_RUNNER_BOOTSTRAP_AT ?? null });
    // Persist even a missed/failed slot without manufacturing source prices.
    // Absence of a scheduled job is detected separately by the reconciliation
    // command; this path records only a runner that actually started.
    try { await store.recordOutcome(result, runId); }
    catch { result.status = "FAILED"; result.reason = "PRIVATE_STORAGE_FAILED"; }
    results.push(result); await onResult(result);
  }
  // Audit AFTER all current slots: slow/malformed old official evidence must
  // not steal today's observation window. A missing trigger is detected by
  // the next actually-started runner, never retrospectively price-backfilled.
  if (waitForSlots && typeof store.auditDay === "function") {
    for (let offset = 1; offset <= 7; offset += 1) {
      const day = new Date(`${local.referenceDate}T00:00:00Z`); day.setUTCDate(day.getUTCDate() - offset);
      if ([0, 6].includes(day.getUTCDay())) continue;
      const referenceDate = day.toISOString().slice(0, 10);
      let calendar = null;
      try { calendar = await source.getTradingDay(referenceDate); } catch { /* audit records CALENDAR_UNKNOWN */ }
      try {
        await store.auditDay(referenceDate, calendar, instant(now).toISOString());
        if (typeof store.listJournal === "function") await restoreKisEodObservationEvidence({ root, referenceDate, durableStore: store });
      } catch {
        const result = outcome("FAILED", "PRIVATE_RETENTION_AUDIT_FAILED", { referenceDate, checkedAt: instant(now).toISOString() });
        results.push(result); await onResult(result); break;
      }
      if (typeof store.listJournal === "function") {
        try {
          const { runKisEodObservationComparison } = await import("./compare-kis-eod-observations.mjs");
          await runKisEodObservationComparison({ root, referenceDate, now, durableStore: store });
        } catch {
          const result = outcome("FAILED", "PRIVATE_COMPARISON_FAILED", { referenceDate, checkedAt: instant(now).toISOString() });
          results.push(result); await onResult(result);
        }
      }
    }
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
  if (process.argv.slice(2).length === 1 && process.argv[2] === "--storage-preflight") {
    try {
      const result = await kisEodPrivateStoreFromEnv().preflight();
      console.log(`KIS_EOD_OBSERVATION_JSON=${JSON.stringify(outcome("READY", "PRIVATE_STORE_VERIFIED", { verificationStatus: result.status, contentHash: result.contentHash, sourcePricesIncluded: false }))}`);
    } catch (error) {
      console.log(`KIS_EOD_OBSERVATION_JSON=${JSON.stringify(outcome("BLOCKED", error?.code === "PRIVATE_STORE_NOT_CONFIGURED" ? "PRIVATE_STORE_NOT_CONFIGURED" : "PRIVATE_STORE_PREFLIGHT_FAILED"))}`);
      process.exitCode = 1;
    }
    return;
  }
  const options = parseKisEodObservationArgs(process.argv.slice(2));
  let results, emitted = 0;
  if (!options) results = [outcome("BLOCKED", "INVALID_CLI_ARGUMENTS")];
  else {
    try { results = await runKisEodObservations({ ...options, onResult: (result) => { emitted += 1; console.log(`KIS_EOD_OBSERVATION_JSON=${JSON.stringify(result)}`); } }); }
    catch {
      results = [outcome("FAILED", "UNEXPECTED_FAILURE")];
      if (emitted) { console.log(`KIS_EOD_OBSERVATION_JSON=${JSON.stringify(results[0])}`); emitted += 1; }
    }
  }
  // Each collected slot is reported immediately. Planning/gating returns before
  // onResult, so those read-only outcomes are printed here.
  if (emitted === 0) for (const result of results) console.log(`KIS_EOD_OBSERVATION_JSON=${JSON.stringify(result)}`);
  if (results.some((result) => ["FAILED", "PARTIAL", "BLOCKED"].includes(result.status))) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await cli();
