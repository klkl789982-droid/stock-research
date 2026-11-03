import { EXECUTION_HORIZONS, locateExecutionTradingDay, resolveExecutionReturnsByPolicy } from "./execution-return-resolver.mjs";
import { applyResearchCosts } from "./model-performance-research.mjs";
import { inputLineage, makeSelections, marketConditions, median, researchModels, researchUniverse } from "./daily-strategy-challengers.mjs";
import { hashObject } from "./rank-backtest-engine.mjs";

const average = (xs) => xs.length ? xs.reduce((a,b) => a+b, 0) / xs.length : null;
const round = (n) => Number.isFinite(n) ? Number(n.toFixed(4)) : null;
const count = (object, key) => { object[key] = (object[key] ?? 0) + 1; };
const group = (map, key, init) => { if (!map.has(key)) map.set(key, init()); return map.get(key); };

export function executionWindow(snapshot, calendar, days, period) {
  const signal = snapshot.asOfDate;
  if (signal < period[0] || signal > period[1]) return { reason: "OUTSIDE_SPLIT" };
  const entry = locateExecutionTradingDay(calendar, signal, 2);
  if (entry.status !== "resolved") return { reason: entry.status };
  const timestamp = Date.parse(snapshot.signalComputedAt);
  if (!Number.isFinite(timestamp) || timestamp < Date.parse(signal + "T15:30:00+09:00") ||
      timestamp >= Date.parse(entry.date + "T09:00:00+09:00")) return { reason: "GENERATION_NOT_BEFORE_ENTRY" };
  const exit = days === 1 ? entry : locateExecutionTradingDay(calendar, entry.date, days - 1);
  if (exit.status !== "resolved") return { reason: exit.status };
  if (exit.date > period[1]) return { reason: "PURGED_CROSS_BOUNDARY" };
  return { signalDate: signal, entryDate: entry.date, exitDate: exit.date };
}

// Each contrast averages within date first. Ties are not split by arbitrary ticker order.
function addContrasts(results, rows, returns) {
  const columns = ["score", "volatility", ...Object.keys(rows[0]?.factors ?? {})];
  for (const field of columns) {
    const value = (r) => field === "score" || field === "volatility" ? r[field] : r.factors?.[field];
    const sorted = rows.filter((r) => Number.isFinite(value(r))).sort((a,b) => value(a)-value(b));
    if (sorted.length < 5) continue;
    const low = value(sorted[Math.ceil(sorted.length / 5) - 1]);
    const high = value(sorted[sorted.length - Math.ceil(sorted.length / 5)]);
    if (low >= high) continue;
    const lowSide = sorted.filter((r) => value(r) <= low), highSide = sorted.filter((r) => value(r) >= high);
    const means = [lowSide, highSide].map((groupRows) => {
      const values = groupRows.map((r) => returns.get(r.ticker));
      return values.every(Number.isFinite) ? average(values) : null;
    });
    if (means.some((v) => v === null)) continue;
    group(results, field, () => []).push({ low: means[0], high: means[1], spread: means[1] - means[0] });
  }
}

function sharedFactorSignals(rows, model) {
  const pairs = model === "B-v1" ? [["maStructureScore","trendPersistenceScore"],["maStructureScore","momentumScore"]]
    : model === "C-v1" ? [["shortMomentumScore","priceActionScore"],["rsiMacdScore","shortMAScore"]] : [];
  return pairs.flatMap(([a,b]) => {
    const data = rows.map((r) => r.factors).filter((f) => Number.isFinite(f?.[a]) && Number.isFinite(f?.[b]));
    if (data.length < 3) return [];
    const x = average(data.map((f) => f[a])), y = average(data.map((f) => f[b]));
    const xy = data.reduce((v,f) => v+(f[a]-x)*(f[b]-y),0);
    const norm = Math.sqrt(data.reduce((v,f) => v+(f[a]-x)**2,0) * data.reduce((v,f) => v+(f[b]-y)**2,0));
    return norm ? [[a+"/"+b,xy/norm]] : [];
  });
}

function summarizeStrategy(lines, { days, ledgers, calendar, cost, simulate, benchmark, baseline }) {
  const complete = lines.filter((s) => s.net !== null), countByTicker = {};
  for (const line of lines) for (const code of line.tickers) {
    count(countByTicker, code);
  }
  const leader = Object.entries(countByTicker).sort((a,b) => b[1]-a[1] || a[0].localeCompare(b[0]))[0];
  const account = lines.length === baseline.length ? simulate({ selections: lines, ledgers, calendar, holdingDays: days, cost })
    : { status: "UNAVAILABLE", reason: "SELECTION_INPUT_GAPS" };
  const navMetrics = { status: account.status, reason: account.reason ?? null,
    totalReturn: round(account.totalReturn), maxDrawdown: round(account.maxDrawdown),
    annualizedReturn: round(account.annualizedReturn), exposure: round(account.averageExposurePct),
    tradeCount: account.tradeCount, profitLossRatio: round(account.profitLossRatio) };
  const excess = [], bandReturns = { up: [], sideways: [], down: [] }, attribution = new Map();
  for (const line of complete) {
    const legs = line.markets.map((market) => benchmark(market, line.entryDate, line.exitDate));
    if (legs.length && legs.every(Number.isFinite))
      excess.push(line.net - legs.reduce((a,b) => a+b, 0) / line.capacity * line.allocationFraction);
    for (const item of line.members) {
      if (item.band && Number.isFinite(item.net)) bandReturns[item.band].push(item.net);
      attribution.set(item.code, (attribution.get(item.code) ?? 0) + item.net * line.allocationFraction / line.capacity);
    }
  }
  const deltas = complete.flatMap((line) => {
    const base = baseline.find((b) => b.signalDate === line.signalDate);
    return Number.isFinite(base?.net) ? [line.net - base.net] : [];
  });
  const byContribution = [...attribution].sort((a,b) => Math.abs(b[1]) - Math.abs(a[1]));
  const absSum = byContribution.reduce((v,part) => v+Math.abs(part[1]),0);
  return { selectedDates: lines.length, completeDates: complete.length, missingDates: lines.length - complete.length,
    pairedDates: deltas.length, pairedNetDifferencePp: round(average(deltas)),
    matureLegs: lines.reduce((n,l) => n+l.members.filter((r) => Number.isFinite(r.net)).length,0),
    meanCohortNet: round(average(complete.map((l) => l.net))), meanCohortGross: round(average(complete.map((l) => l.gross))),
    meanNetMinusOfficialIndex: round(average(excess)), matchedIndexDates: excess.length,
    byMomentumBand: Object.fromEntries(Object.entries(bandReturns).map(([band, values]) => [band, { n: values.length, net: round(average(values)) }])),
    highestRepeat: leader ? { ticker: leader[0], signalDays: leader[1], shareOfSelectionsPct: round(100*leader[1]/Object.values(countByTicker).reduce((a,b) => a+b,0)) } : null,
    largestAbsoluteNetContributor: absSum ? { ticker: byContribution[0][0], sharePct: round(100*Math.abs(byContribution[0][1])/absSum) } : null,
    bestAndWorstNetCohort: complete.length ? [Math.min(...complete.map((l) => l.net)), Math.max(...complete.map((l) => l.net))].map(round) : null,
    maxVolatilityQuintileSelectionPct: round(100 * lines.reduce((sum,l) => sum+l.highVolCount,0) / lines.reduce((sum,l) => sum+l.knownVolCount,0)),
    account: navMetrics };
}

export function runStrategyStudy({ snapshots, calendar, ledgerMap, ledgers, plan, simulate, benchmark = () => null }) {
  const cohorts = new Map(), excluded = {}, evidence = {}, hashes = {};
  const latest = plan.chronologicalCheck[1];
  if (snapshots.some((s) => s.asOfDate > latest) || ledgers.some((l) => l.date > latest) ||
      Object.keys(calendar.dates).some((d) => d > latest)) throw new Error("Research attempted to read past the frozen cutoff");
  for (const snapshot of snapshots) {
    const date = snapshot.asOfDate;
    const split = date <= plan.development[1] ? "development" : "chronologicalCheck";
    if (date < plan[split][0] || date > plan[split][1]) continue;
    if (snapshot.sourceManifest?.sources?.officialDailyPrice?.provider !== "공공데이터포털") { count(excluded, "UNVERIFIED_DAILY_SOURCE"); continue; }
    const adjustedVerified = snapshot.dataQuality?.certification?.eligibleForRankBacktest === true;
    evidence[date] = { certifiedForRankBacktest: adjustedVerified, pit: snapshot.sourceManifest?.universe?.artifact?.verificationStatus ?? "UNKNOWN",
      publication: snapshot.publication?.status ?? "UNVERIFIED", futureFieldsUsed: false };
    const resolved = new Map();
    for (const model of researchModels) {
      const lineage = inputLineage(snapshot, model), rows = researchUniverse(snapshot, model);
      if (!lineage || !rows.length) { count(excluded, [date, model, !lineage ? "FORMULA_LINEAGE_UNAVAILABLE" : "RANK_INPUT_UNAVAILABLE"].join("/")); continue; }
      hashes[lineage.id] = lineage.lineage;
      const selection = makeSelections(rows, model, plan.candidates.find((c) => c.changedFrom === model));
      const markets = marketConditions(rows), sortedVol = rows.map((r) => r.volatility).filter(Number.isFinite).sort((a,b) => a-b);
      const highVol = sortedVol[sortedVol.length - Math.ceil(sortedVol.length/5)];
      for (const days of new Set([plan.commonHoldingDays, plan.primaryHoldingDays[model]])) {
        const window = executionWindow(snapshot, calendar, days, plan[split]);
        if (window.reason) { count(excluded, [split, model, days, window.reason].join("/")); continue; }
        const key = [split,model,days,lineage.id].join("/");
        const cohort = group(cohorts, key, () => ({ split, model, days, lineage: lineage.id, selections: new Map(), contrasts: new Map(), correlations: new Map(), selectionGaps: {} }));
        for (const [name,value] of sharedFactorSignals(rows,model)) group(cohort.correlations,name,() => []).push(value);
        const returns = new Map(), gross = new Map(), contract = EXECUTION_HORIZONS["H"+days];
        for (const row of rows) {
          // Only use computedAt as a lower-bound in this explicitly conditional price study.
          // It cannot certify public availability; never pass cached future outcomes or estimated fills.
          const execution = group(resolved, row.ticker, () => resolveExecutionReturnsByPolicy({ code: row.ticker },
            { asOfDate: date, signalAvailableAt: snapshot.signalComputedAt }, ledgerMap, calendar));
          const value = execution.returns[contract.returnKey];
          gross.set(row.ticker, value);
          returns.set(row.ticker, applyResearchCosts(value, plan.cost));
        }
        addContrasts(cohort.contrasts, rows, returns);
        for (const s of selection) {
          const codes = s.members.map((r) => r.ticker);
          const wholeBasket = (map) => codes.every((c) => Number.isFinite(map.get(c)))
            ? codes.reduce((sum,c) => sum+map.get(c),0) * s.allocationFraction / s.capacity : null;
          const members = s.members.map((r) => ({ code: r.ticker, net: returns.get(r.ticker), band: markets.get(r.market)?.band ?? null }));
          group(cohort.selections, s.id, () => []).push({ ...window, tickers: codes, markets: s.members.map((r) => r.market), members,
            highVolCount: s.members.filter((r) => Number.isFinite(r.volatility) && r.volatility >= highVol).length,
            knownVolCount: s.members.filter((r) => Number.isFinite(r.volatility)).length,
            capacity: s.capacity, allocationFraction: s.allocationFraction, gross: wholeBasket(gross), net: wholeBasket(returns) });
        }
        if (!selection.some((s) => s.id.endsWith("-research"))) count(cohort.selectionGaps,"CANDIDATE_INPUT_INCOMPLETE");
      }
    }
  }
  return { study: plan.studyId, protocolHash: hashObject(plan), layer: plan.layer, promotion: plan.promotion, evidence, formulaLineage: hashes, excluded,
    cohorts: [...cohorts.values()].map(({ split,model,days,lineage,selections,contrasts,correlations,selectionGaps }) => ({
      split, model, days, lineage, selectionGaps,
      strategies: Object.fromEntries([...selections].map(([k,v]) => [k,summarizeStrategy(v,{days,ledgers,calendar,cost:plan.cost,simulate,benchmark,baseline:selections.get(model)})])),
      averageCrossSectionalFactorCorrelation: Object.fromEntries([...correlations].map(([k,v]) => [k,round(average(v))])),
      // Every contrast compares actual subsequent price movement; it is descriptive, not causal.
      scoreAndFactorQuintiles: Object.fromEntries([...contrasts].map(([k,values]) => [k,{ dates: values.length, low: round(average(values.map((v) => v.low))),
        high: round(average(values.map((v) => v.high))), spread: round(average(values.map((v) => v.spread))), medianSpread: round(median(values.map((v) => v.spread))) }])) })),
    limitations: ["Retrospective hypothetical fills. Local calculation time does not prove publication.", "Unadjusted price returns; dividends, corporate actions and dated sector membership unverified.",
      "Overlapping windows and repeated securities are dependent. Already inspected history is not a holdout.", "No preserved same-time volume normal; no scaled intraday estimate."] };
}
