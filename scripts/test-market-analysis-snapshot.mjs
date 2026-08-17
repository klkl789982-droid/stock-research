import assert from "node:assert/strict";
import { createMarketAnalysisSnapshot, validateMarketAnalysisSnapshot } from "../lib/market-analysis-snapshot.mjs";

const start = new Date("2026-08-17T00:00:00Z");
const history = Array.from({ length: 260 }, (_, index) => { const date = new Date(start); date.setUTCDate(date.getUTCDate() - index); const close = 10000 - index * 10; return { basDt: date.toISOString().slice(0, 10).replaceAll("-", ""), mkp: close, hipr: close + 100, lopr: close - 100, clpr: close, trqu: 1000 + index }; });
const universe = { stocks: [{ code: "005930", name: "삼성전자", market: "KOSPI" }] };
const quality = { perSymbol: { "005930": { uniqueTradingDays: 260, requestedPriceStatus: "executable" } } };
const input = { requestedDate: "2026-08-17", generatedAt: "2026-08-17T08:00:00.000Z", universe, historyByCode: new Map([["005930", history]]), quality, sourceManifest: { source: "official" }, dataQuality: { grade: "provisional" }, universeSummary: {}, formulaHash: "a".repeat(64) };
const snapshot = createMarketAnalysisSnapshot(input);
assert.deepEqual(validateMarketAnalysisSnapshot(snapshot, 1), []);
assert.equal(snapshot.records[0].source, "data.go.kr/GetStockPriceInfo");
assert.equal(snapshot.records[0].priceBasis, "officialDailyClose");
assert.equal(snapshot.records[0].eligible, true);
assert.deepEqual(snapshot, createMarketAnalysisSnapshot(input));
assert.equal(JSON.stringify(snapshot).includes("realtime"), false);
console.log("시장분석 스냅샷 스키마 테스트 통과");
