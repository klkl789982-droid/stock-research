import { normalizeStockCode } from "./stock-code.mjs";

export const MODEL_PERFORMANCE_MODELS = ["A-v1", "B-v1", "C-v1", "D-v1"];
export const MODEL_PERFORMANCE_TOP_SIZES = [5, 10, 20];
export const MODEL_PERFORMANCE_HORIZONS = ["1DAY", "5DAY", "20DAY", "60DAY"];
export const INTRADAY_MODEL_PERFORMANCE_HORIZONS = ["1DAY", "5DAY", "20DAY", "60DAY"];

const scoreAndRank = (record, model) => {
  if (model === "A-v1") return {
    score: record.scoresByVersion?.[model] ?? record.scores?.modelA,
    rank: record.ranksByVersion?.[model] ?? record.ranks?.modelA,
  };
  const key = { "B-v1": "modelB", "C-v1": "modelC", "D-v1": "modelD" }[model];
  return { score: record.scores?.[key], rank: record.ranks?.[key] };
};

const calculateMetrics = (returns) => {
  const ordered = returns.filter(Number.isFinite).sort((left, right) => left - right);
  const observationCount = ordered.length;
  if (observationCount === 0) return { observationCount: 0, meanReturn: null, medianReturn: null, positiveRate: null, minReturn: null, maxReturn: null };
  const median = observationCount % 2 ? ordered[(observationCount - 1) / 2] : (ordered[observationCount / 2 - 1] + ordered[observationCount / 2]) / 2;
  return {
    observationCount,
    meanReturn: Number((ordered.reduce((sum, item) => sum + item, 0) / observationCount).toFixed(6)),
    medianReturn: Number(median.toFixed(6)),
    positiveRate: Number((ordered.filter((item) => item > 0).length / observationCount * 100).toFixed(4)),
    minReturn: ordered[0],
    maxReturn: ordered.at(-1),
  };
};

// Extrema are individual ticker/signal observations, not portfolio returns.
// Equal returns select the earliest signal date, then normalized ticker (stable ties).
const calculateObservationMetrics = (observations) => {
  const finite = observations.filter((item) => Number.isFinite(item.returnPercent));
  const metrics = calculateMetrics(finite.map((item) => item.returnPercent));
  const ordered = [...finite].sort((left, right) => left.signalDate.localeCompare(right.signalDate)
    || left.ticker.localeCompare(right.ticker));
  return {
    ...metrics,
    uniqueSignalDateCount: new Set(finite.map((item) => item.signalDate)).size,
    uniqueStockCount: new Set(finite.map((item) => item.ticker)).size,
    minObservation: ordered.find((item) => item.returnPercent === metrics.minReturn) ?? null,
    maxObservation: ordered.find((item) => item.returnPercent === metrics.maxReturn) ?? null,
  };
};

const dailyObservation = (record, resolved, outcome) => ({
  ticker: normalizeStockCode(record.code),
  companyName: record.name ?? null,
  signalDate: outcome.signalDate,
  signalTime: null,
  // Daily predictive returns use the frozen signal close, not a tradable entry.
  entryDate: outcome.signalDate,
  entryPriceBasis: "signalDayOfficialClose",
  evaluationEndDate: "targetTradingDate" in resolved ? resolved.targetTradingDate : outcome.targetTradingDate ?? null,
  returnPercent: resolved.returnPercent,
  source: { dataset: outcome.dataset ?? null, contentHash: outcome.contentHash ?? outcome.sourceSnapshotHash ?? null },
});

const liveObservation = (record, outcome, horizon) => ({
  ticker: normalizeStockCode(record.ticker),
  companyName: record.companyName ?? null,
  signalDate: outcome.signalDate,
  signalTime: outcome.signalTime ?? null,
  entryDate: record.entry?.tradingDate ?? null,
  entryPriceBasis: record.entry?.priceBasis ?? null,
  evaluationEndDate: record.horizons[horizon].targetTradingDate ?? null,
  returnPercent: record.horizons[horizon].returnPercent,
  source: { dataset: outcome.dataset ?? null, contentHash: outcome.contentHash ?? null },
});

const selectedLiveRecord = (record, modelVersion, topN) => record.modelVersion === modelVersion
  && Number.isInteger(record.rank) && record.rank > 0 && record.rank <= topN;
const matureLiveReturn = (value) => value?.status === "MATURE" && Number.isFinite(value.returnPercent);

export function buildIntradayModelTopPerformance({ outcomes }) {
  outcomes = [...new Map((outcomes ?? []).map((outcome) => [outcome.signalDate, outcome])).values()];
  const daily = [];
  for (const outcome of outcomes) {
    for (const modelVersion of MODEL_PERFORMANCE_MODELS) for (const topN of MODEL_PERFORMANCE_TOP_SIZES) for (const horizon of INTRADAY_MODEL_PERFORMANCE_HORIZONS) {
      const ranked = (outcome.records ?? []).filter((record) => selectedLiveRecord(record, modelVersion, topN));
      const mature = ranked.filter((record) => matureLiveReturn(record.horizons?.[horizon]));
      if (mature.length === 0) continue;
      daily.push({ modelVersion, horizon, signalDate: outcome.signalDate, targetTradingDate: mature.map((record) => record.horizons[horizon].targetTradingDate).filter(Boolean).sort().at(-1) ?? null, topN, rankedConstituentCount: ranked.length, coverageRate: Number((mature.length / ranked.length * 100).toFixed(4)), ...calculateObservationMetrics(mature.map((record) => liveObservation(record, outcome, horizon))) });
    }
  }
  const summary = MODEL_PERFORMANCE_MODELS.map((modelVersion) => ({ modelVersion, groups: MODEL_PERFORMANCE_TOP_SIZES.map((topN) => ({ topN, horizons: INTRADAY_MODEL_PERFORMANCE_HORIZONS.map((horizon) => {
    const ranked = outcomes.flatMap((outcome) => (outcome.records ?? []).filter((record) => selectedLiveRecord(record, modelVersion, topN)).map((record) => ({ signalDate: outcome.signalDate, record, outcome })));
    const mature = ranked.filter(({ record }) => matureLiveReturn(record.horizons?.[horizon]));
    const maturity = Object.fromEntries(["PENDING", "MATURE", "DATA_MISSING"].map((status) => [status, ranked.filter(({ record }) => record.horizons?.[horizon]?.status === status).length]));
    const observations = mature.map(({ record, outcome }) => liveObservation(record, outcome, horizon));
    return { horizon, status: observations.length ? "DATA_AVAILABLE" : "ACCUMULATING", signalDateCount: new Set(ranked.map(({ signalDate }) => signalDate)).size, evaluatedSignalDates: new Set(mature.map(({ signalDate }) => signalDate)).size, expectedObservationCount: ranked.length, coverageRate: ranked.length ? Number((mature.length / ranked.length * 100).toFixed(4)) : null, maturity, ...calculateObservationMetrics(observations) };
  }) })) }));
  const matureSignalDates = [...new Set(daily.map((row) => row.signalDate))].sort();
  const targetDates = daily.map((row) => row.targetTradingDate).filter(Boolean).sort();
  return { schemaVersion: 1, dataset: "intraday-model-top-performance", layer: "INTRADAY_1430_LIVE", executionPolicyId: outcomes[0]?.executionPolicy?.policyId ?? "intraday-1430-t1-open-v1", availableHorizons: INTRADAY_MODEL_PERFORMANCE_HORIZONS.filter((horizon) => daily.some((row) => row.horizon === horizon)), matureSignalDates, signalDateRange: matureSignalDates.length ? { from: matureSignalDates[0], to: matureSignalDates.at(-1) } : null, lastOutcomeDate: targetDates.at(-1) ?? null, totalOutcomeObservationCount: outcomes.reduce((sum, outcome) => sum + (outcome.records ?? []).reduce((count, record) => count + INTRADAY_MODEL_PERFORMANCE_HORIZONS.filter((horizon) => matureLiveReturn(record.horizons?.[horizon])).length, 0), 0), daily, summary };
}

const createOutcomeMaps = (outcomesByHorizon) => new Map(MODEL_PERFORMANCE_HORIZONS.map((horizon) => [
  horizon,
  new Map((outcomesByHorizon?.[horizon] ?? []).map((outcome) => [outcome.signalDate, outcome])),
]));

export function buildModelTopPerformance({ snapshots, outcomesByHorizon = {}, outcomes = null }) {
  const normalizedOutcomes = outcomes ? { ...outcomesByHorizon, "1DAY": outcomes } : outcomesByHorizon;
  const outcomesForHorizon = createOutcomeMaps(normalizedOutcomes);
  const snapshotByDate = new Map(snapshots.map((snapshot) => [snapshot.asOfDate, snapshot]));
  const daily = [];

  for (const horizon of MODEL_PERFORMANCE_HORIZONS) {
    for (const [signalDate, outcome] of outcomesForHorizon.get(horizon)) {
      const snapshot = snapshotByDate.get(signalDate);
      if (!snapshot) continue;
      const returnByCode = new Map((outcome.records ?? [])
        .filter((record) => record.status === "MATURE" && Number.isFinite(record.returnPercent))
        .map((record) => [normalizeStockCode(record.ticker), record]));
      if (returnByCode.size === 0) continue;
      for (const modelVersion of MODEL_PERFORMANCE_MODELS) for (const topN of MODEL_PERFORMANCE_TOP_SIZES) {
        const ranked = snapshot.records
          .map((record) => ({ record, ...scoreAndRank(record, modelVersion) }))
          .filter((item) => Number.isFinite(item.score) && Number.isInteger(item.rank) && item.rank > 0 && item.rank <= topN)
          .sort((left, right) => left.rank - right.rank || left.record.code.localeCompare(right.record.code));
        const observations = ranked.flatMap(({ record }) => {
          const resolved = returnByCode.get(normalizeStockCode(record.code));
          return resolved ? [dailyObservation(record, resolved, outcome)] : [];
        });
        if (observations.length === 0) continue;
        daily.push({ modelVersion, horizon, signalDate, targetTradingDate: outcome.targetTradingDate ?? null, topN, rankedConstituentCount: ranked.length, ...calculateObservationMetrics(observations) });
      }
    }
  }

  daily.sort((left, right) => left.signalDate.localeCompare(right.signalDate)
    || left.modelVersion.localeCompare(right.modelVersion)
    || MODEL_PERFORMANCE_HORIZONS.indexOf(left.horizon) - MODEL_PERFORMANCE_HORIZONS.indexOf(right.horizon)
    || left.topN - right.topN);

  const summary = MODEL_PERFORMANCE_MODELS.map((modelVersion) => ({
    modelVersion,
    groups: MODEL_PERFORMANCE_TOP_SIZES.map((topN) => ({
      topN,
      horizons: MODEL_PERFORMANCE_HORIZONS.map((horizon) => {
        const rows = daily.filter((row) => row.modelVersion === modelVersion && row.topN === topN && row.horizon === horizon);
        const signalDates = [...new Set(rows.map((row) => row.signalDate))];
        const observations = [];
        for (const signalDate of signalDates) {
          const snapshot = snapshotByDate.get(signalDate);
          const outcome = outcomesForHorizon.get(horizon).get(signalDate);
          const returnByCode = new Map((outcome?.records ?? [])
            .filter((record) => record.status === "MATURE" && Number.isFinite(record.returnPercent))
            .map((record) => [normalizeStockCode(record.ticker), record]));
          for (const record of snapshot?.records ?? []) {
            const { score, rank } = scoreAndRank(record, modelVersion);
            const resolved = returnByCode.get(normalizeStockCode(record.code));
            if (Number.isFinite(score) && Number.isInteger(rank) && rank > 0 && rank <= topN && resolved) observations.push(dailyObservation(record, resolved, outcome));
          }
        }
        return { horizon, status: observations.length > 0 ? "DATA_AVAILABLE" : "ACCUMULATING", evaluatedSignalDates: signalDates.length, ...calculateObservationMetrics(observations) };
      }),
    })),
  }));

  const matureSignalDatesByHorizon = Object.fromEntries(MODEL_PERFORMANCE_HORIZONS.map((horizon) => [horizon, [...new Set(daily.filter((row) => row.horizon === horizon).map((row) => row.signalDate))].sort()]));
  const matureSignalDates = [...new Set(daily.map((row) => row.signalDate))].sort();
  const targetDates = daily.map((row) => row.targetTradingDate).filter(Boolean).sort();
  const totalOutcomeObservationCount = MODEL_PERFORMANCE_HORIZONS.reduce((total, horizon) => total + [...outcomesForHorizon.get(horizon).values()].reduce((sum, outcome) => sum + (outcome.records ?? []).filter((record) => record.status === "MATURE" && Number.isFinite(record.returnPercent)).length, 0), 0);

  return {
    schemaVersion: 2,
    dataset: "model-top-performance",
    returnDefinitions: Object.fromEntries(MODEL_PERFORMANCE_HORIZONS.map((horizon) => [horizon, normalizedOutcomes[horizon]?.[0]?.returnDefinition ?? null])),
    availableHorizons: MODEL_PERFORMANCE_HORIZONS.filter((horizon) => matureSignalDatesByHorizon[horizon].length > 0),
    matureSignalDates,
    matureSignalDatesByHorizon,
    signalDateRange: matureSignalDates.length ? { from: matureSignalDates[0], to: matureSignalDates.at(-1) } : null,
    lastOutcomeDate: targetDates.at(-1) ?? null,
    totalOutcomeObservationCount,
    daily,
    summary,
  };
}
