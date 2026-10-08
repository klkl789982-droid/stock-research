import { calculateMarketAnalysis } from "./market-analysis-v1.mjs";
import { createScreeningRows, SCREENING_MODELS } from "./stock-screener.mjs";
import { validateIntradayMarketSeed } from "./intraday-market-seed.mjs";
import { sha256Canonical } from "./snapshot-quality-pipeline.mjs";
import { isWeekend } from "./trading-calendar-status.mjs";

import { TRANSITION_RULE_VERSION, TRANSITION_PAIRS, TRANSITION_STATUSES, TRANSITION_RESEARCH_PROPOSAL } from "./transition-rule-policy.mjs";
export { TRANSITION_RULE_VERSION, TRANSITION_PAIRS, TRANSITION_STATUSES, TRANSITION_RESEARCH_PROPOSAL };
const finite = (value) => Number.isFinite(value) ? value : null;
const iso = (date) => `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;

export function observeMaTransition(points, pair) {
  const [shortKey, longKey] = TRANSITION_PAIRS[pair] ?? [];
  if (!shortKey || points.length < 2) throw new Error("TRANSITION_INPUT_INVALID");
  const current = points.at(-1), previous = points.at(-2);
  if (![current[shortKey], current[longKey], previous[shortKey], previous[longKey]].every((v) => Number.isFinite(v) && v > 0)) throw new Error("TRANSITION_MA_MISSING");
  const gapPercent = (point) => (point[shortKey] / point[longKey] - 1) * 100;
  let aboveTradingDays = 0;
  for (let index = points.length - 1; index >= 0 && [points[index][shortKey], points[index][longKey]].every((v) => Number.isFinite(v) && v > 0) && points[index][shortKey] > points[index][longKey]; index -= 1) aboveTradingDays += 1;
  const crossIndex = points.length - aboveTradingDays;
  const crossObserved = aboveTradingDays > 0 && crossIndex > 0
    && [points[crossIndex - 1][shortKey], points[crossIndex - 1][longKey]].every((v) => Number.isFinite(v) && v > 0)
    && points[crossIndex - 1][shortKey] <= points[crossIndex - 1][longKey];
  const earlier = points.at(-3);
  const shortSlopePercent = (current[shortKey] / previous[shortKey] - 1) * 100;
  const earlierValid = earlier && [earlier[shortKey], earlier[longKey]].every((v) => Number.isFinite(v) && v > 0);
  const previousShortSlopePercent = earlierValid ? (previous[shortKey] / earlier[shortKey] - 1) * 100 : null;
  const approaching = earlierValid && [earlier, previous, current].every((p) => p[shortKey] < p[longKey])
    && Math.abs(gapPercent(current)) < Math.abs(gapPercent(previous))
    && Math.abs(gapPercent(previous)) < Math.abs(gapPercent(earlier))
    && shortSlopePercent > 0 && shortSlopePercent > previousShortSlopePercent;
  const crossedToday = previous[shortKey] <= previous[longKey] && current[shortKey] > current[longKey];
  return {
    status: crossedToday ? "CROSS_OCCURRED" : crossObserved && aboveTradingDays >= TRANSITION_RESEARCH_PROPOSAL.confirmationTradingDays ? "CONFIRMED" : approaching ? "APPROACHING" : "NONE",
    gapPercent: gapPercent(current), previousGapPercent: gapPercent(previous),
    shortSlopePercent, previousShortSlopePercent,
    crossDate: crossObserved ? points[crossIndex].date : null,
    aboveTradingDays, aboveDaysLowerBound: aboveTradingDays === points.length,
  };
}

export function buildTransitionRows({ history, seed, calendar }) {
  if (!history || !seed || seed.requestedDate !== history.asOfDate) throw new Error("TRANSITION_SEED_DATE_MISMATCH");
  const errors = validateIntradayMarketSeed(seed, history.records.length);
  if (errors.length) throw new Error("TRANSITION_SEED_INVALID");
  const sourceHash = history.sourceManifest?.sources?.officialDailyPrice?.normalizedInputHash;
  if (!sourceHash || sourceHash !== seed.sourceManifest?.sources?.officialDailyPrice?.normalizedInputHash) throw new Error("TRANSITION_SOURCE_MISMATCH");
  if (history.dataQuality?.structuralStatus !== "passed") throw new Error("TRANSITION_STRUCTURAL_QUALITY_FAILED");
  if (calendar?.dates?.[history.asOfDate]?.status !== "tradingDay") throw new Error("TRANSITION_TRADING_DATE_UNVERIFIED");
  const seeds = new Map(seed.records.map((r) => [r.code, r]));
  const historyByCode = new Map(history.records.map((r) => [r.code, r]));
  const observedDates = seed.records.filter((r) => r.eligible).flatMap((r) => r.rows.slice(0, 60).map((row) => row[0]));
  const oldest = [...observedDates].sort()[0];
  const knownDates = Object.entries(calendar.dates).filter(([date, value]) => value.status === "tradingDay" && date <= history.asOfDate && date.replaceAll("-", "") >= oldest).map(([date]) => date.replaceAll("-", ""));
  const expectedDates = [...new Set([...observedDates, ...knownDates])].sort().reverse().slice(0, 60);
  const baseRows = createScreeningRows(history, null);
  return baseRows.map((base) => {
    const input = seeds.get(base.code);
    const missingReasons = [];
    if (!base.qualityEligible) missingReasons.push("qualityIneligible");
    if (!input?.eligible) missingReasons.push("seedIneligible");
    if (input?.officialAsOfDate !== history.asOfDate || input?.rows?.[0]?.[0] !== history.asOfDate.replaceAll("-", "")) missingReasons.push("referenceDateMismatch");
    if (input?.sourceHash !== sourceHash) missingReasons.push("sourceMismatch");
    if (input?.eligible && expectedDates.some((date, index) => input.rows[index]?.[0] !== date)) missingReasons.push("missingTradingBar");
    const today = input?.rows?.[0];
    if (today && historyByCode.get(base.code)?.closePrice !== today[4]) missingReasons.push("officialCloseMismatch");
    if (today && today[5] === 0) missingReasons.push("noTradingVolume");
    if (input?.eligible && input.rows.slice(0, 60).some(([date]) => isWeekend(iso(date)) || calendar.dates?.[iso(date)]?.status === "marketClosed")) missingReasons.push("closedDateBar");
    const result = { code: base.code, name: base.name, market: base.market, referenceDate: base.referenceDate, models: base.models,
      qualityStatus: missingReasons.length ? "UNAVAILABLE" : "PARTIAL_VALIDATED", missingReasons,
      indicators: null, transitions: null, officialClosePrice: null,
    };
    if (missingReasons.length) return result;
    const rows = input.rows.map(([basDt, mkp, hipr, lopr, clpr, trqu]) => ({ basDt, mkp, hipr, lopr, clpr, trqu }));
    // Reuse the frozen market-analysis calculator; never score models again.
    const { indicators } = calculateMarketAnalysis(rows);
    const dates = input.rows.slice(0, indicators.chartData.length).map(([date]) => iso(date)).reverse();
    const points = indicators.chartData.map((point, index) => ({ ...point, date: dates[index] }));
    const transitions = Object.fromEntries(Object.keys(TRANSITION_PAIRS).map((pair) => [pair, observeMaTransition(points, pair)]));
    return { ...result, officialClosePrice: today[4], transitions,
      indicators: { ma5: finite(indicators.ma5), ma20: finite(indicators.ma20), ma60: finite(indicators.ma60), rsi: finite(indicators.rsi14),
        macdState: Number.isFinite(indicators.macd) && Number.isFinite(indicators.signal) ? indicators.macd > indicators.signal ? "rising" : indicators.macd < indicators.signal ? "falling" : "neutral" : null,
        macd: finite(indicators.macd), macdSignal: finite(indicators.signal), volumeMultiple: indicators.avgVolume20 > 0 ? finite(indicators.volumeRatio / 100) : null,
        dailyChangePercent: finite(indicators.dailyReturn) },
    };
  });
}

export function parseTransitionFilters(params) {
  const filters = { pair: params.get("pair") ?? "5-20", state: params.get("state") ?? "all", market: params.get("market") ?? "all", macd: params.get("macd") ?? "all", sort: params.get("sort") ?? "state", direction: params.get("direction") ?? "asc" };
  if (!Object.hasOwn(TRANSITION_PAIRS, filters.pair) || !["all", ...TRANSITION_STATUSES].includes(filters.state)
    || !["all", "KOSPI", "KOSDAQ"].includes(filters.market) || !["all", "rising", "falling", "neutral"].includes(filters.macd)
    || !["state", "gap", "volume", "score", "name"].includes(filters.sort) || !["asc", "desc"].includes(filters.direction)) throw new Error("TRANSITION_FILTER_INVALID");
  for (const key of ["rsiMin", "rsiMax", "volumeMin", "volumeMax", "changeMin", "changeMax", "scoreA", "scoreB", "scoreC", "scoreD"]) {
    const raw = params.get(key);
    if (raw !== null && raw.trim() !== "" && !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/u.test(raw.trim())) throw new Error("TRANSITION_FILTER_INVALID");
    filters[key] = raw === null || raw.trim() === "" ? null : Number(raw);
    if (filters[key] !== null && (!Number.isFinite(filters[key]) || (key.startsWith("rsi") && (filters[key] < 0 || filters[key] > 100)) || (key.startsWith("volume") && filters[key] < 0))) throw new Error("TRANSITION_FILTER_INVALID");
  }
  for (const [min, max] of [["rsiMin", "rsiMax"], ["volumeMin", "volumeMax"], ["changeMin", "changeMax"]]) if (filters[min] !== null && filters[max] !== null && filters[min] > filters[max]) throw new Error("TRANSITION_FILTER_INVALID");
  const model = params.get("model") ?? "A-v1";
  if (!Object.hasOwn(SCREENING_MODELS, model)) throw new Error("TRANSITION_FILTER_INVALID");
  return { ...filters, model };
}

export function screenTransitions(rows, filters) {
  const exclusions = { dataMissing: 0, filterMissing: 0, conditionNotMet: 0 };
  const reasonCounts = {};
  const results = [];
  for (const row of rows) {
    if (row.missingReasons.length) {
      exclusions.dataMissing += 1;
      for (const reason of row.missingReasons) reasonCounts[reason] = (reasonCounts[reason] ?? 0) + 1;
      continue;
    }
    const i = row.indicators, transition = row.transitions[filters.pair];
    const required = [];
    const checks = [];
    const range = (value, min, max) => {
      if (min === null && max === null) return;
      if (!Number.isFinite(value)) required.push("indicatorMissing");
      else checks.push((min === null || value >= min) && (max === null || value <= max));
    };
    range(i.rsi, filters.rsiMin, filters.rsiMax);
    range(i.volumeMultiple, filters.volumeMin, filters.volumeMax);
    range(i.dailyChangePercent, filters.changeMin, filters.changeMax);
    for (const letter of ["A", "B", "C", "D"]) range(row.models[`${letter}-v1`]?.score, filters[`score${letter}`], null);
    if (filters.macd !== "all") { if (i.macdState === null) required.push("macdMissing"); else checks.push(i.macdState === filters.macd); }
    if (required.length) { exclusions.filterMissing += 1; continue; }
    if ((filters.market !== "all" && row.market !== filters.market) || (filters.state !== "all" && transition.status !== filters.state) || checks.some((check) => !check)) { exclusions.conditionNotMet += 1; continue; }
    results.push({ ...row, pair: filters.pair, ...transition, selectedModel: filters.model, score: row.models[filters.model]?.score ?? null,
      observationId: sha256Canonical({ signalDate: row.referenceDate, ticker: row.code, pair: filters.pair, ruleVersion: TRANSITION_RULE_VERSION }),
    });
  }
  results.sort((a, b) => {
    const value = (r) => filters.sort === "gap" ? Math.abs(r.gapPercent) : filters.sort === "volume" ? r.indicators.volumeMultiple : filters.sort === "score" ? r.score : filters.sort === "state" ? TRANSITION_STATUSES.indexOf(r.status) : r.name;
    const left = value(a), right = value(b);
    if (left === null || right === null) return left === right ? a.code.localeCompare(b.code) : left === null ? 1 : -1;
    const comparison = typeof left === "string" ? left.localeCompare(right, "ko") : left - right;
    return (filters.direction === "desc" ? -comparison : comparison) || a.code.localeCompare(b.code);
  });
  return { results, exclusions, reasonCounts };
}

// Separate namespace, deterministic export contract only. GET never persists observations.
export function createTransitionObservationSnapshot({ rows, history, seed }) {
  const base = { schemaVersion: 1, dataset: "transition-signal-observations", layer: "DAILY_EOD_TRANSITION", ruleVersion: TRANSITION_RULE_VERSION,
    signalDate: history.asOfDate, priceBasis: "officialDailyClose", sourceAvailability: history.sourceManifest?.sources?.officialDailyPrice?.availability ?? null,
    source: { seedContentHash: seed.contentHash, dailyPriceInputHash: seed.sourceManifest.sources.officialDailyPrice.normalizedInputHash, modelFormulaHashes: history.sourceManifest?.modelFormulaHashes ?? null },
    records: rows.filter((r) => !r.missingReasons.length).map((r) => ({ code: r.code, name: r.name, market: r.market, signalDate: r.referenceDate, referenceDate: r.referenceDate, qualityStatus: r.qualityStatus, officialClosePrice: r.officialClosePrice, indicators: r.indicators, models: r.models, transitions: r.transitions,
      observationIds: Object.fromEntries(Object.keys(TRANSITION_PAIRS).map((pair) => [pair, sha256Canonical({ signalDate: r.referenceDate, ticker: r.code, pair, ruleVersion: TRANSITION_RULE_VERSION })])),
    })).sort((a, b) => a.code.localeCompare(b.code)),
    futureOutcomes: { namespace: "transition-outcomes", horizons: ["1D", "5D", "20D"], status: "NOT_OBSERVED", entryContract: null },
  };
  return { ...base, contentHash: sha256Canonical(base) };
}
