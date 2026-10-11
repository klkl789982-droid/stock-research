import assert from "node:assert/strict";
import { observeDirectionalTransition, approachPolicy } from "../lib/directional-transition.mjs";
import { observeMaTransition, screenTransitions, parseTransitionFilters } from "../lib/transition-screener.mjs";
const p = (day, s, l = 100, close = s) => ({ date: `2026-10-${String(day).padStart(2, "0")}`, ma5: s, ma20: l, ma60: 120, close });
const observe = (points, direction) => observeDirectionalTransition(points, "ma5", "ma20", direction, observeMaTransition(points, "5-20"));
const golden = [p(1, 90), p(2, 91), p(5, 92), p(6, 93), p(7, 95), p(8, 98)];
const dead = [p(1, 110), p(2, 109), p(5, 108), p(6, 107), p(7, 105), p(8, 102)];
const before = structuredClone(golden);
for (const [points, direction] of [[golden, "golden"], [dead, "dead"]]) {
  const result = observe(points, direction);
  assert.equal(result.status, "APPROACHING"); assert.equal(result.strengthStatus, "RESEARCH_ONLY");
  assert.ok(result.approachStrength >= 0 && result.approachStrength <= 100);
  assert.equal(result.approachStrength, Number(Object.entries(result.components).reduce((s, [k, v]) => s + v * approachPolicy.weights[k], 0).toFixed(2)));
  assert.equal(observe(points.slice(-3), direction).approachStrength, null, "강도 입력 부족은 0점이 아님");
  assert.equal(observe(points.map((q) => ({ ...q, close: null })), direction).strengthStatus, "INSUFFICIENT_INPUT");
}
assert.equal(approachPolicy.probability, false);
assert.deepEqual(golden, before);
assert.equal(observe([p(7, 101), p(8, 102), p(9, 103)], "golden").status, "NONE", "범위 이전 교차 추정 금지");
assert.equal(observe([p(7, 100), p(8, 99)], "dead").status, "CROSS_OCCURRED");
assert.equal(observe([p(7, 100), p(8, 99), p(9, 98), p(12, 97)], "dead").status, "CONFIRMED");
assert.equal(observe([p(7, 100), p(8, 100)], "dead").status, "NONE");
assert.equal(observe([p(6, 110), p(7, 109), p(8, 108.5)], "dead").status, "NONE", "기울기 둔화는 접근 아님");
for (let n = 2; n <= golden.length; n++) assert.equal(observe(golden.slice(0, n), "golden").status, observeMaTransition(golden.slice(0, n), "5-20").status);
const active = { code: "000001", name: "테스트", market: "KOSPI", referenceDate: "2026-10-08", missingReasons: [], models: { "A-v1": { score: 70 } }, indicators: { rsi: 55, volumeMultiple: 2, dailyChangePercent: 1, macdState: "rising" }, transitions: { "5-20": observeMaTransition(dead, "5-20") }, directionalTransitions: { "5-20": { golden: observe(dead, "golden"), dead: observe(dead, "dead") } } };
const unavailable = { ...active, code: "000002", missingReasons: ["qualityIneligible"] };
const filters = (q = "") => parseTransitionFilters(new URLSearchParams(`rules=directional-v2&${q}`));
assert.deepEqual(screenTransitions([active], filters()).results.map((r) => r.crossDirection), ["dead"], "반대 신호를 신호없음으로 중복 표시하지 않음");
assert.equal(screenTransitions([active], filters("state=NONE")).results.length, 0);
const screening = screenTransitions([active, unavailable], filters("crossDirection=all&state=APPROACHING&strengthMin=20&sort=strength&direction=desc"));
assert.equal(screening.results.length, 1); assert.equal(screening.reasonCounts.qualityIneligible, 1); assert.equal(screening.exclusions.dataMissing, 1);
const noPrice = { ...active, directionalTransitions: { "5-20": { ...active.directionalTransitions["5-20"], dead: { ...active.directionalTransitions["5-20"].dead, approachStrength: null } } } };
assert.equal(screenTransitions([noPrice], filters("crossDirection=dead&strengthMin=0")).exclusions.filterMissing, 1);
const notApplicable = { ...active, directionalTransitions: { "5-20": { ...active.directionalTransitions["5-20"], dead: { ...active.directionalTransitions["5-20"].dead, status: "CONFIRMED", approachStrength: null } } } };
const excluded = screenTransitions([notApplicable], filters("crossDirection=dead&strengthMin=0"));
assert.equal(excluded.exclusions.conditionNotMet, 1); assert.equal(excluded.exclusions.filterMissing, 0, "비접근 상태의 강도 해당없음은 데이터 결측이 아닙니다.");
assert.equal(screenTransitions([active], filters("code=000009")).results.length, 0);
for (const direction of ["golden", "dead"]) {
  const rows = [40, 90, 60].map((strength, i) => ({ ...active, code: `00000${i + 1}`, directionalTransitions: { "5-20": { [direction]: { ...observe(direction === "golden" ? golden : dead, direction), approachStrength: strength } } } }));
  assert.deepEqual(screenTransitions(rows, filters(`crossDirection=${direction}&state=APPROACHING&sort=strength&direction=desc`)).results.map(r => r.approachStrength), [90, 60, 40]);
  assert.deepEqual(screenTransitions(rows, filters(`crossDirection=${direction}&state=APPROACHING&sort=strength&direction=asc`)).results.map(r => r.approachStrength), [40, 60, 90]);
}
for (const q of ["strengthMin=101", "strengthMin=-1", "strengthMin=NaN", "crossDirection=unknown", "code=bad", "rules=legacy-v1&strengthMin=2"]) {
  const params = new URLSearchParams(q.includes("rules=") ? q : `rules=directional-v2&${q}`);
  assert.throws(() => parseTransitionFilters(params));
}
console.log("directional v2 symmetry/equality/causal inputs/v1 preservation/strength formula/null/unique exclusion/filter tests passed");
