const reasonLabel = {
  profitabilityNotCalculable: "수익성 계산에 필요한 재무자료가 부족합니다.",
  stabilityNotCalculable: "재무 안정성 계산에 필요한 자료가 부족합니다.",
  valuationNotCalculable: "가치평가를 계산할 수 없습니다.",
  missingMarketCap: "기준일 시가총액 자료가 없습니다.",
  priceDateMismatch: "재무자료와 가격의 기준일이 일치하지 않습니다.",
  financialLedgerMissing: "검증된 재무제표가 아직 준비되지 않았습니다.",
  pointInTimeStatementMissing: "분석 기준일에 사용할 수 있는 재무제표가 없습니다.",
  futureFiling: "분석 기준일 이후 공시는 사용할 수 없습니다.",
  notCalculable: "현재 자료로 기업분석을 계산할 수 없습니다.",
};

export const companyAnalysisReasonLabel = (reason) => reason ? (reasonLabel[reason] ?? "기업분석에 필요한 자료가 충분하지 않습니다.") : "기업 재무데이터를 준비하고 있습니다.";

const cagrLabel = (name, input, period) => input === "nonPositive"
  ? `${period} ${name}이 0 이하로 일반적인 ${name} 성장률(CAGR)을 계산할 수 없습니다.`
  : "성장률 계산에 필요한 비교기간 재무자료를 확인할 수 없습니다.";

export function companyAnalysisGrowthReasonLabel(record) {
  const metrics = record?.financialMetrics ?? {};
  const provenance = record?.featureProvenance;
  const inputs = [
    ["operatingProfitCagr", "영업이익"],
    ["revenueCagr", "매출"],
  ];
  for (const [key, name] of inputs) {
    if (metrics[key] != null) continue;
    const detail = provenance?.[key];
    if (!detail) continue;
    if (detail.currentInputStatus === "nonPositive") return cagrLabel(name, "nonPositive", "현재");
    if (detail.comparisonInputStatus === "nonPositive") return cagrLabel(name, "nonPositive", "비교기간");
    if (detail.currentInputStatus === "missing" || detail.comparisonInputStatus === "missing") return cagrLabel(name, "missing", "비교기간");
  }
  return provenance
    ? "성장성 점수를 계산할 수 없습니다."
    : "성장성 점수를 계산할 수 없습니다. 저장된 상세 입력 상태가 없어 원인을 구분할 수 없습니다.";
}

export function companyAnalysisRecordReasonLabel(record, reason) {
  return reason === "growthNotCalculable" ? companyAnalysisGrowthReasonLabel(record) : companyAnalysisReasonLabel(reason);
}
