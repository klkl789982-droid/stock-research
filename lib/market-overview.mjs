import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { validateCompactModelHistory } from "./daily-production.mjs";
import { validateMarketPriceLedger } from "./market-price-ledger.mjs";
import { locateExecutionTradingDay } from "./execution-return-resolver.mjs";
import { loadResearchIndexSeries } from "./research-index-benchmarks.mjs";

const markets = ["KOSPI", "KOSDAQ"];
const dayMs = 86_400_000;
const dayShift = (date, days) => new Date(Date.parse(date) + days * dayMs).toISOString().slice(0, 10);
const finiteClose = (n) => Number.isFinite(n) && n > 0;
const pct = (close, previous) => (close / previous - 1) * 100;
const round = (n) => Number(n.toFixed(4));

// Require all intervening weekdays to be accounted for; e.g. a missing Tuesday
// does not turn Monday -> Wednesday into a one-session change.
function consecutive(from, to, calendar) {
  if (from >= to) return false;
  for (let date = dayShift(from, 1); date < to; date = dayShift(date, 1)) {
    const state = calendar?.dates?.[date]?.status;
    if (state === "marketClosed") continue;
    if (state || ![0, 6].includes(new Date(date).getUTCDay())) return false;
  }
  return true;
}

export function summarizeMarketIndex(market, series, calendar, now, dailyDate) {
  const today = new Date(Date.parse(now) + 9 * 3_600_000).toISOString().slice(0, 10);
  const rows = series.filter(r => r.market === market && finiteClose(r.close) && r.date <= today &&
    Date.parse(r.observedAt) <= Date.parse(now) && Date.parse(r.date + "T00:00:00+09:00") <= Date.parse(r.observedAt) &&
    calendar?.dates?.[r.date]?.status !== "marketClosed")
    .sort((a, b) => a.date.localeCompare(b.date));
  const last = rows.at(-1);
  if (!last || new Set(rows.map(r => r.date)).size !== rows.length) return { market, status: "UNAVAILABLE" };
  const connected = [];
  for (let i = rows.length - 1; i > 0 && connected.length < 20; --i) {
    if (!consecutive(rows[i - 1].date, rows[i].date, calendar)) break;
    connected.push(pct(rows[i].close, rows[i - 1].close));
  }
  let volatility20Pct = null;
  if (connected.length === 20) {
    const mean = connected.reduce((sum, value) => sum + value, 0) / 20;
    volatility20Pct = round(Math.sqrt(connected.reduce((sum, value) => sum + (value - mean) ** 2, 0) / 19));
  }
  const prior = connected.length ? rows.at(-2) : null;
  return { market, status: "AVAILABLE", date: last.date, observedAt: last.observedAt, close: last.close,
    priorDate: prior?.date ?? null, change: prior ? round(last.close - prior.close) : null,
    changePct: prior ? round(connected[0]) : null,
    return5Pct: connected.length >= 5 ? round(pct(last.close, rows.at(-6).close)) : null, volatility20Pct,
    // FHKUP03500100 output2 supplies stck_bsop_date. mod_yn denotes a
    // modification, not a close confirmation. The HTTP receipt is not an exchange timestamp.
    sourceOperation: "FHKUP03500100", sourceDateField: "output2.stck_bsop_date",
    exchangeAsOfTime: null, closeConfirmed: null,
    timing: last.date === today ? "CURRENT_SOURCE_DAY" : dailyDate && last.date < dailyDate ? "BEHIND_DAILY" : "DATED_DAILY" };
}

export function summarizeMarketBreadth({ current, previous, prices, priorPrices, calendar }) {
  const validate = (snapshot, ledger) => {
    const count = snapshot.universeSummary?.originalUniverse?.count;
    if (!Number.isInteger(count) || count < 1 || validateCompactModelHistory(snapshot, count).length ||
        ledger.source !== "data-go-kr-official-daily-price" || ledger.date !== snapshot.referenceDate ||
        !Array.isArray(ledger.records) || ledger.records.some(r => r.date !== ledger.date) ||
        validateMarketPriceLedger(ledger, 0).length) throw new Error("MARKET_COVERAGE_INVALID");
  };
  validate(current, prices);
  validate(previous, priorPrices);
  if (calendar?.dates?.[previous.referenceDate]?.status !== "tradingDay" ||
      locateExecutionTradingDay(calendar, previous.referenceDate, 1).date !== current.referenceDate ||
      calendar?.dates?.[current.referenceDate]?.status !== "tradingDay") throw new Error("MARKET_CALENDAR_INCOMPLETE");
  const lookup = (records) => new Map(records.map(r => [r.code, r]));
  const a = lookup(prices.records), b = lookup(priorPrices.records);
  const prev = new Map(previous.records.map(r => [r.ticker, r]));
  const counts = { up: 0, down: 0, flat: 0, unavailable: 0 };
  for (const record of current.records) {
    const price = a.get(record.ticker), before = b.get(record.ticker), prior = prev.get(record.ticker);
    if (record.eligibility?.eligible !== true || prior?.eligibility?.eligible !== true || prior.market !== record.market ||
        price?.executable !== true || before?.executable !== true || !finiteClose(price.closePrice) || !finiteClose(before.closePrice)) {
      counts.unavailable++;
      continue;
    }
    if (price.closePrice > before.closePrice) counts.up++;
    else if (price.closePrice < before.closePrice) counts.down++;
    else counts.flat++;
  }
  return { status: "AVAILABLE", date: current.referenceDate, priorDate: previous.referenceDate,
    universe: current.records.length, compared: counts.up + counts.down + counts.flat, ...counts };
}

const json = async (file) => JSON.parse(await readFile(file, "utf8"));

async function storedBreadth(root, calendar, today) {
  const history = path.join(root, "data", "model-history"), prices = path.join(root, "data", "market-prices");
  const dates = (await readdir(history)).filter(n => /^\d{4}-\d{2}-\d{2}\.json$/.test(n)).map(n => n.slice(0, -5)).filter(d => d <= today).sort();
  const [priorDate, date] = dates.slice(-2);
  if (!priorDate || !date) throw new Error("MARKET_COVERAGE_MISSING");
  const [current, previous, ledger, priorPrices] = await Promise.all([json(path.join(history, date + ".json")), json(path.join(history, priorDate + ".json")),
    json(path.join(prices, date + ".json")), json(path.join(prices, priorDate + ".json"))]);
  if (current.referenceDate !== date || previous.referenceDate !== priorDate) throw new Error("MARKET_COVERAGE_INVALID");
  return summarizeMarketBreadth({ current, previous, prices: ledger, priorPrices, calendar });
}

export async function loadMarketOverview({ root = process.cwd(), requestIndex, clock = () => Date.now() }) {
  const today = new Date(clock() + 9 * 3_600_000).toISOString().slice(0, 10);
  const [calendar, series] = await Promise.all([
    json(path.join(root, "data/trading-calendar/status.json")).catch(() => null),
    loadResearchIndexSeries([dayShift(today, -55), today], requestIndex),
  ]);
  const breadth = await storedBreadth(root, calendar, today).catch(() => ({ status: "UNAVAILABLE", date: null }));
  return { indices: markets.map(market => summarizeMarketIndex(market, series, calendar, new Date(clock()).toISOString(), breadth.date)), breadth };
}
