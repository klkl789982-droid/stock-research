import { normalizeStockCode } from "./stock-code.mjs";

const MODELS = ["A-v1", "A-v2", "B-v1", "C-v1", "D-v1"];
const SIZES = [5, 10, 20];
const value = (record, model) => {
  if (model === "A-v1") return { score: record.scoresByVersion?.[model] ?? record.scores?.modelA, rank: record.ranksByVersion?.[model] ?? record.ranks?.modelA };
  if (model === "A-v2") return { score: record.scoresByVersion?.[model], rank: record.ranksByVersion?.[model] };
  const key = { "B-v1": "modelB", "C-v1": "modelC", "D-v1": "modelD" }[model];
  return { score: record.scores?.[key], rank: record.ranks?.[key] };
};
const metrics = (returns) => {
  const ordered = [...returns].sort((a, b) => a - b); const count = ordered.length;
  if (!count) return { observationCount: 0, meanReturn: null, medianReturn: null, positiveRate: null };
  const median = count % 2 ? ordered[(count - 1) / 2] : (ordered[count / 2 - 1] + ordered[count / 2]) / 2;
  return { observationCount: count, meanReturn: Number((ordered.reduce((sum, item) => sum + item, 0) / count).toFixed(6)), medianReturn: Number(median.toFixed(6)), positiveRate: Number((ordered.filter((item) => item > 0).length / count * 100).toFixed(4)) };
};

export function buildModelTopPerformance({ snapshots, outcomes }) {
  const outcomeByDate = new Map(outcomes.map((outcome) => [outcome.signalDate, outcome]));
  const snapshotByDate = new Map(snapshots.map((snapshot) => [snapshot.asOfDate, snapshot]));
  const daily = [];
  const aggregateReturns = new Map();
  for (const snapshot of snapshotByDate.values()) {
    const outcome = outcomeByDate.get(snapshot.asOfDate); if (!outcome) continue;
    const returnByCode = new Map(outcome.records.filter((record) => record.status === "MATURE" && Number.isFinite(record.returnPercent)).map((record) => [record.ticker, record.returnPercent]));
    const eligibleCodes = new Set(snapshot.records.filter((record) => MODELS.some((model) => {
      const { score, rank } = value(record, model);
      return Number.isFinite(score) && Number.isInteger(rank);
    })).map((record) => normalizeStockCode(record.code)));
    const universe = metrics([...returnByCode].filter(([code]) => eligibleCodes.has(code)).map(([, returnPercent]) => returnPercent));
    for (const model of MODELS) for (const topN of SIZES) {
      const selected = snapshot.records.map((record) => ({ record, ...value(record, model) })).filter((item) => Number.isFinite(item.score) && Number.isInteger(item.rank) && item.rank <= topN).sort((a, b) => a.rank - b.rank || a.record.code.localeCompare(b.record.code));
      const returns = selected.map((item) => returnByCode.get(normalizeStockCode(item.record.code))).filter(Number.isFinite);
      if (!returns.length) continue;
      const groupMetrics = metrics(returns);
      const key = `${model}:${topN}`;
      aggregateReturns.set(key, [...(aggregateReturns.get(key) ?? []), ...returns]);
      daily.push({ modelVersion: model, signalDate: snapshot.asOfDate, targetTradingDate: outcome.targetTradingDate, topN, ...groupMetrics, universeObservationCount: universe.observationCount, universeMeanReturn: universe.meanReturn, excessReturn: universe.meanReturn == null ? null : Number((groupMetrics.meanReturn - universe.meanReturn).toFixed(6)) });
    }
  }
  const summary = MODELS.map((modelVersion) => ({ modelVersion, groups: SIZES.map((topN) => {
    const rows = daily.filter((row) => row.modelVersion === modelVersion && row.topN === topN);
    const returns = aggregateReturns.get(`${modelVersion}:${topN}`) ?? [];
    const aggregate = metrics(returns);
    const orderedRows = [...rows].sort((a, b) => a.signalDate.localeCompare(b.signalDate));
    const compoundReturn = orderedRows.length ? Number(((orderedRows.reduce((value, row) => value * (1 + row.meanReturn / 100), 1) - 1) * 100).toFixed(6)) : null;
    return { topN, evaluatedSignalDates: rows.length, ...aggregate, compoundReturn, bestSignalDate: rows.length ? [...rows].sort((a, b) => b.meanReturn - a.meanReturn)[0].signalDate : null, worstSignalDate: rows.length ? [...rows].sort((a, b) => a.meanReturn - b.meanReturn)[0].signalDate : null };
  }) }));
  return { schemaVersion: 1, dataset: "model-top-performance-1d", returnDefinition: "official next trading day close return", matureSignalDates: [...new Set(daily.map((row) => row.signalDate))].sort(), daily, summary };
}
