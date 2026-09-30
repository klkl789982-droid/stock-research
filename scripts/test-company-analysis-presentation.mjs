import assert from "node:assert/strict";
import { companyAnalysisGrowthReasonLabel, companyAnalysisRecordReasonLabel } from "../lib/company-analysis-presentation.mjs";

const record = (financialMetrics, featureProvenance) => ({ financialMetrics, featureProvenance });
const skHynix = record(
  { revenueCagr: 72.18, operatingProfitCagr: null },
  { revenueCagr: { currentInputStatus: "available", comparisonInputStatus: "available" }, operatingProfitCagr: { currentInputStatus: "available", comparisonInputStatus: "nonPositive" } },
);
assert.equal(companyAnalysisGrowthReasonLabel(skHynix), "비교기간 영업이익이 0 이하로 일반적인 영업이익 성장률(CAGR)을 계산할 수 없습니다.");
assert.equal(companyAnalysisGrowthReasonLabel(record({ revenueCagr: 10, operatingProfitCagr: null }, { operatingProfitCagr: { currentInputStatus: "nonPositive", comparisonInputStatus: "available" } })), "현재 영업이익이 0 이하로 일반적인 영업이익 성장률(CAGR)을 계산할 수 없습니다.");
assert.equal(companyAnalysisGrowthReasonLabel(record({ revenueCagr: null, operatingProfitCagr: 10 }, { revenueCagr: { currentInputStatus: "available", comparisonInputStatus: "missing" } })), "성장률 계산에 필요한 비교기간 재무자료를 확인할 수 없습니다.");
assert.equal(companyAnalysisGrowthReasonLabel(record({ revenueCagr: 10, operatingProfitCagr: 12 }, { revenueCagr: { currentInputStatus: "available", comparisonInputStatus: "available" }, operatingProfitCagr: { currentInputStatus: "available", comparisonInputStatus: "available" } })), "성장성 점수를 계산할 수 없습니다.");
assert.match(companyAnalysisGrowthReasonLabel(record({ revenueCagr: 10, operatingProfitCagr: null }, null)), /저장된 상세 입력 상태가 없어/);
assert.equal(companyAnalysisRecordReasonLabel(skHynix, "growthNotCalculable"), companyAnalysisGrowthReasonLabel(skHynix));
console.log("company analysis 성장성 provenance 사용자 문구 테스트 통과");
