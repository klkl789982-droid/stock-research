// Additive research layer. Never modifies transition-research-v1 observations.
export const DIRECTIONAL_RULE_VERSION = "transition-directional-research-v2";
export const APPROACH_SCORE_VERSION = "transition-approach-strength-research-v1";
export const CROSS_DIRECTIONS = ["golden", "dead"];
export const approachPolicy = Object.freeze({ version: APPROACH_SCORE_VERSION, researchOnly: true, probability: false, approvedForTrading: false,
  weights: { proximity: 25, contraction: 20, shortSlope: 20, longSlope: 10, persistence: 15, priceAlignment: 10 },
  scales: { gapPercent: 5, contractionPercentPoints: 1, shortSlopePercent: 1, longSlopePercent: 2, priceDistancePercent: 4 },
  persistenceTransitions: 5, confirmationTradingDays: 3 });
const clamp = (v) => Math.min(1, Math.max(0, v));
const validMa = (p, s, l) => p && [p[s], p[l]].every((v) => Number.isFinite(v) && v > 0);

export function observeDirectionalTransition(points, shortKey, longKey, direction, legacyGolden) {
  if (!CROSS_DIRECTIONS.includes(direction) || points.length < 2) throw new Error("DIRECTIONAL_INPUT_INVALID");
  const current = points.at(-1), previous = points.at(-2), earlier = points.at(-3);
  if (![current, previous].every((p) => validMa(p, shortKey, longKey))) throw new Error("DIRECTIONAL_MA_MISSING");
  const sign = direction === "golden" ? 1 : -1;
  const gap = (p) => (p[shortKey] / p[longKey] - 1) * 100;
  const slope = (p, q, key) => (p[key] / q[key] - 1) * 100;
  const shortSlope = slope(current, previous, shortKey), longSlope = slope(current, previous, longKey);
  const previousSlope = validMa(earlier, shortKey, longKey) ? slope(previous, earlier, shortKey) : null;
  let maintainedTradingDays = 0;
  for (let i = points.length - 1; i >= 0 && validMa(points[i], shortKey, longKey) && sign * gap(points[i]) > 0; i--) maintainedTradingDays++;
  const crossIndex = points.length - maintainedTradingDays;
  const observed = maintainedTradingDays > 0 && crossIndex > 0 && validMa(points[crossIndex - 1], shortKey, longKey) && sign * gap(points[crossIndex - 1]) <= 0;
  const crossed = sign * gap(previous) <= 0 && sign * gap(current) > 0;
  const approaching = validMa(earlier, shortKey, longKey)
    && [earlier, previous, current].every((p) => sign * gap(p) < 0)
    && Math.abs(gap(current)) < Math.abs(gap(previous)) && Math.abs(gap(previous)) < Math.abs(gap(earlier))
    && sign * shortSlope > 0 && sign * shortSlope > sign * previousSlope;
  // Golden classification reuses the existing approved research v1 exactly.
  const status = direction === "golden" && legacyGolden ? legacyGolden.status
    : crossed ? "CROSS_OCCURRED" : observed && maintainedTradingDays >= 3 ? "CONFIRMED" : approaching ? "APPROACHING" : "NONE";
  const recent = points.slice(-6);
  let components = null, approachStrength = null;
  if (status === "APPROACHING" && recent.length === 6 && recent.every((p) => validMa(p, shortKey, longKey)) && Number.isFinite(current.close) && current.close > 0) {
    const persistence = recent.slice(1).filter((p, i) => sign * gap(p) < 0 && sign * gap(recent[i]) < 0 && Math.abs(gap(p)) < Math.abs(gap(recent[i]))).length / 5;
    components = { proximity: clamp(1 - Math.abs(gap(current)) / 5),
      contraction: clamp((Math.abs(gap(previous)) - Math.abs(gap(current))) / 1),
      shortSlope: clamp(sign * shortSlope / 1), longSlope: clamp(0.5 + sign * longSlope / 2), persistence,
      priceAlignment: clamp(0.5 + sign * (current.close / current[shortKey] - 1) * 100 / 4) };
    approachStrength = Number(Object.entries(components).reduce((total, [key, value]) => total + value * approachPolicy.weights[key], 0).toFixed(2));
  }
  return { ruleVersion: DIRECTIONAL_RULE_VERSION, scoreVersion: APPROACH_SCORE_VERSION, researchOnly: true, direction, status,
    gapPercent: gap(current), previousGapPercent: gap(previous), shortSlopePercent: shortSlope, longSlopePercent: longSlope,
    previousShortSlopePercent: previousSlope, maintainedTradingDays, maintainedDaysLowerBound: maintainedTradingDays === points.length,
    crossDate: observed ? points[crossIndex].date : null, approachStrength,
    strengthStatus: status !== "APPROACHING" ? "NOT_APPLICABLE" : approachStrength === null ? "INSUFFICIENT_INPUT" : "RESEARCH_ONLY", components };
}

export function transitionLabel(direction, status) {
  if (status === "NONE") return "신호 없음";
  return `${direction === "dead" ? "데드크로스" : "골든크로스"} ${{ APPROACHING: "접근", CROSS_OCCURRED: "발생", CONFIRMED: "확인" }[status] ?? "미확인"}`;
}
