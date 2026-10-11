// Exploratory, pre-registered hypotheses; not a calibrated probability or trading rule.
export const evidencePolicy = Object.freeze({
  version: "transition-evidence-research-v1", researchOnly: true, probability: false,
  thresholds: Object.freeze({ improvement: 0, sustainedGapTransitions: 3, volumeMultiple: 1.2, volumeGrowthPercent: 0, priceChangePercent: 0, breakoutLookback: 20 }),
  indicatorBasis: "officialDailyClose; RSI14 simple gains/losses; MACD EMA12/26/9; volume mean20 includes today",
});
export const evidenceLabels = Object.freeze({ MET: "충족", PARTIAL: "부분 충족", NOT_MET: "미충족", DATA_MISSING: "데이터 부족" });
export const evidencePresets = Object.freeze({
  early: Object.freeze({ label: "상승 전환 초기 후보", filters: { crossDirection: "golden", pair: "5-20", state: "APPROACHING", sort: "strength", direction: "desc", trendEvidence: "improving", momentumEvidence: "improving" } }),
  confirmed: Object.freeze({ label: "상승 전환 확인 후보", filters: { crossDirection: "golden", pair: "5-20", state: "CROSSED_OR_CONFIRMED", sort: "evidence", direction: "desc", trendEvidence: "improving" } }),
  strong: Object.freeze({ label: "강한 상승 초기 후보", filters: { crossDirection: "golden", pair: "5-20", state: "all", sort: "evidence", direction: "desc", momentumEvidence: "improving", volumeEvidence: "met" } }),
});
export function applyEvidencePreset(initial, key) {
  if (!Object.hasOwn(evidencePresets, key)) throw new Error("TRANSITION_PRESET_INVALID");
  return { ...initial, rules: "directional-v2", ...evidencePresets[key].filters };
}
