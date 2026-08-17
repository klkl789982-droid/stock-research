import { createHash } from "node:crypto";

export const COMPANY_ANALYSIS_VERSION = "company-analysis-v1";
export const COMPANY_ANALYSIS_FORMULA = Object.freeze({ profitability: { roe: [15, 20], operatingMargin: [10, 15] }, growth: { revenueCagr: [12.5, 20], operatingProfitCagr: [12.5, 20] }, stability: { debtRatio: [15, 200], interestCoverage: [10, 10] }, valuation: { per: [15, 5, 35], pbr: [10, 0.5, 4.5] } });
export const COMPANY_ANALYSIS_FORMULA_HASH = createHash("sha256").update(JSON.stringify(COMPANY_ANALYSIS_FORMULA)).digest("hex");

const finite = (value) => typeof value === "number" && Number.isFinite(value);
const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
const grade = (score) => score >= 80 ? "관심 종목" : score >= 65 ? "양호" : score >= 50 ? "중립" : score >= 35 ? "주의" : "위험";

export function calculateCompanyAnalysis(input) {
  const { financial, analysisAsOfDate, priceAsOfDate, marketCap, priceBasis, sourceManifest = {}, qualityStatus = "PROVISIONAL", qualityReasons = [] } = input;
  if (!financial || !/^\d{4}-\d{2}-\d{2}$/.test(analysisAsOfDate)) throw new Error("검증된 재무자료와 analysisAsOfDate가 필요합니다.");
  if (financial.filingDate && financial.filingDate > analysisAsOfDate) return ineligible("futureFiling", input);
  const m = financial.accounts ?? {};
  const metrics = {
    revenue: m.revenue ?? null, operatingProfit: m.operatingProfit ?? null, netIncome: m.netIncome ?? null,
    assets: m.assets ?? null, liabilities: m.liabilities ?? null, equity: m.equity ?? null,
    revenueCagr: m.revenueCagr ?? null, operatingProfitCagr: m.operatingProfitCagr ?? null,
    epsCagr: m.epsCagr ?? null, interestExpense: m.interestExpense ?? null, interestCoverage: m.interestCoverage ?? null,
    operatingCashFlow: m.operatingCashFlow ?? null, freeCashFlow: m.freeCashFlow ?? null,
    roe: finite(m.netIncome) && finite(m.equity) && m.equity !== 0 ? m.netIncome / m.equity * 100 : null,
    debtRatio: finite(m.liabilities) && finite(m.equity) && m.equity !== 0 ? m.liabilities / m.equity * 100 : null,
    operatingMargin: finite(m.revenue) && m.revenue !== 0 && finite(m.operatingProfit) ? m.operatingProfit / m.revenue * 100 : null,
    per: finite(marketCap) && marketCap > 0 && finite(m.netIncome) && m.netIncome > 0 ? marketCap / m.netIncome : null,
    pbr: finite(marketCap) && marketCap > 0 && finite(m.equity) && m.equity > 0 ? marketCap / m.equity : null,
  };
  const sameDate = priceAsOfDate === analysisAsOfDate;
  const valuationStatus = !finite(marketCap) || marketCap <= 0 ? "missingMarketCap" : !sameDate ? "priceDateMismatch" : metrics.per == null && metrics.pbr == null ? "notCalculable" : "available";
  if (!sameDate) { metrics.per = null; metrics.pbr = null; }
  const scores = {
    roeScore: metrics.roe == null ? null : clamp(metrics.roe / 20 * 15, 0, 15),
    operatingMarginScore: metrics.operatingMargin == null ? null : clamp(metrics.operatingMargin / 15 * 10, 0, 10),
    revenueGrowthScore: metrics.revenueCagr == null ? null : clamp(metrics.revenueCagr / 20 * 12.5, 0, 12.5),
    operatingGrowthScore: metrics.operatingProfitCagr == null ? null : clamp(metrics.operatingProfitCagr / 20 * 12.5, 0, 12.5),
    debtScore: metrics.debtRatio == null ? null : clamp(15 - metrics.debtRatio / 200 * 15, 0, 15),
    interestScore: metrics.interestCoverage == null ? null : clamp(metrics.interestCoverage / 10 * 10, 0, 10),
    perScore: metrics.per == null ? null : clamp(15 - (metrics.per - 5) / 35 * 15, 0, 15),
    pbrScore: metrics.pbr == null ? null : clamp(10 - (metrics.pbr - 0.5) / 4.5 * 10, 0, 10),
  };
  const group = (keys) => keys.every((key) => scores[key] != null) ? keys.reduce((sum, key) => sum + scores[key], 0) : null;
  const componentScores = { profitability: group(["roeScore", "operatingMarginScore"]), growth: group(["revenueGrowthScore", "operatingGrowthScore"]), stability: group(["debtScore", "interestScore"]), valuation: group(["perScore", "pbrScore"]), details: scores };
  const eligible = Object.values(componentScores).slice(0, 4).every((value) => value != null) && valuationStatus === "available";
  const totalScore = eligible ? Math.round(componentScores.profitability + componentScores.growth + componentScores.stability + componentScores.valuation) : null;
  const ineligibleReasons = []; if (!eligible) { for (const [key, value] of Object.entries(componentScores).slice(0, 4)) if (value == null) ineligibleReasons.push(`${key}NotCalculable`); if (valuationStatus !== "available") ineligibleReasons.push(valuationStatus); }
  return { formulaVersion: COMPANY_ANALYSIS_VERSION, formulaHash: COMPANY_ANALYSIS_FORMULA_HASH, sourceManifest, financialMetrics: metrics, componentScores, totalScore, grade: totalScore == null ? "분석 불가" : grade(totalScore), eligible, ineligibleReasons, valuationStatus, marketCap: finite(marketCap) ? marketCap : null, priceBasis, priceAsOfDate, analysisAsOfDate, financialPeriodEnd: financial.fiscalPeriodEnd, filingDate: financial.filingDate, receiptNumber: financial.receiptNumber, fsDivision: financial.fsDivision, qualityStatus: qualityStatus === "CERTIFIED" ? "CERTIFIED" : "PROVISIONAL", qualityReasons };
}

function ineligible(reason, input) { return { formulaVersion: COMPANY_ANALYSIS_VERSION, formulaHash: COMPANY_ANALYSIS_FORMULA_HASH, sourceManifest: input.sourceManifest ?? {}, financialMetrics: {}, componentScores: {}, totalScore: null, grade: "분석 불가", eligible: false, ineligibleReasons: [reason], valuationStatus: "notCalculable", marketCap: input.marketCap ?? null, priceBasis: input.priceBasis, priceAsOfDate: input.priceAsOfDate, analysisAsOfDate: input.analysisAsOfDate, financialPeriodEnd: input.financial?.fiscalPeriodEnd ?? null, filingDate: input.financial?.filingDate ?? null, receiptNumber: input.financial?.receiptNumber ?? null, fsDivision: input.financial?.fsDivision ?? null, qualityStatus: "PROVISIONAL", qualityReasons: [reason] }; }
