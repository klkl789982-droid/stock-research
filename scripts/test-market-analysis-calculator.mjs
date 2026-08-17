import assert from "node:assert/strict";
import fs from "node:fs";
import { calculateMarketAnalysis, MARKET_ANALYSIS_CALCULATOR_VERSION } from "../lib/market-analysis-v1.mjs";

const start = new Date("2026-08-17T00:00:00Z");
const rows = Array.from({ length: 260 }, (_, index) => {
  const date = new Date(start); date.setUTCDate(date.getUTCDate() - index);
  const close = 50000 - index * 75 + Math.round(Math.sin(index / 5) * 500);
  return { basDt: date.toISOString().slice(0, 10).replaceAll("-", ""), mkp: close - 100, hipr: close + 500, lopr: close - 600, clpr: close, trqu: 100000 + index * 100 };
});
const first = calculateMarketAnalysis(rows); const second = calculateMarketAnalysis(structuredClone(rows));
assert.equal(MARKET_ANALYSIS_CALCULATOR_VERSION, "market-analysis-v1");
assert.deepEqual(first, second, "동일 공식 OHLCV 입력은 동일 결과를 내야 합니다.");
assert.equal(first.indicators.ma5, 50037);
assert.equal(first.indicators.momentum20 > 0, true);
assert.equal(Number.isFinite(first.finalTechnicalScore), true);
assert.equal(first.indicators.chartData.length, 60);
assert.throws(() => calculateMarketAnalysis(rows.slice(0, 259)), /260 거래일/);
assert.throws(() => calculateMarketAnalysis([{ ...rows[0], clpr: 0 }, ...rows.slice(1)]), /OHLCV/);
const pageSource = fs.readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
assert.equal(pageSource.includes("calculateEMAArray"), false, "브라우저 페이지에 시장분석 계산기가 남아서는 안 됩니다.");
assert.equal(pageSource.includes("MarketAnalysisPanel"), true);
console.log("시장분석 v1 결정론·characterization 테스트 통과");
