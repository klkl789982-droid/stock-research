import { createScreeningRows, SCREENING_MODELS } from "./stock-screener.mjs";
import { TRANSITION_RULE_VERSION, TRANSITION_PAIRS, TRANSITION_STATUSES } from "./transition-rule-policy.mjs";

export const HOME_MODELS = Object.keys(SCREENING_MODELS);
const ranked = (rows, model) => rows.filter((r) => r.qualityEligible && Number.isFinite(r.models[model]?.score) && Number.isInteger(r.models[model]?.rank) && r.models[model].rank > 0);
const stock = (row, model) => ({ code: row.code, name: row.name, rank: row.models[model].rank, score: row.models[model].score });

// Frozen native ranks only. A universe change is not a technical TOP entry/exit.
export function summarizeModelChanges(current, previous, previousOfficialDate, topN = 5) {
  if (![5, 10, 20].includes(topN)) throw new Error("HOME_TOP_N_INVALID");
  const currentRows = createScreeningRows(current, null), previousRows = previous ? createScreeningRows(previous, null) : [];
  const models = HOME_MODELS.map((model) => {
    const now = ranked(currentRows, model), before = ranked(previousRows, model);
    const top = now.filter((r) => r.models[model].rank <= topN).sort((a, b) => a.models[model].rank - b.models[model].rank || a.code.localeCompare(b.code));
    const currentHash = current.modelVersionDefinitions?.[model]?.formulaHash ?? current.sourceManifest?.modelFormulaHashes?.[model] ?? null;
    const previousHash = previous?.modelVersionDefinitions?.[model]?.formulaHash ?? previous?.sourceManifest?.modelFormulaHashes?.[model] ?? null;
    const previousAvailable = previous && previous.asOfDate === previousOfficialDate && previous.dataQuality?.structuralStatus === "passed";
    const formulaMatches = currentHash && previousHash && currentHash === previousHash;
    const comparable = previousAvailable && formulaMatches;
    const oldMap = new Map(before.map((r) => [r.code, r])), nowMap = new Map(now.map((r) => [r.code, r]));
    const common = new Set(now.filter((r) => oldMap.has(r.code)).map((r) => r.code));
    const priorTop = before.filter((r) => r.models[model].rank <= topN);
    return { modelVersion: model, top: top.map((r) => stock(r, model)), rankingUniverseCount: now.length,
      comparisonStatus: comparable ? "AVAILABLE" : "UNAVAILABLE", previousDate: previousOfficialDate,
      comparisonReason: comparable ? null : previousAvailable ? "FORMULA_PROVENANCE_CHANGED_OR_MISSING" : "PREVIOUS_TRADING_SNAPSHOT_MISSING_OR_INVALID",
      commonUniverseCount: comparable ? common.size : null,
      entered: comparable ? top.filter((r) => common.has(r.code) && oldMap.get(r.code).models[model].rank > topN).map((r) => stock(r, model)) : null,
      exited: comparable ? priorTop.filter((r) => common.has(r.code) && nowMap.get(r.code).models[model].rank > topN).map((r) => ({ ...stock(r, model), currentRank: nowMap.get(r.code).models[model].rank })) : null,
      risers: comparable ? top.filter((r) => common.has(r.code) && r.models[model].rank < oldMap.get(r.code).models[model].rank).map((r) => ({ ...stock(r, model), previousRank: oldMap.get(r.code).models[model].rank, rankRise: oldMap.get(r.code).models[model].rank - r.models[model].rank })) : null,
      universeAddedTop: comparable ? top.filter((r) => !common.has(r.code)).map((r) => stock(r, model)) : null,
      universeRemovedTop: comparable ? priorTop.filter((r) => !common.has(r.code)).map((r) => stock(r, model)) : null,
    };
  });
  const appearances = new Map();
  for (const model of models) for (const row of model.top) {
    if (!appearances.has(row.code)) appearances.set(row.code, { code: row.code, name: row.name, models: [] });
    appearances.get(row.code).models.push(model.modelVersion);
  }
  return { layer: "DAILY_EOD", referenceDate: current.asOfDate, previousOfficialDate, topN, models,
    overlap: [...appearances.values()].filter((r) => r.models.length > 1).sort((a, b) => b.models.length - a.models.length || a.code.localeCompare(b.code)) };
}

export function summarizeTransitions(data, modelSummary) {
  const available = data.rows.filter((r) => !r.missingReasons.length);
  const topModels = new Map();
  if (modelSummary?.referenceDate === data.referenceDate) for (const model of modelSummary.models) for (const row of model.top) {
    if (!topModels.has(row.code)) topModels.set(row.code, []);
    topModels.get(row.code).push(model.modelVersion);
  }
  return { referenceDate: data.referenceDate, ruleVersion: TRANSITION_RULE_VERSION, researchOnly: true,
    indicatorCoverage: available.length, totalUniverse: data.rows.length, excludedCount: data.rows.length - available.length,
    sourceQualityGrade: data.sourceQualityGrade, isPartialRanking: data.isPartialRanking,
    pairs: Object.keys(TRANSITION_PAIRS).map((pair) => ({ pair,
      states: TRANSITION_STATUSES.filter((state) => state !== "NONE").map((state) => {
        const matches = available.filter((r) => r.transitions[pair].status === state);
        return { state, count: matches.length,
          examples: [...matches].sort((a, b) => Math.abs(a.transitions[pair].gapPercent) - Math.abs(b.transitions[pair].gapPercent) || a.code.localeCompare(b.code)).slice(0, 3).map((r) => ({ code: r.code, name: r.name, gapPercent: r.transitions[pair].gapPercent, shortSlopePercent: r.transitions[pair].shortSlopePercent, crossDate: r.transitions[pair].crossDate, aboveTradingDays: r.transitions[pair].aboveTradingDays, topModels: topModels.get(r.code) ?? [] })) };
      }) })),
  };
}

// Select the latest resolved *cross-section*, never relabel pooled performance.
export function latestOneDayPerformance(performance, topN = 5) {
  const summarize = (layer) => HOME_MODELS.map((model) => {
    const row = (layer?.daily ?? []).filter((r) => r.modelVersion === model && r.topN === topN && r.horizon === "1DAY" && r.observationCount > 0 && Number.isFinite(r.meanReturn)).sort((a, b) => b.signalDate.localeCompare(a.signalDate)).at(0);
    return row ? { modelVersion: model, signalDate: row.signalDate, resultDate: row.targetTradingDate, meanReturn: row.meanReturn, positiveRate: row.positiveRate, observationCount: row.observationCount, rankedConstituentCount: row.rankedConstituentCount } : { modelVersion: model, meanReturn: null, positiveRate: null, observationCount: 0, signalDate: null, resultDate: null };
  });
  return { topN, daily: summarize(performance), live: summarize(performance?.live) };
}

export function calendarContext(calendar, now = new Date()) {
  const kst = new Date(now.getTime() + 9 * 3600000).toISOString();
  const today = kst.slice(0, 10), time = kst.slice(11, 19);
  const weekend = (date) => [0, 6].includes(new Date(`${date}T00:00:00Z`).getUTCDay());
  const dayStatus = weekend(today) ? "marketClosed" : calendar?.dates?.[today]?.status ?? "unchecked";
  let expectedTradingDate = null;
  if (dayStatus === "tradingDay") expectedTradingDate = today;
  if (dayStatus === "marketClosed") {
    const cursor = new Date(`${today}T00:00:00Z`);
    for (let i = 0; i < 15; i += 1) {
      cursor.setUTCDate(cursor.getUTCDate() - 1);
      const date = cursor.toISOString().slice(0, 10);
      if (weekend(date) || calendar?.dates?.[date]?.status === "marketClosed") continue;
      if (calendar?.dates?.[date]?.status === "tradingDay") expectedTradingDate = date;
      break; // Unknown weekdays are not invented holidays.
    }
  }
  return { today, time, dayStatus, expectedTradingDate };
}

export function dailyOperationState(status, context) {
  if (!status) return "UNKNOWN";
  if (status.runStatus === "FAILED" || (status.recentFailureReason && status.lastFailureAt && (!status.lastSuccessAt || status.lastFailureAt > status.lastSuccessAt))) return "FAILED";
  if (status.siteApiMatchesPublished === false || status.publicationStatus === "mismatch") return "DELAYED";
  if (status.freshnessStatus === "stale" || status.lagTradingDays > 0) return "DELAYED";
  if (!context?.expectedTradingDate) return "UNKNOWN";
  if (status.siteApiReferenceDate && status.siteApiReferenceDate < context.expectedTradingDate) return context.dayStatus === "tradingDay" && context.time < "20:30:00" ? "WAITING" : "DELAYED";
  return status.freshnessStatus === "fresh" && status.siteApiMatchesPublished === true && status.publicationStatus === "published" ? "NORMAL" : "UNKNOWN";
}
