import assert from "node:assert/strict";
import { buildModelValidation, spearmanRankIc, VALIDATION_SUFFICIENCY } from "../lib/model-validation-engine.mjs";

const versions = ["A-v1", "A-v2", "B-v1", "C-v1", "D-v1"];
const future = (value) => ({ future1dReturn: value, future5dReturn: value, future20dReturn: value, future60dReturn: value });
function snapshot(date, returns, { quarantineLast = false, omitBIndex = null } = {}) {
  const records = returns.map((value, index) => {
    const code = String(index + 1).padStart(6, "0"), score = returns.length - index;
    const scoresByVersion = Object.fromEntries(versions.map((version) => [version, version === "B-v1" && index === omitBIndex ? null : score]));
    const ranksByVersion = Object.fromEntries(versions.map((version) => [version, version === "B-v1" && index === omitBIndex ? null : index + 1]));
    return { code, scoresByVersion, ranksByVersion, rankingUniverseCountByVersion: Object.fromEntries(versions.map((version) => [version, returns.length])), futureReturns: future(value), qualityEligibility: quarantineLast && index === returns.length - 1 ? { eligible: false, status: "quarantined", exclusions: [{ reason: "fixture" }] } : { eligible: true, status: "eligible", exclusions: [] } };
  });
  return { schemaVersion: 6, asOfDate: date, isPartialRanking: quarantineLast, universeSummary: { originalUniverse: { count: records.length }, qualityEligibleUniverse: { count: records.length - (quarantineLast ? 1 : 0) }, quarantinedUniverse: { count: quarantineLast ? 1 : 0 }, rankingUniverse: Object.fromEntries(versions.map((version) => [version, { count: version === "B-v1" && omitBIndex != null ? records.length - 1 : records.length }])) }, records };
}
const wrapped = (snapshots) => snapshots.map((value) => ({ date: value.asOfDate, snapshot: value }));

assert.equal(spearmanRankIc([{ score: 1, futureReturn: 1 }, { score: 2, futureReturn: 2 }, { score: 3, futureReturn: 3 }]).value, 1);
assert.equal(spearmanRankIc([{ score: 1, futureReturn: 3 }, { score: 2, futureReturn: 2 }, { score: 3, futureReturn: 1 }]).value, -1);
assert.equal(spearmanRankIc([{ score: 3, futureReturn: 4 }, { score: 3, futureReturn: 3 }, { score: 2, futureReturn: 2 }, { score: 1, futureReturn: 1 }]).value, 0.9486832981, "score tie는 평균 순위를 사용해야 합니다.");
assert.equal(spearmanRankIc([{ score: 1, futureReturn: 1 }]).status, "INSUFFICIENT_PAIRS");

const base = snapshot("2026-01-02", [10,9,8,7,6,5,4,3,2,1,0,-1], { quarantineLast: true, omitBIndex: 10 });
const frozen = JSON.stringify(base);
const one = buildModelValidation({ snapshots: wrapped([base]), generatedAt: "test" });
assert.equal(JSON.stringify(base), frozen, "validation은 baseline score/rank를 변경하면 안 됩니다.");
const aNative = one.dailyMetrics.find((item) => item.modelVersion === "A-v1" && item.horizon === "T1" && item.universeType === "nativeUniverse");
const bNative = one.dailyMetrics.find((item) => item.modelVersion === "B-v1" && item.horizon === "T1" && item.universeType === "nativeUniverse");
const aCommon = one.dailyMetrics.find((item) => item.modelVersion === "A-v1" && item.horizon === "T1" && item.universeType === "commonComparisonUniverse");
assert.equal(aNative.rankIc.value, 1); assert.equal(aNative.coverage.resolvedPairCount, 11, "quarantine은 제외해야 합니다.");
assert.equal(bNative.coverage.resolvedPairCount, 10); assert.equal(aCommon.coverage.resolvedPairCount, 10, "common universe는 모든 모델의 교집합이어야 합니다.");
assert.equal(aNative.coverage.evaluationUniverseCount, 11); assert.equal(aCommon.coverage.evaluationUniverseCount, 10, "native/common coverage denominator를 섞으면 안 됩니다.");
assert.equal(aNative.topN.TOP5.constituentCount, 5); assert.equal(aNative.topN.TOP5.meanReturn, 8);
assert.equal(aNative.deciles.status, "CALCULATED"); assert.equal(aNative.deciles.buckets.length, 10);
assert.equal(aNative.universeRelativeSpread.meanReturnSpread, 9.5); assert.equal(aNative.benchmark, null); assert.equal(aNative.excessReturn, null);
assert.equal(one.periodAggregates[0].sampleSufficiencyStatus, VALIDATION_SUFFICIENCY.INSUFFICIENT);

const missing = snapshot("2026-01-03", Array(12).fill(null));
const none = buildModelValidation({ snapshots: wrapped([missing]), generatedAt: "test" });
assert(none.periodAggregates.every((item) => item.sampleSufficiencyStatus === VALIDATION_SUFFICIENCY.NONE));
const fiftyNine = Array.from({ length: 59 }, (_, index) => snapshot(`2026-02-${String(index + 1).padStart(2, "0")}`, [3,2,1]));
const insufficient = buildModelValidation({ snapshots: wrapped(fiftyNine), generatedAt: "test" });
assert(insufficient.periodAggregates.every((item) => item.sampleSufficiencyStatus === VALIDATION_SUFFICIENCY.INSUFFICIENT));
const sixty = [...fiftyNine, snapshot("2026-04-01", [3,2,1])];
const ready = buildModelValidation({ snapshots: wrapped(sixty), generatedAt: "test" });
assert(ready.periodAggregates.every((item) => item.sampleSufficiencyStatus === VALIDATION_SUFFICIENCY.READY));
assert(ready.periodAggregates.every((item) => item.conclusion === null), "표본 충족 여부와 모델 결론은 분리해야 합니다.");
assert.deepEqual(buildModelValidation({ snapshots: wrapped([base]), generatedAt: "test" }), one, "동일 입력 결과는 결정론적이어야 합니다.");
console.log("model-validation-v1 IC/TOP/decile/spread/native-common/sufficiency 테스트 통과");
