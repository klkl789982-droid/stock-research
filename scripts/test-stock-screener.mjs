import assert from "node:assert/strict";
import { createScreeningRows, screenStocks } from "../lib/stock-screener.mjs";

const snapshot = { asOfDate: "2026-10-06", records: [
  { code: "000001", name: "가기업", market: "KOSPI", scores: { modelB: 80, modelC: 70, modelD: 60 }, ranks: { modelB: 1, modelC: 2, modelD: 3 }, scoresByVersion: { "A-v1": 90 }, ranksByVersion: { "A-v1": 1 }, qualityEligibility: { eligible: true } },
  { code: "000002", name: "나기업", market: "KOSDAQ", scores: { modelB: 75, modelC: 65, modelD: 55 }, ranks: { modelB: 2, modelC: 3, modelD: 4 }, scoresByVersion: { "A-v1": 70 }, ranksByVersion: { "A-v1": 2 }, qualityEligibility: { eligible: true } },
  { code: "000003", name: "격리기업", market: "KOSPI", scores: { modelB: null, modelC: null, modelD: null }, ranks: { modelB: null, modelC: null, modelD: null }, scoresByVersion: { "A-v1": null }, ranksByVersion: { "A-v1": null }, qualityEligibility: { eligible: false } },
] };
const company = { requestedDate: "2026-09-22", records: [
  { code: "000001", eligible: true, totalScore: 82, grade: "관심 종목" },
  { code: "000002", eligible: false, totalScore: null, grade: "분석 불가" },
] };
const rows = createScreeningRows(snapshot, company);
assert.equal(rows.length, 3);
assert.equal(rows[2].models["A-v1"].score, null, "결측 점수를 0으로 바꾸지 않는다");
assert.equal(rows[2].company.score, null);

const combined = screenStocks(rows, { model: "A-v1", minScore: 80, maxRank: 10, companyGrade: "관심 종목" });
assert.deepEqual(combined.results.map((row) => row.code), ["000001"]);
assert.equal(combined.exclusions.missingModel, 1);
assert.equal(combined.exclusions.missingCompany, 2);

const scoreSorted = screenStocks(rows, { model: "B-v1", sort: "score", direction: "desc" });
assert.deepEqual(scoreSorted.results.map((row) => row.code), ["000001", "000002"]);
assert.equal(scoreSorted.results[0].rank, 1);
assert.equal(scoreSorted.exclusions.missingModel, 1);

console.log("Daily EOD 스크리닝 필터·결측·정렬 테스트 통과");
