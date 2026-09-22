import assert from "node:assert/strict";
import fs from "node:fs";
import {
  calculateTechnicalStrength,
  createTechnicalStrengthCloseSeries,
} from "../lib/technical-strength.mjs";

const history = Array.from({ length: 120 }, (_, index) => {
  const date = new Date(Date.UTC(2026, 7, 20 - index)).toISOString().slice(0, 10).replaceAll("-", "");
  const close = 200 - index;
  return {
    basDt: date,
    clpr: String(close),
    mkp: String(close - 1),
    hipr: String(close + 2),
    lopr: String(close - 2),
    trqu: String(1000 + index),
    fltRt: "0.5",
  };
});

const historicalOnly = createTechnicalStrengthCloseSeries(history);
assert.deepEqual(historicalOnly.slice(0, 4), [200, 199, 198, 197]);
assert.equal(historicalOnly.length, 120);
assert.deepEqual(createTechnicalStrengthCloseSeries(history, null), historicalOnly);

const nextDayRealtime = { price: 210, asOfDate: "2026-08-21", high: 212, low: 198, volume: 2000 };
const withRealtime = createTechnicalStrengthCloseSeries(history, nextDayRealtime);
assert.deepEqual(withRealtime.slice(0, 4), [210, 200, 199, 198]);
assert.equal(withRealtime.length, 121);

const sameDateSameClose = { price: 200, asOfDate: "2026-08-20", high: 202, low: 198, volume: 1000 };
const replacedSameDate = createTechnicalStrengthCloseSeries(history, sameDateSameClose);
assert.deepEqual(replacedSameDate.slice(0, 4), [200, 199, 198, 197]);
assert.equal(replacedSameDate.length, 120);

const historicalResult = calculateTechnicalStrength(history, null);
const nullResult = calculateTechnicalStrength(history, null);
assert.deepEqual(nullResult, historicalResult);
assert.equal(historicalResult.priceMomentum, ((200 - 181) / 181) * 100);

const realtimeResult = calculateTechnicalStrength(history, nextDayRealtime);
assert.equal(realtimeResult.priceMomentum, ((210 - 182) / 182) * 100);

const sameDateResult = calculateTechnicalStrength(history, sameDateSameClose);
assert.deepEqual(sameDateResult, historicalResult);
assert.throws(
  () => calculateTechnicalStrength(history, { price: 210, high: 212, low: 198, volume: 2000 }),
  /realtimePrice\.asOfDate가 필요합니다/u,
);
assert.throws(
  () => calculateTechnicalStrength(history, { ...nextDayRealtime, asOfDate: "2026-08-19" }),
  /최신 공식 일봉보다 오래되었습니다/u,
);

const legacyHistoricalCloses = [Number(history[0].clpr), ...history.map((row) => Number(row.clpr))];
assert.deepEqual(legacyHistoricalCloses.slice(0, 4), [200, 200, 199, 198]);
assert.equal(legacyHistoricalCloses.length, 121);

const rsiFromNewest = (closes) => {
  let gains = 0;
  let losses = 0;
  for (let index = 0; index < 14; index += 1) {
    const change = closes[index] - closes[index + 1];
    if (change > 0) gains += change;
    else losses += Math.abs(change);
  }
  return losses === 0 ? 100 : 100 - 100 / (1 + gains / losses);
};
const rsiCloses = [100, 90, 95, 85, 92, 82, 89, 80, 87, 78, 85, 77, 84, 76, 83, 75, 82, 74, 81, 73];
const rsiHistory = rsiCloses.map((close, index) => ({
  basDt: String(20260820 - index),
  clpr: String(close),
  mkp: String(close),
  hipr: String(close + 1),
  lopr: String(close - 1),
  trqu: "1000",
  fltRt: "0",
}));
const correctedRsi = calculateTechnicalStrength(rsiHistory, null).rsi;
const legacyRsi = rsiFromNewest([rsiCloses[0], ...rsiCloses]);
assert.equal(correctedRsi, rsiFromNewest(rsiCloses));
assert.notEqual(correctedRsi, legacyRsi);

for (const filename of ["compare-technical-models.mjs", "validate-technical-sample.mjs"]) {
  const source = fs.readFileSync(new URL(filename, import.meta.url), "utf8");
  assert.match(source, /stck_bsop_date/u);
  assert.match(source, /stck_cntg_hour/u);
  assert.match(source, /source: "KIS"/u);
}

console.log(JSON.stringify({
  historicalOnly: historicalOnly.slice(0, 4),
  historicalOnlyLength: historicalOnly.length,
  historicalMomentum20: historicalResult.priceMomentum,
  realtime: withRealtime.slice(0, 4),
  realtimeLength: withRealtime.length,
  realtimeMomentum20: realtimeResult.priceMomentum,
  sameDateSameClose: replacedSameDate.slice(0, 4),
  sameDateSameCloseLength: replacedSameDate.length,
  legacyHistoricalOnly: legacyHistoricalCloses.slice(0, 4),
  legacyHistoricalOnlyLength: legacyHistoricalCloses.length,
  legacyHistoricalMomentum20: ((200 - 182) / 182) * 100,
  correctedRsi,
  legacyRsi,
}, null, 2));
