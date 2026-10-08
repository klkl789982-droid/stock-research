import assert from "node:assert/strict";
import { buildIntradayModelTopPerformance, buildModelTopPerformance, MODEL_PERFORMANCE_HORIZONS, MODEL_PERFORMANCE_MODELS, MODEL_PERFORMANCE_TOP_SIZES } from "../lib/model-top-performance.mjs";

const record = (index) => ({
  code: String(index).padStart(6, "0"),
  name: `종목 ${index}`,
  scores: { modelA: 101 - index, modelB: index, modelC: 101 - index, modelD: 101 - index },
  ranks: { modelA: index, modelB: 21 - index, modelC: index, modelD: index },
  scoresByVersion: { "A-v1": 101 - index },
  ranksByVersion: { "A-v1": index },
});
const snapshot = { asOfDate: "2026-09-30", records: Array.from({ length: 20 }, (_, index) => record(index + 1)) };
const outcome = (multiplier = 1) => ({
  signalDate: "2026-09-30",
  targetTradingDate: multiplier === 1 ? "2026-10-01" : "2026-10-28",
  returnDefinition: "fixture official close return",
  records: snapshot.records.map((item, index) => ({ ticker: item.code, status: index === 19 ? "PENDING" : "MATURE", returnPercent: index === 19 ? null : (index + 1) * multiplier })),
});

const result = buildModelTopPerformance({ snapshots: [snapshot], outcomesByHorizon: { "1DAY": [outcome()], "5DAY": [], "20DAY": [outcome(2)] } });
const group = (modelVersion, topN, horizon) => result.summary.find((model) => model.modelVersion === modelVersion).groups.find((item) => item.topN === topN).horizons.find((item) => item.horizon === horizon);

assert.deepEqual(result.availableHorizons, ["1DAY", "20DAY"]);
assert.deepEqual(result.matureSignalDates, ["2026-09-30"]);
assert.equal(result.totalOutcomeObservationCount, 38);
assert.equal(group("A-v1", 5, "1DAY").observationCount, 5);
assert.equal(group("A-v1", 5, "1DAY").meanReturn, 3);
assert.equal(group("A-v1", 10, "1DAY").medianReturn, 5.5);
assert.equal(group("A-v1", 20, "1DAY").observationCount, 19, "PENDING outcome은 N에 포함하면 안 됩니다.");
assert.equal(group("B-v1", 5, "1DAY").observationCount, 4, "TOP5 중 실제 성숙한 종목만 집계해야 합니다.");
assert.equal(group("B-v1", 5, "1DAY").meanReturn, 17.5);
assert.equal(group("D-v1", 5, "20DAY").meanReturn, 6);
assert.equal(group("C-v1", 5, "5DAY").status, "ACCUMULATING");
assert.equal(group("C-v1", 5, "5DAY").observationCount, 0);
assert.equal(group("C-v1", 5, "5DAY").meanReturn, null, "N=0을 0%로 표현하면 안 됩니다.");
assert.deepEqual(result, buildModelTopPerformance({ snapshots: [snapshot], outcomesByHorizon: { "1DAY": [outcome()], "5DAY": [], "20DAY": [outcome(2)] } }), "같은 입력은 결정론적이어야 합니다.");

assert.equal(group("A-v1", 5, "1DAY").minObservation.companyName, "종목 1");
assert.equal(group("A-v1", 5, "1DAY").maxObservation.ticker, "000005");
assert.equal(group("A-v1", 5, "1DAY").minObservation.entryDate, snapshot.asOfDate);
assert.equal(group("A-v1", 5, "1DAY").minObservation.entryPriceBasis, "signalDayOfficialClose");
assert.equal(group("A-v1", 5, "1DAY").maxObservation.evaluationEndDate, "2026-10-01");
assert.equal(group("C-v1", 5, "60DAY").minObservation, null);
assert.equal(group("C-v1", 5, "60DAY").uniqueStockCount, 0);

const getMetrics = (value, model, topN, horizon) => value.summary.find((item) => item.modelVersion === model).groups.find((item) => item.topN === topN).horizons.find((item) => item.horizon === horizon);
const repeatedSnapshot = { ...structuredClone(snapshot), asOfDate: "2026-10-01" };
const mixed = outcome();
mixed.records[0].returnPercent = -5;
mixed.records[1].returnPercent = 0;
mixed.records[2].returnPercent = -5;
mixed.records[3].status = "PENDING";
mixed.records[3].returnPercent = -1000; // Numeric pending values must still be excluded.
mixed.records[4].status = "DATA_MISSING";
mixed.records[4].returnPercent = 1000;
mixed.records[5].returnPercent = Infinity;
const repeatedOutcome = { ...structuredClone(mixed), signalDate: repeatedSnapshot.asOfDate, targetTradingDate: "2026-10-02" };
const inputs = { snapshots: [snapshot, repeatedSnapshot], outcomesByHorizon: Object.fromEntries(MODEL_PERFORMANCE_HORIZONS.map((horizon) => [horizon, [mixed, repeatedOutcome]])) };
const unchanged = structuredClone(inputs);
const repeated = buildModelTopPerformance(inputs);
const selected = getMetrics(repeated, "A-v1", 5, "1DAY");
assert.equal(selected.observationCount, 6);
assert.equal(selected.uniqueSignalDateCount, 2);
assert.equal(selected.uniqueStockCount, 3, "반복 선정 종목 수와 관측 수를 구분해야 합니다.");
assert.equal(selected.meanReturn, -3.333333);
assert.equal(selected.medianReturn, -5);
assert.equal(selected.positiveRate, 0, "0%는 상승 관측이 아니며 확정 표본에는 포함됩니다.");
assert.equal(selected.minObservation.signalDate, "2026-09-30");
assert.equal(selected.minObservation.ticker, "000001", "극단값 동률은 신호일, 종목코드로 결정합니다.");
assert.equal(selected.maxObservation.returnPercent, 0);
assert.deepEqual(inputs, unchanged, "동결된 signal/outcome을 수정해서는 안 됩니다.");
assert.deepEqual(repeated, buildModelTopPerformance(inputs));

for (const model of MODEL_PERFORMANCE_MODELS) for (const topN of MODEL_PERFORMANCE_TOP_SIZES) for (const horizon of MODEL_PERFORMANCE_HORIZONS) {
  const metrics = getMetrics(repeated, model, topN, horizon);
  const values = inputs.snapshots.flatMap((s) => s.records.filter((r) => {
    const key = { "A-v1": "modelA", "B-v1": "modelB", "C-v1": "modelC", "D-v1": "modelD" }[model];
    return r.ranks[key] <= topN;
  }).flatMap((r) => {
    const o = inputs.outcomesByHorizon[horizon].find((o) => o.signalDate === s.asOfDate).records.find((o) => o.ticker === r.code);
    return o.status === "MATURE" && Number.isFinite(o.returnPercent) ? [o.returnPercent] : [];
  })).sort((a, b) => a - b);
  assert.equal(metrics.observationCount, values.length);
  assert.equal(metrics.meanReturn, Number((values.reduce((a, b) => a + b, 0) / values.length).toFixed(6)));
  assert.equal(metrics.positiveRate, Number((values.filter((v) => v > 0).length / values.length * 100).toFixed(4)));
  assert.equal(metrics.minObservation.returnPercent, values[0]);
  assert.equal(metrics.maxObservation.returnPercent, values.at(-1));
}

const liveOutcomes = [mixed, repeatedOutcome].map((o) => ({
  signalDate: o.signalDate, signalTime: "14:30:00", dataset: "intraday-model-top-execution-outcomes", contentHash: `fixture-${o.signalDate}`,
  records: MODEL_PERFORMANCE_MODELS.flatMap((modelVersion) => snapshot.records.map((r, index) => ({
    modelVersion, ticker: r.code, companyName: r.name, rank: r.ranks[{ "A-v1": "modelA", "B-v1": "modelB", "C-v1": "modelC", "D-v1": "modelD" }[modelVersion]],
    entry: { tradingDate: o.targetTradingDate, priceBasis: "nextTradingDayOfficialOpen" },
    horizons: Object.fromEntries(MODEL_PERFORMANCE_HORIZONS.map((horizon) => [horizon, { status: o.records[index].status, returnPercent: o.records[index].returnPercent, targetTradingDate: "2027-01-15" }])),
  }))),
}));
const liveBefore = structuredClone(liveOutcomes);
const live = buildIntradayModelTopPerformance({ outcomes: liveOutcomes });
for (const model of MODEL_PERFORMANCE_MODELS) for (const topN of MODEL_PERFORMANCE_TOP_SIZES) for (const horizon of MODEL_PERFORMANCE_HORIZONS) {
  const actual = getMetrics(live, model, topN, horizon);
  const expected = getMetrics(repeated, model, topN, horizon);
  for (const key of ["observationCount", "uniqueSignalDateCount", "uniqueStockCount", "meanReturn", "medianReturn", "positiveRate", "minReturn", "maxReturn"]) assert.equal(actual[key], expected[key], `${model}/${topN}/${horizon}/${key}: 同一 확정 집합`);
  assert.equal(actual.minObservation.signalTime, "14:30:00");
  assert.equal(actual.minObservation.entryDate, "2026-10-01");
  assert.equal(actual.minObservation.entryPriceBasis, "nextTradingDayOfficialOpen");
  assert.equal(actual.maxObservation.evaluationEndDate, "2027-01-15");
  assert.equal(actual.minObservation.source.contentHash, "fixture-2026-09-30");
}
assert.deepEqual(liveOutcomes, liveBefore);
assert.deepEqual(live, buildIntradayModelTopPerformance({ outcomes: liveOutcomes }));
for (const model of buildIntradayModelTopPerformance({ outcomes: [] }).summary) for (const g of model.groups) for (const h of g.horizons) {
  assert.equal(h.status, "ACCUMULATING"); assert.equal(h.meanReturn, null); assert.equal(h.minObservation, null); assert.equal(h.observationCount, 0);
}
const expectedLiveCount = liveOutcomes.flatMap((o) => o.records).reduce((count, r) => count + Object.values(r.horizons).filter((h) => h.status === "MATURE" && Number.isFinite(h.returnPercent)).length, 0);
assert.equal(live.totalOutcomeObservationCount, expectedLiveCount, "non-finite MATURE outcomes must not inflate the top-level count");
const invalidRank = structuredClone(liveOutcomes[0]);
invalidRank.records = invalidRank.records.map((r) => ({ ...r, rank: 0 }));
assert.equal(getMetrics(buildIntradayModelTopPerformance({ outcomes: [invalidRank] }), "A-v1", 5, "1DAY").observationCount, 0);

console.log("model performance A~D/TOP5~20/1~60D/extrema/ties/unique counts/mature-only/isolation/unchanged metrics tests passed");
