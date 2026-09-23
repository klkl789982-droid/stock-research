import assert from "node:assert/strict";
import fs from "node:fs";
import { buildSearchMarketAnalysis, SEARCH_MARKET_REQUIRED_HISTORY } from "../lib/search-market-analysis.mjs";
import { analysisAvailabilityMessage } from "../lib/analysis-availability.mjs";

const dateAt = (offset) => {
  const date = new Date(Date.UTC(2026, 7, 20));
  date.setUTCDate(date.getUTCDate() - offset);
  return date.toISOString().slice(0, 10).replaceAll("-", "");
};
const history = Array.from({ length: SEARCH_MARKET_REQUIRED_HISTORY }, (_, index) => {
  const close = 50000 - index * 10;
  return { basDt: dateAt(index), mkp: String(close - 10), hipr: String(close + 100), lopr: String(close - 100), clpr: String(close), trqu: String(1000 + index) };
});
const base = { priceHistory: history, priceRequestStatus: "success", storedMarketData: null };

const calculated = buildSearchMarketAnalysis(base);
assert.equal(calculated.status, "available");
assert.equal(calculated.source, "searchOfficialDailyHistory");
assert.equal(calculated.realtimeApplied, false);
assert.equal(calculated.data.record.qualityStatus, "SEARCH_SESSION_PROVISIONAL");

const stored = { requestedDate: "2026-08-20", generatedAt: "x", calculatorVersion: "market-analysis-v1", record: { eligible: true, asOfDate: "20260820", finalTechnicalScore: 42 } };
assert.equal(buildSearchMarketAnalysis({ ...base, storedMarketData: stored }).source, "storedOfficialSnapshot");
assert.equal(buildSearchMarketAnalysis({ priceHistory: [], priceRequestStatus: "unavailable", storedMarketData: stored }).status, "available", "price API 실패가 저장된 공식 분석을 막으면 안 됩니다.");
assert.equal(buildSearchMarketAnalysis({ ...base, priceHistory: history.slice(0, 259) }).reason, "INSUFFICIENT_HISTORY");
assert.equal(buildSearchMarketAnalysis({ ...base, priceHistory: history.map((row, index) => index === 2 ? { ...row, mkp: "0" } : row) }).reason, "INVALID_HISTORY");
assert.equal(buildSearchMarketAnalysis(base, () => { throw new Error("synthetic"); }).status, "error");

assert.equal(analysisAvailabilityMessage("INSUFFICIENT_HISTORY"), "분석에 필요한 거래 데이터가 부족합니다.");
assert.equal(analysisAvailabilityMessage("INVALID_HISTORY"), "가격 데이터 정합성을 확인할 수 없습니다.");
assert.equal(analysisAvailabilityMessage("staleQuote"), "현재 시세가 오래되어 장중 분석에서 제외했습니다.");

const page = fs.readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
assert.match(page, /buildSearchMarketAnalysis/u);
assert.match(page, /marketAnalysisView\.status === "available"/u);
assert.match(page, /setMarketAnalysis\(null\)/u);
assert.match(page, /setIntradayAnalysis\(null\)/u);
assert.match(page, /requestId === searchRequestIdRef\.current && selectedCodeRef\.current === stockCode/u);

const panel = fs.readFileSync(new URL("../components/market-analysis/MarketAnalysisPanel.tsx", import.meta.url), "utf8");
assert.match(panel, /검색 시점 기준 임시 계산/u);
assert.match(panel, /공식 일봉 기준/u);
assert.match(panel, /장중 참고 정보/u);

console.log("검색 시장분석 공식 일봉 fallback·snapshot 독립·reason mapping 테스트 통과");
