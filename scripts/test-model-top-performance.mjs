import assert from "node:assert/strict";
import { buildModelTopPerformance } from "../lib/model-top-performance.mjs";

const record = (index) => ({
  code: String(index).padStart(6, "0"),
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

console.log("model performance model/topN/horizon/mature-only/N=0 tests passed");
