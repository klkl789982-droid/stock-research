import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { createScreeningRows } from "./stock-screener.mjs";
import { normalizeStockCode } from "./stock-code.mjs";
import { locateExecutionTradingDay } from "./execution-return-resolver.mjs";

function rowsForDate(snapshot, date) {
  if (!snapshot || snapshot.asOfDate !== date || snapshot.dataQuality?.structuralStatus !== "passed" ||
      !Array.isArray(snapshot.records) || !snapshot.records.length ||
      snapshot.records.some(r => normalizeStockCode(r.code) !== r.code || !r.code || !r.name || r.date !== date) ||
      new Set(snapshot.records.map(r => r.code)).size !== snapshot.records.length) throw new Error("WATCHLIST_MARKET_UNAVAILABLE");
  return snapshot.records;
}

const tradableClose = row => row?.executable === true && row.qualityEligibility?.eligible === true &&
  Number.isFinite(row.closePrice) && row.closePrice > 0 ? row.closePrice : null;

export function watchlistMarketRows(latest, previous, calendar, date) {
  const rows = rowsForDate(latest, date);
  const previousDate = previous?.asOfDate;
  const next = previousDate ? locateExecutionTradingDay(calendar, previousDate, 1) : null;
  let prior = new Map();
  if (next?.status === "resolved" && next.date === date && calendar?.dates?.[previousDate]?.status === "tradingDay") {
    try { prior = new Map(rowsForDate(previous, previousDate).map(r => [r.code, r])); }
    catch { /* A corrupt comparison file cannot certify the change, but the latest verified close is independent. */ }
  }
  const screening = createScreeningRows(latest, null);
  return new Map(rows.map((row, i) => {
    const close = tradableClose(row), priorClose = tradableClose(prior.get(row.code));
    return [row.code, {
      code: row.code, name: row.name, market: row.market, date, close,
      closeChangePct: close !== null && priorClose !== null ? (close / priorClose - 1) * 100 : null,
      models: screening[i].qualityEligible ? screening[i].models : null,
    }];
  }));
}

// Published history files are immutable within a deployment. Keep only the
// small display DTO, never the full history or a user's watchlist, in memory.
export function createWatchlistMarketReader(root = process.cwd()) {
  let lastKey = "", task = null;
  return async () => {
    const folder = path.join(root, "data", "history");
    const names = (await readdir(folder)).filter(name => /^\d{4}-\d{2}-\d{2}\.json$/u.test(name)).sort();
    const latest = names.at(-1), previous = names.at(-2);
    if (!latest) throw new Error("WATCHLIST_MARKET_UNAVAILABLE");
    if (!task || lastKey !== latest) {
      lastKey = latest;
      const parse = async file => JSON.parse(await readFile(file, "utf8"));
      const pending = Promise.all([parse(path.join(folder, latest)), previous ? parse(path.join(folder, previous)).catch(() => null) : null,
        parse(path.join(root, "data/trading-calendar/status.json")).catch(() => null)])
        .then(([a, b, calendar]) => watchlistMarketRows(a, b, calendar, latest.slice(0, 10)));
      task = pending;
      pending.catch(() => { if (task === pending) task = null; });
    }
    return task;
  };
}

export const getWatchlistMarket = createWatchlistMarketReader();
