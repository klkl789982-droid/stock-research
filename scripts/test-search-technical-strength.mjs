import assert from "node:assert/strict";
import fs from "node:fs";
import { buildSearchTechnicalStrength, SEARCH_TECHNICAL_REQUIRED_HISTORY } from "../lib/search-technical-strength.mjs";

const dateAt = (offset) => {
  const date = new Date(Date.UTC(2026, 7, 20));
  date.setUTCDate(date.getUTCDate() - offset);
  return date.toISOString().slice(0, 10).replaceAll("-", "");
};
const history = Array.from({ length: SEARCH_TECHNICAL_REQUIRED_HISTORY }, (_, index) => {
  const close = 300 - index * 0.5;
  return { basDt: dateAt(index), clpr: String(close), mkp: String(close), hipr: String(close + 2), lopr: String(close - 2), trqu: String(1000 + index), fltRt: "0" };
});
const input = (overrides = {}) => ({ priceHistory: history, priceRequestStatus: "success", realtimePrice: null, ...overrides });

const historicalOnly = buildSearchTechnicalStrength(input());
assert.equal(historicalOnly.status, "available");
assert.equal(historicalOnly.realtimeApplied, false);

const sameDate = buildSearchTechnicalStrength(input({ realtimePrice: { price: 301, asOfDate: "2026-08-20", asOfTime: "15:20:00", source: "KIS", high: 303, low: 298, volume: 2000 } }));
assert.equal(sameDate.status, "available");
assert.equal(sameDate.realtimeStatus, "sameDateApplied");

const nextDay = buildSearchTechnicalStrength(input({ realtimePrice: { price: 302, asOfDate: "2026-08-21", asOfTime: "09:10:00", source: "KIS", high: 304, low: 299, volume: 500 } }));
assert.equal(nextDay.status, "available");
assert.equal(nextDay.realtimeStatus, "newerDateApplied");

const stale = buildSearchTechnicalStrength(input({ realtimePrice: { price: 999, asOfDate: "2026-08-19", asOfTime: "15:20:00", source: "KIS" } }));
assert.equal(stale.status, "available");
assert.equal(stale.realtimeStatus, "staleIgnored");
assert.equal(stale.score, historicalOnly.score);

assert.deepEqual(buildSearchTechnicalStrength(input({ priceHistory: history.slice(0, 259) })), { status: "unavailable", reason: "INSUFFICIENT_HISTORY", modelVersion: "A-v1" });
assert.equal(buildSearchTechnicalStrength(input({ priceRequestStatus: "unavailable", priceHistory: [] })).reason, "PRICE_REQUEST_FAILED");
assert.equal(buildSearchTechnicalStrength(input({ priceHistory: history.map((row, index) => index === 3 ? { ...row, hipr: "invalid" } : row) })).reason, "INVALID_HISTORY");
assert.equal(buildSearchTechnicalStrength(input(), () => { throw new Error("synthetic calculator failure"); }).status, "error");

const lowerBoundary = buildSearchTechnicalStrength(input(), () => ({ finalTechnicalScore: -0.01 }));
const upperBoundary = buildSearchTechnicalStrength(input(), () => ({ finalTechnicalScore: 100.01 }));
assert.equal(lowerBoundary.outsideDisplayRange, true);
assert.equal(upperBoundary.outsideDisplayRange, true);
assert.equal(lowerBoundary.score, -0.01, "A-v1 원점수를 UI adapter에서 clamp하지 않아야 합니다.");
assert.equal(upperBoundary.score, 100.01, "A-v1 원점수를 UI adapter에서 clamp하지 않아야 합니다.");

const page = fs.readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
assert.match(page, /setPriceRequestStatus\("loading"\)/u);
assert.match(page, /buildSearchTechnicalStrength/u);
assert.match(page, /<TechnicalStrengthPanel view=\{technicalStrength\}/u);
assert.match(page, /requestId === searchRequestIdRef\.current && selectedCodeRef\.current === stockCode/u);

const panel = fs.readFileSync(new URL("../components/TechnicalStrengthPanel.tsx", import.meta.url), "utf8");
assert.match(panel, /검증 진행 중/u);
assert.match(panel, /analysisAvailabilityMessage/u);
assert.match(panel, /0~100 clamp를 적용하지 않았습니다/u);

const availability = fs.readFileSync(new URL("../lib/analysis-availability.mjs", import.meta.url), "utf8");
assert.match(availability, /분석에 필요한 거래 데이터가 부족합니다/u);
assert.match(availability, /가격 데이터 정합성을 확인할 수 없습니다/u);

console.log("검색 기술적 강도 availability·realtime provenance·stale 격리 테스트 통과");
