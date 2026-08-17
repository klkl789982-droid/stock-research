import assert from "node:assert/strict";
import { validateMarketDataQuality } from "../lib/market-data-quality-validator.mjs";

const REQUESTED = "2026-08-14";

function compactDate(daysAgo) {
  const date = new Date("2026-08-14T00:00:00Z");
  date.setUTCDate(date.getUTCDate() - daysAgo);
  return date.toISOString().slice(0, 10).replaceAll("-", "");
}

function makeRows(count = 260) {
  return Array.from({ length: count }, (_, index) => {
    const close = 10_000 - index;
    return {
      basDt: compactDate(index),
      mkp: close - 10,
      hipr: close + 100,
      lopr: close - 100,
      clpr: close,
      trqu: 1_000 + index,
      trPrc: (1_000 + index) * close,
      mrktTotAmt: 1_000_000_000_000,
    };
  });
}

function validate({ universe = [{ code: "000001", marketCap: 1_000_000_000_000 }], histories = { "000001": makeRows() }, requirements = {} } = {}) {
  return validateMarketDataQuality({
    requestedDate: REQUESTED,
    universeRecords: universe,
    historyByCode: histories,
    requirements: {
      expectedUniverseCount: universe.length,
      sourceManifestPresent: false,
      adjustedPricePolicy: "unknown",
      corporateActionPolicy: "unknown",
      pointInTimeMasterCertified: false,
      universeFilterVersion: "v1",
      universeGeneratedAt: "2026-08-14T18:00:00.000Z",
      ...requirements,
    },
  });
}

function hasIssue(result, type) {
  return result.issues.some((entry) => entry.type === type);
}

let passed = 0;
function test(name, callback) {
  callback();
  passed += 1;
  console.log(`PASS ${name}`);
}

test("정상 260거래일 데이터는 구조 검증을 통과하고 PROVISIONAL이다", () => {
  const result = validate();
  assert.equal(result.status, "passed");
  assert.equal(result.grade, "PROVISIONAL");
  assert.equal(result.eligibleForSnapshot, true);
  assert.equal(result.modelEligibility["A-v1"].eligibleCodes.length, 1);
});

test("모든 인증 근거가 있으면 CERTIFIED가 가능하다", () => {
  const rows = makeRows();
  rows.forEach((row) => { row.trqu += 1; });
  const result = validate({ histories: { "000001": rows }, requirements: {
    sourceManifestPresent: true,
    adjustedPricePolicy: "verified",
    corporateActionPolicy: "verified",
    pointInTimeMasterCertified: true,
    securityStatusVerified: true,
  } });
  assert.equal(result.grade, "CERTIFIED");
  assert.equal(result.eligibleForOptimization, true);
});

test("종목코드 중복 실패", () => {
  const result = validate({ universe: [{ code: "A000001" }, { code: "000001" }], histories: { "000001": makeRows() } });
  assert.equal(result.status, "failed");
  assert.deepEqual(result.summary.duplicateUniverseCodes, ["000001"]);
});

test("Universe 종목 history 누락 실패", () => {
  const result = validate({ histories: {} });
  assert.ok(hasIssue(result, "missingHistoryCodes"));
});

test("latest basDt 불일치 실패", () => {
  const rows = makeRows();
  rows.shift();
  const result = validate({ histories: { "000001": rows }, requirements: { maxRequestedNonTradingRatio: 1 } });
  assert.ok(hasIssue(result, "latestDateMismatch"));
});

test("미래 날짜 실패", () => {
  const rows = makeRows();
  rows[0].basDt = "20260815";
  const result = validate({ histories: { "000001": rows } });
  assert.ok(hasIssue(result, "futureDate"));
});

test("동일 날짜 중복 실패", () => {
  const rows = makeRows();
  rows[1].basDt = rows[0].basDt;
  const result = validate({ histories: { "000001": rows } });
  assert.ok(hasIssue(result, "duplicateDates"));
  assert.ok(hasIssue(result, "invalidTradingValueDateWindow"));
});

test("정렬되지 않은 배열 탐지", () => {
  const rows = makeRows();
  [rows[1], rows[2]] = [rows[2], rows[1]];
  assert.ok(hasIssue(validate({ histories: { "000001": rows } }), "historyNotDescending"));
});

for (const [name, mutate, expected] of [
  ["시가 0 실패", (row) => { row.mkp = 0; }, "invalidPrice"],
  ["종가 NaN 실패", (row) => { row.clpr = "NaN"; }, "invalidClose"],
  ["고가가 저가보다 낮으면 실패", (row) => { row.hipr = row.lopr - 1; }, "invalidOhlcRelationship"],
  ["고가가 시가보다 낮으면 실패", (row) => { row.hipr = row.mkp - 1; }, "invalidOhlcRelationship"],
  ["저가가 종가보다 높으면 실패", (row) => { row.lopr = row.clpr + 1; }, "invalidOhlcRelationship"],
  ["거래량 음수 실패", (row) => { row.trqu = -1; }, "invalidVolume"],
  ["거래대금 음수 실패", (row) => { row.trPrc = -1; }, "invalidTradingValue"],
  ["시가총액 0 실패", (row) => { row.mrktTotAmt = 0; }, "invalidMarketCap"],
]) {
  test(name, () => {
    const rows = makeRows();
    mutate(rows[0]);
    assert.ok(hasIssue(validate({ histories: { "000001": rows } }), expected));
  });
}

test("거래량 0은 경고 및 PROVISIONAL", () => {
  const rows = makeRows();
  rows[0].trqu = 0;
  rows[0].clpr = rows[1].clpr;
  rows[0].mkp = 0;
  rows[0].hipr = 0;
  rows[0].lopr = 0;
  const result = validate({ histories: { "000001": rows }, requirements: { maxRequestedNonTradingRatio: 1 } });
  assert.ok(hasIssue(result, "nonTradingObservation"));
  assert.equal(result.status, "passed");
  assert.equal(result.perSymbol["000001"].modelStatus["B-v1"], "tradingHaltOrNoTrade");
  assert.equal(result.perSymbol["000001"].uniqueTradingDays, 259);
});

test("거래량 0인데 가격 변동 시 오류", () => {
  const rows = makeRows();
  rows[0].trqu = 0;
  rows[0].mkp = 0;
  rows[0].hipr = 0;
  rows[0].lopr = 0;
  assert.ok(hasIssue(validate({ histories: { "000001": rows } }), "zeroVolumePriceChanged"));
});

test("exact-date 시총 누락 실패", () => {
  const rows = makeRows();
  rows[0].mrktTotAmt = null;
  assert.ok(hasIssue(validate({ histories: { "000001": rows } }), "missingExactDateMarketCap"));
});

test("20일 거래대금 날짜 중복 실패", () => {
  const rows = makeRows();
  rows[19].basDt = rows[18].basDt;
  assert.ok(hasIssue(validate({ histories: { "000001": rows } }), "invalidTradingValueDateWindow"));
});

test("역사 길이 부족 시 해당 모델만 ineligible", () => {
  const result = validate({ histories: { "000001": makeRows(100) } });
  assert.equal(result.modelEligibility["A-v1"].reasons["000001"], "insufficientHistory");
  assert.equal(result.modelEligibility["A-v2"].reasons["000001"], "insufficientHistory");
  assert.equal(result.modelEligibility["B-v1"].reasons["000001"], "insufficientHistory");
  assert.deepEqual(result.modelEligibility["C-v1"].eligibleCodes, ["000001"]);
  assert.equal(result.modelEligibility["D-v1"].reasons["000001"], "insufficientHistory");
  assert.equal(result.eligibleForSnapshot, false);
});

test("A-v2는 A-v1과 동일한 데이터 자격", () => {
  const result = validate({ histories: { "000001": makeRows(100) } });
  assert.deepEqual(result.modelEligibility["A-v2"], result.modelEligibility["A-v1"]);
});

test("D는 B와 C 자격의 교집합", () => {
  const result = validate({ histories: { "000001": makeRows(100) } });
  assert.equal(result.modelEligibility["C-v1"].eligibleCodes.length, 1);
  assert.equal(result.modelEligibility["B-v1"].eligibleCodes.length, 0);
  assert.equal(result.modelEligibility["D-v1"].eligibleCodes.length, 0);
});

test("동일 입력 반복 실행 결과는 동일하다", () => {
  const input = { histories: { "000001": makeRows() } };
  assert.deepEqual(validate(input), validate(input));
});

console.log(`시장 데이터 품질 검증기 테스트 완료: ${passed}개 통과`);
