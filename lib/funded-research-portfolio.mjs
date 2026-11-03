import { locateExecutionTradingDay } from "./execution-return-resolver.mjs";
import { validateMarketPriceLedger } from "./market-price-ledger.mjs";

const STARTING_CASH = 100_000_000;
const round = (v) => Number.isFinite(v) ? Number(v.toFixed(6)) : null;
const dayAfter = (date) => new Date(Date.parse(date) + 86400000).toISOString().slice(0, 10);
const positive = (v) => Number.isFinite(v) && v > 0;
function unavailable(reason) {
  return { status: "UNAVAILABLE", reason, totalReturn: null, maxDrawdown: null, annualizedReturn: null, annualizedVolatility: null,
    averageExposurePct: null, tradeCount: null, profitLossRatio: null, nav: [] };
}

/** Orders must be determined before seeing any exit/return. Each new vintage gets at most
 * 1/holdingDays of previous NAV. Opening purchases cannot spend today's closing proceeds. */
export function simulateFundedPortfolio({ selections = [], ledgers = [], calendar, holdingDays, cost = { mode: "GROSS_ONLY" }, endDate, fixedSlots = null }) {
  if (fixedSlots !== null && (!Number.isInteger(fixedSlots) || fixedSlots < 1)) return unavailable("INVALID_FIXED_CAPACITY");
  if (!selections.length) return unavailable("NO_ADMISSIBLE_SIGNALS");
  if (!Number.isInteger(holdingDays) || holdingDays < 1) return unavailable("INVALID_HOLDING_PERIOD");
  const plans = new Map(), prices = new Map();
  for (const s of selections) {
    const capacity = s.capacity ?? s.tickers.length, fraction = s.allocationFraction ?? 1;
    if (calendar?.dates?.[s.entryDate]?.status !== "tradingDay" || !(s.signalDate < s.entryDate) || plans.has(s.entryDate) || new Set(s.tickers).size !== s.tickers.length ||
        !Number.isInteger(capacity) || capacity < s.tickers.length || !Number.isFinite(fraction) || fraction < 0 || fraction > 1) return unavailable("INVALID_SELECTION");
    const target = holdingDays === 1 ? { date: s.entryDate, status: "resolved" } : locateExecutionTradingDay(calendar, s.entryDate, holdingDays - 1);
    if (s.exitDate && (target.status !== "resolved" || target.date !== s.exitDate)) return unavailable("HOLDING_CALENDAR_MISMATCH");
    if (!["resolved", "pendingFutureTradingDay"].includes(target.status)) return unavailable("TRADING_CALENDAR_INCOMPLETE");
    plans.set(s.entryDate, { ...s, capacity, fraction, exitDate: target.date });
  }
  for (const l of ledgers) {
    if (prices.has(l.date)) return unavailable("DUPLICATE_PRICE_DATE");
    if (l.source !== "data-go-kr-official-daily-price" || validateMarketPriceLedger(l, 0).length || l.records.some((r) => r.date !== l.date)) return unavailable("INVALID_PRICE_LEDGER");
    prices.set(l.date, new Map(l.records.map((r) => [r.code, r])));
  }
  const start = [...plans.keys()].sort()[0];
  const last = endDate ?? [...plans.values()].map((p) => p.exitDate ?? [...prices.keys()].sort().at(-1)).sort().at(-1);
  if (!last || last < start) return unavailable("NO_VALUATION_DATES");
  const costs = cost.mode === "USER_INPUT";
  const rate = (key) => costs ? cost[key] / 10000 : 0;
  const buyMultiplier = (1 + rate("buySlippageBps")) * (1 + rate("buyFeeBps"));
  const sellMultiplier = (1 - rate("sellSlippageBps")) * (1 - rate("sellFeeBps") - rate("sellTaxBps"));
  if (!positive(buyMultiplier) || !positive(sellMultiplier)) return unavailable("INVALID_COST");
  const held = new Map(), nav = [], dailyReturns = [], profits = [], losses = [];
  const trades = [], skipped = [];
  let cash = STARTING_CASH, previous = cash, peak = cash, mdd = 0, exposureSum = 0, fills = 0;
  for (let date = start; date <= last; date = dayAfter(date)) {
    const session = calendar?.dates?.[date]?.status;
    if (session === "marketClosed" || (!session && [0, 6].includes(new Date(date).getUTCDay()))) continue;
    if (session !== "tradingDay") return unavailable("TRADING_CALENDAR_INCOMPLETE");
    const day = prices.get(date), plan = plans.get(date);
    if (plan) {
      const slotBudget = plan.capacity ? Math.min(cash, previous / holdingDays) * plan.fraction / plan.capacity : 0;
      for (const ticker of plan.tickers) {
        if (held.has(ticker) || (fixedSlots !== null && held.size >= fixedSlots) || !slotBudget) {
          if (fixedSlots) skipped.push({date,ticker,reason:held.has(ticker)?"ALREADY_HELD":held.size>=fixedSlots?"NO_SLOT":"NO_CASH"}); continue;
        }
        const bar = day?.get(ticker);
        if (!bar) return unavailable("ENTRY_PRICE_MISSING");
        if (bar.executable === false) { if(fixedSlots) skipped.push({date,ticker,reason:"UNTRADABLE"}); continue; }
        if (!positive(bar.openPrice)) return unavailable("INVALID_OPEN");
        const unitCost = bar.openPrice * buyMultiplier, units = Math.floor((fixedSlots ? Math.min(cash, previous / fixedSlots) : slotBudget) / unitCost);
        if (!units) { if(fixedSlots) skipped.push({date,ticker,reason:"INSUFFICIENT_CASH"}); continue; }
        const outlay = unitCost * units;
        cash -= outlay;
        held.set(ticker, { units, outlay, exitDate: plan.exitDate, ...(fixedSlots ? {signalDate:plan.signalDate,entryDate:date,open:bar.openPrice,lastClose:bar.openPrice} : {}) });
        fills++;
      }
    }
    let marked = 0, invested = 0;
    for (const [ticker, lot] of held) {
      const bar = day?.get(ticker);
      if (!bar || bar.executable === false || !positive(bar.closePrice)) return unavailable("MARK_OR_EXIT_UNAVAILABLE");
      if(fixedSlots && date!==lot.entryDate && Math.abs(bar.closePrice/lot.lastClose-1)>0.301) return unavailable("PRICE_DISCONTINUITY_NEEDS_ACTION_LEDGER");
      if(fixedSlots)lot.lastClose=bar.closePrice;
      const value = lot.units * bar.closePrice;
      invested += value;
      if (lot.exitDate === date) {
        const proceeds = value * sellMultiplier, pnl = proceeds - lot.outlay;
        if(fixedSlots) trades.push({...lot,ticker,close:bar.closePrice,proceeds,pnl,netPct:pnl/lot.outlay*100});
        cash += proceeds;
        if (pnl > 0) profits.push(pnl);
        if (pnl < 0) losses.push(-pnl);
        held.delete(ticker);
      } else marked += value;
    }
    const value = cash + marked, exposurePct = Math.min(100, 100 * (fixedSlots ? marked : invested) / (value || 1));
    dailyReturns.push(value / previous - 1); previous = value;
    peak = Math.max(peak, value); mdd = Math.min(mdd, value / peak - 1); exposureSum += exposurePct;
    nav.push({ date, value: round(value / STARTING_CASH * 100), cash: round(cash / STARTING_CASH * 100), exposurePct: round(exposurePct) });
  }
  if (!nav.length) return unavailable("NO_VALUATION_DATES");
  const n = nav.length, mean = dailyReturns.reduce((s, v) => s + v, 0) / n;
  const sum = (a) => a.reduce((s, v) => s + v, 0);
  return { status: "VALUED", reason: null, startingCapitalKrw: STARTING_CASH, costMode: cost.mode, nav,
    totalReturn: round((previous / STARTING_CASH - 1) * 100), maxDrawdown: round(mdd * 100), tradeCount: fills, openPositions: held.size,
    ...(fixedSlots ? {trades,skipped} : {}),
    averageExposurePct: round(exposureSum / n), profitLossRatio: profits.length && losses.length ? round((sum(profits) / profits.length) / (sum(losses) / losses.length)) : null,
    annualizedReturn: n >= 60 ? round(((previous / STARTING_CASH) ** (252 / n) - 1) * 100) : null,
    annualizedVolatility: n >= 60 ? round(Math.sqrt(dailyReturns.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1) * 252) * 100) : null };
}
