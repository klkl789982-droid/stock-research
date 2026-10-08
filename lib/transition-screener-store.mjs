import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { buildTransitionRows, TRANSITION_RULE_VERSION } from "./transition-screener.mjs";

export function createTransitionStore({ root = process.cwd() } = {}) {
  let cached = null;
  const inFlight = new Map();
  return async () => {
    const directory = path.join(root, "data", "history");
    const files = (await readdir(directory)).filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/u.test(name)).sort();
    const latest = files.at(-1);
    if (!latest) throw new Error("TRANSITION_HISTORY_MISSING");
    const date = latest.slice(0, 10);
    const stats = await Promise.all([
      stat(path.join(root, "data", "history", latest)),
      stat(path.join(root, "data", "analysis", "market-seeds", latest)),
      stat(path.join(root, "data", "trading-calendar", "status.json")),
    ]);
    const stamps = stats.map((s) => [s.mtimeMs, s.size]);
    const key = JSON.stringify([date, stamps, TRANSITION_RULE_VERSION]);
    if (cached?.key === key) return cached.value;
    if (inFlight.has(key)) return inFlight.get(key);
    const pending = (async () => {
      const contents = await Promise.all([
        readFile(path.join(root, "data", "history", latest), "utf8"),
        readFile(path.join(root, "data", "analysis", "market-seeds", latest), "utf8"),
        readFile(path.join(root, "data", "trading-calendar", "status.json"), "utf8"),
      ]);
      const [history, seed, calendar] = contents.map((text) => JSON.parse(text));
      if (history.asOfDate !== date || !Array.isArray(history.records)) throw new Error("TRANSITION_HISTORY_INVALID");
      const rows = buildTransitionRows({ history, seed, calendar });
      const value = { rows, referenceDate: date, source: { seedContentHash: seed.contentHash, normalizedInputHash: seed.sourceManifest.sources.officialDailyPrice.normalizedInputHash },
        sourceQualityGrade: history.dataQuality?.overallGrade ?? "UNKNOWN", isPartialRanking: history.isPartialRanking === true,
        quarantinedCount: history.universeSummary?.quarantinedUniverse?.count ?? null,
      };
      cached = { key, value };
      return value;
    })();
    inFlight.set(key, pending);
    try { return await pending; } finally { inFlight.delete(key); }
  };
}

export const getTransitionData = createTransitionStore();
