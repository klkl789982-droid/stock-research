// Shared browser-safe metadata. No calculator, file access or network imports.
export const TRANSITION_RULE_VERSION = "transition-research-v1";
export const TRANSITION_PAIRS = Object.freeze({ "5-20": ["ma5", "ma20"], "20-60": ["ma20", "ma60"] });
export const TRANSITION_STATUSES = ["CROSS_OCCURRED", "CONFIRMED", "APPROACHING", "NONE"];
export const TRANSITION_RESEARCH_PROPOSAL = Object.freeze({
  version: TRANSITION_RULE_VERSION, approved: true, researchOnly: true, confirmationTradingDays: 3,
  approaching: "단기선 < 장기선, 최근 3개 확정 관측의 절대 상대 간격 연속 축소, 단기선 기울기 양수 및 이전보다 개선",
  confirmed: "관측된 교차일부터 3개 확정 거래일 이상 연속 단기선 > 장기선 (교차일 포함)",
});
