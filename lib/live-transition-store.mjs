import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { buildLiveTransitionRows, validateLiveTransitionFreshness, LIVE_TRANSITION_RULE_VERSION } from "./live-transition-screener.mjs";
import { loadCurrentLiveUniverse } from "./current-live-universe.mjs";
import { readTransitionVerdict } from "./live-transition-verdict.mjs";

export function createLiveTransitionStore({ root = process.cwd(), now = () => new Date(), archive = false } = {}) {
  const parse = async (contents, reason) => {
    try { return JSON.parse(await contents); }
    catch { throw new Error(reason); }
  };
  let cached = null;
  const inFlight = new Map();
  return async () => {
    const latest = await parse(readFile(path.join(root, "data", "intraday-signals", "model-top", "latest.json"), "utf8"), "LIVE_SNAPSHOT_MISSING");
    if (latest.status !== "READY") throw new Error(latest.status === "MARKET_CLOSED" ? "LIVE_MARKET_CLOSED" : latest.status === "WAITING" ? "LIVE_SNAPSHOT_WAITING" : "LIVE_SNAPSHOT_FAILED");
    const match = /^data\/intraday-signals\/model-top\/(\d{4}-\d{2}-\d{2})\/1430\.json$/u.exec(latest.signalPath ?? "");
    if (!match) throw new Error("LIVE_SNAPSHOT_INVALID");
    const signal = await parse(readFile(path.join(root, "data", "intraday-signals", "model-top", match[1], "1430.json"), "utf8"), "LIVE_SNAPSHOT_MISSING");
    if (Date.parse(signal.collectionCompletedAt) > now().getTime()) throw new Error("LIVE_SNAPSHOT_FUTURE");
    const validationTime = () => archive ? new Date(signal.collectionCompletedAt) : now();
    const date = signal.seedReferenceDate;
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(date ?? "")) throw new Error("LIVE_SNAPSHOT_INVALID");
    // Signatures invalidate on seed/history/calendar repair. Freshness and latest
    // attempt status are still evaluated on every request, even after a cache hit.
    let signatures;
    try {
      signatures = await Promise.all([
        stat(path.join(root, "data", "intraday-signals", "model-top", match[1], "1430.json")),
        stat(path.join(root, "data", "analysis", "market-seeds", `${date}.json`)).catch(() => { throw new Error("LIVE_SEED_MISSING"); }),
        stat(path.join(root, "data", "history", `${date}.json`)).catch(() => { throw new Error("LIVE_HISTORY_MISSING"); }),
        stat(path.join(root, "data", "trading-calendar", "status.json")).catch(() => { throw new Error("LIVE_CALENDAR_MISSING"); }),
      ]);
    } catch (error) { throw error instanceof Error && error.message.startsWith("LIVE_") ? error : new Error("LIVE_SNAPSHOT_MISSING"); }
    const calendar = await parse(readFile(path.join(root, "data", "trading-calendar", "status.json"), "utf8"), "LIVE_CALENDAR_MISSING");
    const key = JSON.stringify([latest.signalDate, latest.signalPath, latest.contentHash, signatures.map((value) => [value.mtimeMs, value.size]), LIVE_TRANSITION_RULE_VERSION]);
    validateLiveTransitionFreshness(signal, calendar, validationTime());
    if (cached?.key === key) return cached.value;
    if (inFlight.has(key)) {
      const value = await inFlight.get(key);
      validateLiveTransitionFreshness(signal, calendar, validationTime());
      return value;
    }
    const pending = (async () => {
      // Use only the immutable signal's named seed date, never latest EOD.
      const [seed, history] = await Promise.all([
        parse(readFile(path.join(root, "data", "analysis", "market-seeds", `${date}.json`), "utf8"), "LIVE_SEED_MISSING"),
        parse(readFile(path.join(root, "data", "history", `${date}.json`), "utf8"), "LIVE_HISTORY_MISSING"),
      ]);
      const rows = buildLiveTransitionRows({ latest, signal, seed, history, calendar, now: validationTime() });
      const value = { mode: "LIVE", rows, referenceDate: signal.signalDate, previousOfficialDate: date, modelReferenceDate: date,
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
      validateLiveTransitionFreshness(signal, calendar, validationTime());
      return value;
    } finally { inFlight.delete(key); }
  };
}

export const getArchivedLiveTransitionData = createLiveTransitionStore({ archive: true });

export function currentTransitionView(signal, calendar, now = new Date()) {
  validateLiveTransitionFreshness(signal, calendar, now);
  const rows = signal.records.map(row => {
    const reason = row.reason ?? (["5-20", "20-60"].every(pair => readTransitionVerdict(row.transitionV1?.[pair], 1) !== null) ? null : "transitionVerdictNotStored");
    return { code: row.code, name: row.name, market: row.market, models: row.models, referenceDate: signal.signalDate,
      modelReferenceDate: signal.signalDate, quoteAsOfDate: row.observedDate, quoteAsOfTime: row.observedTime, receivedAt: row.receivedAt,
      qualityStatus: reason ? "UNAVAILABLE" : "PROVISIONAL", missingReasons: reason ? [reason] : [], transitionV1: row.transitionV1, observedPrice: null };
  });
  return { mode: "LIVE", rows, referenceDate: signal.signalDate, modelReferenceDate: signal.signalDate, previousOfficialDate: signal.seedReferenceDate,
    snapshotTime: signal.officialSignalTime, collectionStartedAt: signal.collectionStartedAt, collectionCompletedAt: signal.collectionCompletedAt,
    publicationStatus: signal.publicationStatus, revision: signal.revision, publishedAt: signal.publishedAt, coverage: signal.coverage,
    ruleVersion: LIVE_TRANSITION_RULE_VERSION, sourceQualityGrade: signal.sourceQualityGrade,
    isPartialRanking: signal.publicationStatus === "PARTIAL", quarantinedCount: null,
    source: { signalContentHash: signal.sourceHash, seedContentHash: signal.seedHash, normalizedInputHash: signal.normalizedInputHash,
      deliveryHash: signal.deliveryHash, modelDefinitions: signal.modelDefinitions, priceBasis: "notPubliclyRedistributed", isRealtime: false } };
}

export async function getLiveTransitionData() {
  const [signal, calendar] = await Promise.all([loadCurrentLiveUniverse(), readFile(path.join(process.cwd(), "data", "trading-calendar", "status.json"), "utf8").then(text => JSON.parse(text))]);
  return currentTransitionView(signal, calendar);
}
