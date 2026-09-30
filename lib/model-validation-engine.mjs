import { createRankingCoverage } from "./snapshot-quality-pipeline.mjs";
import { HORIZONS, MODEL_VERSIONS, hashObject, scoreRank } from "./rank-backtest-engine.mjs";

export const VALIDATION_SUFFICIENCY = Object.freeze({
  NONE: "NO_RESOLVED_OUTCOMES",
  INSUFFICIENT: "INSUFFICIENT_SIGNAL_DAYS",
  READY: "VALIDATION_WINDOW_READY",
});

const finite = (value) => typeof value === "number" && Number.isFinite(value);
const mean = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const median = (values) => { if (!values.length) return null; const ordered = [...values].sort((a, b) => a - b); const middle = Math.floor(ordered.length / 2); return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2; };
const dispersion = (values) => { const average = mean(values); return average == null ? null : Math.sqrt(mean(values.map((value) => (value - average) ** 2))); };
const round = (value) => finite(value) ? Number(value.toFixed(10)) : null;
const eligibleByQuality = (record) => record.qualityEligibility?.eligible !== false && record.qualityEligibility?.status !== "quarantined";

function averageRanks(values) {
  const ordered = values.map((value, index) => ({ value, index })).sort((left, right) => left.value - right.value || left.index - right.index);
  const ranks = Array(values.length); let cursor = 0;
  while (cursor < ordered.length) {
    let end = cursor + 1; while (end < ordered.length && ordered[end].value === ordered[cursor].value) end += 1;
    const averageRank = ((cursor + 1) + end) / 2;
    for (let index = cursor; index < end; index += 1) ranks[ordered[index].index] = averageRank;
    cursor = end;
  }
  return ranks;
}

function pearson(left, right) {
  const leftMean = mean(left), rightMean = mean(right);
  const numerator = left.reduce((sum, value, index) => sum + (value - leftMean) * (right[index] - rightMean), 0);
  const leftScale = Math.sqrt(left.reduce((sum, value) => sum + (value - leftMean) ** 2, 0));
  const rightScale = Math.sqrt(right.reduce((sum, value) => sum + (value - rightMean) ** 2, 0));
  return leftScale > 0 && rightScale > 0 ? numerator / (leftScale * rightScale) : null;
}

export function spearmanRankIc(pairs, minimumPairs = 3) {
  if (!pairs.length) return { status: "NO_RESOLVED_OUTCOMES", pairCount: 0, value: null };
  if (pairs.length < minimumPairs) return { status: "INSUFFICIENT_PAIRS", pairCount: pairs.length, value: null };
  const value = pearson(averageRanks(pairs.map((pair) => pair.score)), averageRanks(pairs.map((pair) => pair.futureReturn)));
  return { status: value == null ? "CONSTANT_SERIES" : "CALCULATED", pairCount: pairs.length, value: round(value) };
}

function topNMetrics(pairs, sizes) {
  return Object.fromEntries(sizes.map((size) => {
    const selected = pairs.slice(0, Math.min(size, pairs.length));
    const values = selected.map((pair) => pair.futureReturn);
    return [`TOP${size}`, { requestedCount: size, constituentCount: selected.length, meanReturn: round(mean(values)), medianReturn: round(median(values)) }];
  }));
}

function decileMetrics(pairs) {
  if (pairs.length < 10) return { status: "INSUFFICIENT_UNIVERSE", requestedBucketCount: 10, pairCount: pairs.length, buckets: [] };
  const buckets = Array.from({ length: 10 }, (_, index) => ({ decile: index + 1, label: index === 0 ? "TOP_DECILE" : index === 9 ? "BOTTOM_DECILE" : `DECILE_${index + 1}`, values: [] }));
  pairs.forEach((pair, index) => buckets[Math.floor(index * 10 / pairs.length)].values.push(pair.futureReturn));
  return { status: "CALCULATED", requestedBucketCount: 10, pairCount: pairs.length, buckets: buckets.map(({ values, ...bucket }) => ({ ...bucket, count: values.length, meanReturn: round(mean(values)), medianReturn: round(median(values)) })) };
}

function spreadMetrics(deciles) {
  if (deciles.status !== "CALCULATED") return { status: deciles.status, meanReturnSpread: null, medianReturnSpread: null };
  const top = deciles.buckets[0], bottom = deciles.buckets.at(-1);
  return { status: "CALCULATED", basis: "topDecileMinusBottomDecile", benchmark: null, excessReturn: null, meanReturnSpread: round(top.meanReturn - bottom.meanReturn), medianReturnSpread: round(top.medianReturn - bottom.medianReturn) };
}

function pairsFor(snapshot, modelVersion, horizon, commonModels = null) {
  const returnKey = HORIZONS[horizon].predictive;
  return snapshot.records.map((record) => {
    if (!eligibleByQuality(record)) return null;
    if (commonModels && !commonModels.every((version) => scoreRank(snapshot, record, version))) return null;
    const meta = scoreRank(snapshot, record, modelVersion), futureReturn = record.futureReturns?.[returnKey];
    return meta && finite(futureReturn) ? { code: record.code, score: meta.score, rank: meta.rank, futureReturn } : null;
  }).filter(Boolean).sort((left, right) => left.rank - right.rank || left.code.localeCompare(right.code));
}

function dateMetric({ date, snapshot, modelVersion, horizon, universeType, models, topSizes }) {
  const allRanked = snapshot.records.filter((record) => eligibleByQuality(record) && scoreRank(snapshot, record, modelVersion));
  const evaluationUniverse = universeType === "commonComparisonUniverse"
    ? snapshot.records.filter((record) => eligibleByQuality(record) && models.every((version) => scoreRank(snapshot, record, version)))
    : allRanked;
  const pairs = pairsFor(snapshot, modelVersion, horizon, universeType === "commonComparisonUniverse" ? models : null);
  const coverage = createRankingCoverage(snapshot, modelVersion, allRanked.length);
  const deciles = decileMetrics(pairs);
  return {
    signalDate: date, modelVersion, horizon, universeType,
    status: pairs.length ? "RESOLVED_CROSS_SECTION" : "NO_RESOLVED_OUTCOMES",
    coverage: { ...coverage, evaluationUniverseCount: evaluationUniverse.length, evaluationUniverseHash: hashObject(evaluationUniverse.map((record) => record.code).sort()), resolvedPairCount: pairs.length, unresolvedRankingCount: Math.max(0, evaluationUniverse.length - pairs.length), resolvedPairRatio: evaluationUniverse.length ? round(pairs.length / evaluationUniverse.length) : null },
    rankIc: spearmanRankIc(pairs), topN: topNMetrics(pairs, topSizes), deciles,
    universeRelativeSpread: spreadMetrics(deciles), benchmark: null, excessReturn: null,
  };
}

function summarize(values) { const finiteValues = values.filter(finite); return { count: finiteValues.length, mean: round(mean(finiteValues)), median: round(median(finiteValues)), dispersion: round(dispersion(finiteValues)), min: finiteValues.length ? Math.min(...finiteValues) : null, max: finiteValues.length ? Math.max(...finiteValues) : null }; }

function aggregate(metrics, minimumSignalDays, topSizes) {
  const resolved = metrics.filter((metric) => metric.coverage.resolvedPairCount > 0);
  const icValues = resolved.map((metric) => metric.rankIc.value).filter(finite);
  const status = resolved.length === 0 ? VALIDATION_SUFFICIENCY.NONE : resolved.length < minimumSignalDays ? VALIDATION_SUFFICIENCY.INSUFFICIENT : VALIDATION_SUFFICIENCY.READY;
  return {
    modelVersion: metrics[0].modelVersion, horizon: metrics[0].horizon, universeType: metrics[0].universeType,
    sampleSufficiencyStatus: status, minimumSignalDays, resolvedSignalDateCount: resolved.length,
    rankIc: { ...summarize(icValues), positiveDateRatio: icValues.length ? round(icValues.filter((value) => value > 0).length / icValues.length) : null },
    topN: Object.fromEntries(topSizes.map((size) => [`TOP${size}`, { dailyMeanReturn: summarize(resolved.map((metric) => metric.topN[`TOP${size}`].meanReturn)), dailyMedianReturn: summarize(resolved.map((metric) => metric.topN[`TOP${size}`].medianReturn)) }])),
    universeRelativeSpread: { dailyMeanSpread: summarize(resolved.map((metric) => metric.universeRelativeSpread.meanReturnSpread)), dailyMedianSpread: summarize(resolved.map((metric) => metric.universeRelativeSpread.medianReturnSpread)), benchmark: null, excessReturn: null },
    coverage: { signalDateCount: metrics.length, resolvedSignalDateCount: resolved.length, resolvedPairCount: resolved.reduce((sum, metric) => sum + metric.coverage.resolvedPairCount, 0), resolvedPairRatioByDate: summarize(resolved.map((metric) => metric.coverage.resolvedPairRatio)) },
    conclusion: null,
  };
}

export function buildModelValidation({ snapshots, models = MODEL_VERSIONS, horizons = Object.keys(HORIZONS), minimumSignalDays = 60, topSizes = [5, 10, 20], generatedAt = "1970-01-01T00:00:00.000Z" }) {
  const ordered = [...snapshots].sort((left, right) => left.date.localeCompare(right.date));
  const dailyMetrics = [];
  for (const { date, snapshot } of ordered) for (const modelVersion of models) for (const horizon of horizons) for (const universeType of ["nativeUniverse", "commonComparisonUniverse"]) dailyMetrics.push(dateMetric({ date, snapshot, modelVersion, horizon, universeType, models, topSizes }));
  const periodAggregates = [];
  for (const modelVersion of models) for (const horizon of horizons) for (const universeType of ["nativeUniverse", "commonComparisonUniverse"]) periodAggregates.push(aggregate(dailyMetrics.filter((metric) => metric.modelVersion === modelVersion && metric.horizon === horizon && metric.universeType === universeType), minimumSignalDays, topSizes));
  const base = { schemaVersion: 1, engineVersion: "model-validation-v1", generatedAt, modelVersions: models, horizons, policies: { baseUnit: "signalDateCrossSection", spearmanTiePolicy: "averageRank", quantileCount: 10, quantileBoundaryPolicy: "frozenRankThenCodeBalancedBuckets", minimumSpearmanPairs: 3, minimumSignalDays, benchmark: null, excessReturn: null, conclusionBeforeReady: null }, inputSignalDates: ordered.map((item) => item.date), dailyMetrics, periodAggregates };
  return { ...base, contentHash: hashObject({ ...base, generatedAt: null }) };
}
