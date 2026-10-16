import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { buildLiveTransitionRows, validateLiveTransitionFreshness, LIVE_TRANSITION_RULE_VERSION } from "./live-transition-screener.mjs";

import { CURRENT_LIVE_PROFILE, LEGACY_LIVE_PROFILE } from "./intraday-model-top-time-policy.mjs";

export function createLiveTransitionStore({ root = process.cwd(), now = () => new Date(), archiveOnly = false } = {}) {
  const profile = archiveOnly ? LEGACY_LIVE_PROFILE : CURRENT_LIVE_PROFILE;
  const parse = async (contents, reason) => {
    try { return JSON.parse(await contents); }
    catch { throw new Error(reason); }
  };
  let cached = null;
  const inFlight = new Map();
  return async () => {
    const latest = await parse(readFile(path.join(root, "data", "intraday-signals", "model-top", "latest.json"), "utf8"), "LIVE_SNAPSHOT_MISSING");
    if (!archiveOnly && (latest.schemaVersion !== profile.schemaVersion || latest.observationPolicyId !== profile.policyId || latest.officialSignalTime !== profile.signalTime)) throw new Error("LIVE_SNAPSHOT_WAITING");
    if (latest.status !== "READY") throw new Error(latest.status === "MARKET_CLOSED" ? "LIVE_MARKET_CLOSED" : latest.status === "WAITING" ? "LIVE_SNAPSHOT_WAITING" : "LIVE_SNAPSHOT_FAILED");
    const match = new RegExp(`^data/intraday-signals/model-top/(\\d{4}-\\d{2}-\\d{2})/${profile.slot}\\.json$`, "u").exec(latest.signalPath ?? "");
    if (!match) throw new Error("LIVE_SNAPSHOT_INVALID");
    const signal = await parse(readFile(path.join(root, "data", "intraday-signals", "model-top", match[1], `${profile.slot}.json`), "utf8"), "LIVE_SNAPSHOT_MISSING");
    const date = signal.seedReferenceDate;
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(date ?? "")) throw new Error("LIVE_SNAPSHOT_INVALID");
    // Signatures invalidate on seed/history/calendar repair. Freshness and latest
    // attempt status are still evaluated on every request, even after a cache hit.
    let signatures;
    try {
      signatures = await Promise.all([
        stat(path.join(root, "data", "intraday-signals", "model-top", match[1], `${profile.slot}.json`)),
        stat(path.join(root, "data", "analysis", "market-seeds", `${date}.json`)).catch(() => { throw new Error("LIVE_SEED_MISSING"); }),
        stat(path.join(root, "data", "history", `${date}.json`)).catch(() => { throw new Error("LIVE_HISTORY_MISSING"); }),
        stat(path.join(root, "data", "trading-calendar", "status.json")).catch(() => { throw new Error("LIVE_CALENDAR_MISSING"); }),
      ]);
    } catch (error) { throw error instanceof Error && error.message.startsWith("LIVE_") ? error : new Error("LIVE_SNAPSHOT_MISSING"); }
    const calendar = await parse(readFile(path.join(root, "data", "trading-calendar", "status.json"), "utf8"), "LIVE_CALENDAR_MISSING");
    const key = JSON.stringify([latest.signalDate, latest.signalPath, latest.contentHash, signatures.map((value) => [value.mtimeMs, value.size]), LIVE_TRANSITION_RULE_VERSION]);
    validateLiveTransitionFreshness(signal, calendar, now(), { archiveOnly });
    if (cached?.key === key) return cached.value;
    if (inFlight.has(key)) {
      const value = await inFlight.get(key);
      validateLiveTransitionFreshness(signal, calendar, now(), { archiveOnly });
      return value;
    }
    const pending = (async () => {
      // Use only the immutable signal's named seed date, never latest EOD.
      const [seed, history] = await Promise.all([
        parse(readFile(path.join(root, "data", "analysis", "market-seeds", `${date}.json`), "utf8"), "LIVE_SEED_MISSING"),
        parse(readFile(path.join(root, "data", "history", `${date}.json`), "utf8"), "LIVE_HISTORY_MISSING"),
      ]);
      const rows = buildLiveTransitionRows({ latest, signal, seed, history, calendar, now: now(), archiveOnly });
      const value = { mode: archiveOnly ? "ARCHIVE" : "LIVE", archiveOnly, signalVersion: signal.signalVersion, observationPolicyId: profile.policyId, rows, referenceDate: signal.signalDate, previousOfficialDate: date, modelReferenceDate: date,
        snapshotTime: signal.officialSignalTime, collectionStartedAt: signal.collectionStartedAt, collectionCompletedAt: signal.collectionCompletedAt,
        ruleVersion: LIVE_TRANSITION_RULE_VERSION, sourceQualityGrade: history.dataQuality?.overallGrade ?? "UNKNOWN",
        isPartialRanking: history.isPartialRanking === true, quarantinedCount: history.universeSummary?.quarantinedUniverse?.count ?? null,
        source: { signalContentHash: signal.contentHash, seedContentHash: seed.contentHash, normalizedInputHash: signal.source.seedOfficialDailyHash,
          signalPath: latest.signalPath, priceBasis: "kisLastQuoteAtCollection", isRealtime: false },
      };
      cached = { key, value };
      return value;
    })();
    inFlight.set(key, pending);
    try {
      const value = await pending;
      validateLiveTransitionFreshness(signal, calendar, now(), { archiveOnly });
      return value;
    } finally { inFlight.delete(key); }
  };
}

export const getLiveTransitionData = createLiveTransitionStore();
