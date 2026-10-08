import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { getTransitionData } from "./transition-screener-store.mjs";
import { validateIntradayMarketSeed } from "./intraday-market-seed.mjs";
import { summarizeModelChanges, summarizeTransitions, calendarContext } from "./home-dashboard.mjs";
import { TRANSITION_RULE_VERSION } from "./transition-screener.mjs";

export function createHomeDashboardStore({ root = process.cwd(), loadTransitions = getTransitionData } = {}) {
  let cached = null;
  const flights = new Map();
  return async (topN = 5) => {
    if (![5, 10, 20].includes(topN)) throw new Error("HOME_TOP_N_INVALID");
    const names = (await readdir(path.join(root, "data", "history"))).filter((n) => /^\d{4}-\d{2}-\d{2}\.json$/u.test(n)).sort();
    const latest = names.at(-1);
    if (!latest) throw new Error("HOME_HISTORY_MISSING");
    const stamps = await Promise.all([
      ...names.map(async (name) => { const s = await stat(path.join(root, "data", "history", name)); return [name, s.size, s.mtimeMs]; }),
      stat(path.join(root, "data", "analysis", "market-seeds", latest)).then((s) => [s.size, s.mtimeMs]).catch(() => null),
      stat(path.join(root, "data", "trading-calendar", "status.json")).then((s) => [s.size, s.mtimeMs]).catch(() => null),
    ]);
    const key = JSON.stringify([stamps, topN, TRANSITION_RULE_VERSION]);
    const decorate = (value) => ({ ...value, calendar: calendarContext(value.calendarSource), calendarSource: undefined });
    if (cached?.key === key && (cached.value.models && cached.value.transitions || Date.now() - cached.at < 30_000)) return decorate(cached.value);
    if (flights.has(key)) return decorate(await flights.get(key));
    const pending = (async () => {
      const [historyText, seedText, calendarText] = await Promise.all([
        readFile(path.join(root, "data", "history", latest), "utf8"),
        readFile(path.join(root, "data", "analysis", "market-seeds", latest), "utf8").catch(() => null),
        readFile(path.join(root, "data", "trading-calendar", "status.json"), "utf8").catch(() => null),
      ]);
      const history = JSON.parse(historyText);
      const calendar = calendarText ? JSON.parse(calendarText) : null;
      let models = null, transitions = null;
      if (history.asOfDate === latest.slice(0, 10) && history.dataQuality?.structuralStatus === "passed" && calendar?.dates?.[history.asOfDate]?.status === "tradingDay") {
        let previousOfficialDate = null, previous = null;
        try {
          const seed = seedText ? JSON.parse(seedText) : null;
          if (seed && seed.requestedDate === history.asOfDate && !validateIntradayMarketSeed(seed, history.records.length).length && seed.sourceManifest?.sources?.officialDailyPrice?.normalizedInputHash === history.sourceManifest?.sources?.officialDailyPrice?.normalizedInputHash) {
            const dates = [...new Set(seed.records.filter((r) => r.eligible).map((r) => r.rows?.[1]?.[0]).filter(Boolean))];
            if (dates.length === 1 && /^\d{8}$/u.test(dates[0])) previousOfficialDate = `${dates[0].slice(0, 4)}-${dates[0].slice(4, 6)}-${dates[0].slice(6, 8)}`;
          }
          if (previousOfficialDate && names.includes(`${previousOfficialDate}.json`)) previous = JSON.parse(await readFile(path.join(root, "data", "history", `${previousOfficialDate}.json`), "utf8"));
        } catch { previous = null; }
        models = summarizeModelChanges(history, previous, previousOfficialDate, topN);
      }
      try { transitions = summarizeTransitions(await loadTransitions(), models); } catch { /* A transition failure does not hide frozen model ranks. */ }
      const value = { referenceDate: history.asOfDate, models, transitions, calendarSource: calendar };
      cached = { key, value, at: Date.now() };
      return value;
    })();
    flights.set(key, pending);
    try { return decorate(await pending); } finally { flights.delete(key); }
  };
}

export const getHomeDashboard = createHomeDashboardStore();
