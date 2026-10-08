import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { HOME_MODELS, summarizeModelChanges, summarizeTransitions, latestOneDayPerformance, calendarContext, dailyOperationState } from "../lib/home-dashboard.mjs";
import { createHomeDashboardStore } from "../lib/home-dashboard-store.mjs";

const record = (code, rank, eligible = true) => ({ code, name: `긴종목명${code}`, market: "KOSPI", qualityEligibility: { eligible }, scoresByVersion: { "A-v1": 80 }, ranksByVersion: { "A-v1": rank }, scores: { modelB: 80, modelC: 70, modelD: 60 }, ranks: { modelB: rank, modelC: rank, modelD: rank } });
const snapshot = (date, records) => ({ asOfDate: date, records, dataQuality: { structuralStatus: "passed" }, sourceManifest: { modelFormulaHashes: Object.fromEntries(HOME_MODELS.map((m) => [m, "same-frozen-formula"])) } });
const before = snapshot("2026-10-06", [record("001", 1), record("002", 6), record("003", 4), record("004", 7), record("005", 3)]);
const now = snapshot("2026-10-07", [record("001", 6), record("002", 2), record("003", 1), record("004", 7), record("005", null, false), record("006", 4)]);
const frozen = structuredClone({ before, now });
const result = summarizeModelChanges(now, before, before.asOfDate, 5);
for (const model of result.models) {
  assert.deepEqual(model.entered.map((r) => r.code), ["002"]);
  assert.deepEqual(model.exited.map((r) => r.code), ["001"]);
  assert.deepEqual(model.risers.map((r) => r.code), ["003", "002"]);
  assert.deepEqual(model.universeAddedTop.map((r) => r.code), ["006"]);
  assert.deepEqual(model.universeRemovedTop.map((r) => r.code), ["005"]);
  assert.equal(model.commonUniverseCount, 4);
}
assert.equal(result.overlap.length, 3);
assert.deepEqual({ before, now }, frozen);
assert.deepEqual(summarizeModelChanges(now, before, before.asOfDate, 5), result);
assert.equal(summarizeModelChanges(now, null, before.asOfDate).models[0].entered, null);
assert.equal(summarizeModelChanges(now, before, "2026-10-02").models[0].comparisonStatus, "UNAVAILABLE", "누락 거래일을 건너뛰어 비교하지 않습니다.");
const changed = structuredClone(before); changed.sourceManifest.modelFormulaHashes["A-v1"] = "different";
assert.equal(summarizeModelChanges(now, changed, before.asOfDate).models[0].comparisonReason, "FORMULA_PROVENANCE_CHANGED_OR_MISSING");
assert.throws(() => summarizeModelChanges(now, before, before.asOfDate, 6));
assert.equal(summarizeModelChanges(now, before, before.asOfDate, 10).models[0].entered.length, 0, "같은 TOP 범위로 비교합니다.");
const transition = { referenceDate: now.asOfDate, sourceQualityGrade: "REJECTED", isPartialRanking: true, rows: [
  { code: "003", name: "전환종목", missingReasons: [], transitions: { "5-20": { status: "APPROACHING", gapPercent: -1 }, "20-60": { status: "CROSS_OCCURRED", gapPercent: 0.2 } } },
  { code: "005", name: "격리", missingReasons: ["qualityIneligible"], transitions: null },
] };
const summary = summarizeTransitions(transition, result);
assert.equal(summary.indicatorCoverage, 1); assert.equal(summary.excludedCount, 1);
assert.equal(summary.pairs[0].states.find((s) => s.state === "APPROACHING").count, 1);
assert.deepEqual(summary.pairs[0].states.find((s) => s.state === "APPROACHING").examples[0].topModels, HOME_MODELS);
assert.equal(summarizeTransitions(transition, { ...result, referenceDate: "other" }).pairs[0].states.find((s) => s.state === "APPROACHING").examples[0].topModels.length, 0);
const row = { modelVersion: "B-v1", topN: 5, horizon: "1DAY", signalDate: "2026-10-06", targetTradingDate: "2026-10-07", observationCount: 4, rankedConstituentCount: 5, meanReturn: -1.25, positiveRate: 25 };
const performance = latestOneDayPerformance({ daily: [{ ...row, signalDate: "2026-10-02", meanReturn: 99 }, row, { ...row, signalDate: "2026-10-07", meanReturn: null, observationCount: 0 }], live: { daily: [] } });
assert.equal(performance.daily[1].meanReturn, -1.25);
assert.equal(performance.daily[1].observationCount, 4);
assert.equal(performance.live[1].meanReturn, null);
assert.equal(performance.live[1].observationCount, 0);
assert.equal(latestOneDayPerformance({ daily: [row] }, 10).daily[1].meanReturn, null);
const calendar = { dates: { "2026-10-07": { status: "tradingDay" }, "2026-10-08": { status: "marketClosed" }, "2026-10-09": { status: "marketClosed" } } };
const weekend = calendarContext(calendar, new Date("2026-10-10T10:00:00Z"));
assert.equal(weekend.expectedTradingDate, "2026-10-07");
const good = { freshnessStatus: "fresh", publicationStatus: "published", siteApiMatchesPublished: true, siteApiReferenceDate: "2026-10-07", lagTradingDays: 0 };
assert.equal(dailyOperationState(good, weekend), "NORMAL", "확인된 휴장은 날짜 나이로 실패 처리하지 않습니다.");
assert.equal(dailyOperationState(good, calendarContext({}, new Date("2026-10-10T10:00:00Z"))), "UNKNOWN", "알려지지 않은 평일을 휴장일로 추정하지 않습니다.");
assert.equal(dailyOperationState(null, weekend), "UNKNOWN");
assert.equal(dailyOperationState({ ...good, lastAutomaticRunConclusion: "success", siteApiMatchesPublished: false }, weekend), "DELAYED", "Actions success와 게시 성공은 별도입니다.");
assert.equal(dailyOperationState({ ...good, runStatus: "FAILED" }, weekend), "FAILED");
assert.equal(dailyOperationState(good, { expectedTradingDate: "2026-10-08", dayStatus: "tradingDay", time: "18:00:00" }), "WAITING");
assert.equal(dailyOperationState(good, { expectedTradingDate: "2026-10-08", dayStatus: "tradingDay", time: "20:30:00" }), "DELAYED");
const root = await mkdtemp(path.join(os.tmpdir(), "tb-home-test-"));
try {
  await mkdir(path.join(root, "data/history"), { recursive: true });
  await mkdir(path.join(root, "data/trading-calendar"), { recursive: true });
  await writeFile(path.join(root, "data/history/2026-10-07.json"), JSON.stringify(now));
  await writeFile(path.join(root, "data/trading-calendar/status.json"), JSON.stringify({ dates: { "2026-10-07": { status: "tradingDay" } } }));
  let calls = 0;
  const load = createHomeDashboardStore({ root, loadTransitions: async () => { calls += 1; return transition; } });
  const [first, second] = await Promise.all([load(), load()]);
  assert.deepEqual(first, second); assert.equal(calls, 1, "같은 요청의 single-flight를 유지합니다.");
  await load(); assert.equal(calls, 1, "반복 홈 조회에서 지표를 재계산하지 않습니다.");
  await load(10); assert.equal(calls, 2);
  await writeFile(path.join(root, "data/history/2026-10-07.json"), JSON.stringify({ ...now, records: [record("unique-change", 1)] }));
  assert.equal((await load()).models.models[0].top[0].code, "unique-change", "파일 변경 시 기준일 캐시를 무효화합니다.");
  const partial = createHomeDashboardStore({ root, loadTransitions: async () => { throw new Error("seed unavailable"); } });
  const isolated = await partial();
  assert.ok(isolated.models); assert.equal(isolated.transitions, null);
} finally { await rm(root, { recursive: true, force: true }); }
console.log("home frozen ranking/comparison universe/formula guard/partial isolation/performance/calendar/cache tests passed");
