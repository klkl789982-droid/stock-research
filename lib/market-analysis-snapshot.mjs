import { createHash } from "node:crypto";
import { calculateMarketAnalysis, MARKET_ANALYSIS_CALCULATOR_VERSION } from "./market-analysis-v1.mjs";

export const MARKET_ANALYSIS_SCHEMA_VERSION = 1;

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
export function marketAnalysisContentHash(value) { return createHash("sha256").update(canonical(value)).digest("hex"); }

function reasonsFor(stockQuality, history) {
  const reasons = [];
  if (!stockQuality) reasons.push("qualityStatusMissing");
  if ((stockQuality?.uniqueTradingDays ?? history.length) < 260 || history.length < 260) reasons.push("insufficientHistory");
  if (stockQuality?.requestedPriceStatus === "tradingHaltOrNoTrade") reasons.push("tradingHaltOrNoTrade");
  return reasons;
}

export function createMarketAnalysisSnapshot({ requestedDate, generatedAt, universe, historyByCode, quality, sourceManifest, dataQuality, universeSummary, formulaHash }) {
  const records = universe.stocks.map((stock) => {
    const history = historyByCode.get(stock.code) ?? [];
    const stockQuality = quality.perSymbol?.[stock.code];
    const ineligibleReasons = reasonsFor(stockQuality, history);
    const base = {
      code: stock.code, name: stock.name, market: stock.market, asOfDate: requestedDate,
      source: "data.go.kr/GetStockPriceInfo", priceBasis: "officialDailyClose",
      officialClosePrice: ineligibleReasons.includes("tradingHaltOrNoTrade") ? stockQuality?.referenceClose ?? null : Number(history[0]?.clpr),
      qualityStatus: ineligibleReasons.length === 0 ? dataQuality.grade : "ineligible",
      historyTradingDays: stockQuality?.uniqueTradingDays ?? history.length,
      eligible: ineligibleReasons.length === 0, ineligibleReasons,
    };
    if (ineligibleReasons.length > 0) return { ...base, indicators: {}, componentScores: {}, riskFlags: {}, reversalBonus: 0, penalty: 0, penaltyReasons: [], finalTechnicalScore: null, technicalStatus: "분석 불가" };
    return { ...base, ...calculateMarketAnalysis(history) };
  });
  const base = {
    schemaVersion: MARKET_ANALYSIS_SCHEMA_VERSION, analysisType: "marketAnalysis", requestedDate,
    priceBasis: "officialDailyClose", generatedAt, calculatorVersion: MARKET_ANALYSIS_CALCULATOR_VERSION,
    formulaHash, sourceManifest, dataQuality,
    universeSummary: { ...universeSummary, marketAnalysis: { observed: records.length, eligible: records.filter((record) => record.eligible).length, excluded: records.filter((record) => !record.eligible).length } },
    records,
  };
  return { ...base, contentHash: marketAnalysisContentHash(base) };
}

export function validateMarketAnalysisSnapshot(snapshot, expectedCount) {
  const errors = [];
  if (snapshot.schemaVersion !== 1 || snapshot.analysisType !== "marketAnalysis") errors.push("시장분석 스키마 식별자가 올바르지 않습니다.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(snapshot.requestedDate)) errors.push("requestedDate가 올바르지 않습니다.");
  if (snapshot.priceBasis !== "officialDailyClose") errors.push("priceBasis는 officialDailyClose여야 합니다.");
  if (!Array.isArray(snapshot.records) || snapshot.records.length !== expectedCount) errors.push(`records는 ${expectedCount}개여야 합니다.`);
  const codes = snapshot.records?.map((record) => record.code) ?? [];
  if (new Set(codes).size !== codes.length) errors.push("중복 종목코드가 있습니다.");
  for (const record of snapshot.records ?? []) {
    if (record.asOfDate !== snapshot.requestedDate || record.priceBasis !== "officialDailyClose") errors.push(`${record.code}: 기준일 또는 가격 기준 오류`);
    if (record.eligible && (!Number.isFinite(record.officialClosePrice) || !Number.isFinite(record.finalTechnicalScore))) errors.push(`${record.code}: 적격 레코드 계산값 누락`);
  }
  const { contentHash, ...base } = snapshot;
  if (contentHash !== marketAnalysisContentHash(base)) errors.push("contentHash 불일치");
  return errors;
}
