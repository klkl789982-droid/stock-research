import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildTransitionRows, observeMaTransition, parseTransitionFilters, screenTransitions, createTransitionObservationSnapshot, TRANSITION_RESEARCH_PROPOSAL } from "../lib/transition-screener.mjs";
import { intradaySeedHash } from "../lib/intraday-market-seed.mjs";
import { calculateMarketAnalysis } from "../lib/market-analysis-v1.mjs";
import { createTransitionStore } from "../lib/transition-screener-store.mjs";

const point = (date, ma5, ma20, ma60) => ({ date, ma5, ma20, ma60 });
const cross = observeMaTransition([point("2026-10-02", 100, 100, 110), point("2026-10-06", 101, 100, 110)], "5-20");
assert.equal(cross.status, "CROSS_OCCURRED");
assert.equal(cross.crossDate, "2026-10-06", "휴장일을 달력일로 계산하지 않습니다.");
assert.equal(cross.aboveTradingDays, 1);
assert.equal(observeMaTransition([point("2026-10-02", 100, 100, 100), point("2026-10-06", 100, 100, 100)], "5-20").status, "NONE");
assert.equal(observeMaTransition([point("2026-10-02", 101, 100, 100), point("2026-10-06", 102, 101, 100)], "20-60").status, "CROSS_OCCURRED");
const maintained = observeMaTransition([point("2026-10-01", 99, 100, 110), point("2026-10-02", 101, 100, 110), point("2026-10-06", 102, 100, 110), point("2026-10-07", 103, 100, 110)], "5-20");
assert.equal(maintained.status, "NONE", "3일 위에 유지됐어도 미승인 확인 신호를 생성하지 않습니다.");
assert.equal(maintained.aboveTradingDays, 3);
assert.equal(maintained.crossDate, "2026-10-02");
assert.equal(observeMaTransition([point("2026-10-01", 101, 100, 110), point("2026-10-02", 102, 100, 110)], "5-20").crossDate, null, "관측 범위 전의 교차를 추정하지 않습니다.");
assert.equal(TRANSITION_RESEARCH_PROPOSAL.approved, false);

const dates = [];
for (let value = new Date("2026-10-07T00:00:00Z"); dates.length < 260; value.setUTCDate(value.getUTCDate() - 1)) if (![0, 6].includes(value.getUTCDay())) dates.push(value.toISOString().slice(0, 10).replaceAll("-", ""));
const rows = dates.map((date, index) => [date, 1000 - index, 1010 - index, 990 - index, 1000 - index, 1000 + index]);
const history = { asOfDate: "2026-10-07", dataQuality: { structuralStatus: "passed", overallGrade: "REJECTED" }, sourceManifest: { sources: { officialDailyPrice: { normalizedInputHash: "source" } } }, records: ["000001", "0009K0", "000003"].map((code, index) => ({ code, name: `종목${index}`, market: index === 1 ? "KOSDAQ" : "KOSPI", qualityEligibility: { eligible: index < 2 }, scoresByVersion: { "A-v1": index ? null : 80 }, ranksByVersion: { "A-v1": index ? null : 1 }, scores: { modelB: 70, modelC: 60, modelD: 50 }, ranks: { modelB: 1, modelC: 1, modelD: 1 } })) };
const seed = { schemaVersion: 1, seedType: "intradayMarketAnalysisSeed", requestedDate: history.asOfDate, rowOrder: "descending", sourceManifest: structuredClone(history.sourceManifest),
  records: history.records.map((r, i) => ({ code: r.code, eligible: i < 2, officialAsOfDate: history.asOfDate, sourceHash: "source", rows: i < 2 ? structuredClone(rows) : [] })),
};
for (const record of history.records) record.closePrice = 1000;
const sign = (value) => { const { contentHash: ignored, ...base } = value; void ignored; value.contentHash = intradaySeedHash(base); return value; };
seed.records.sort((a, b) => a.code.localeCompare(b.code));
sign(seed);
const calendar = { dates: { "2026-10-07": { status: "tradingDay" }, "2026-10-06": { status: "tradingDay" } } };
const inputs = { history, seed, calendar };
const before = structuredClone(inputs);
const built = buildTransitionRows(inputs);
assert.equal(built.length, 3);
assert.equal(built[2].qualityStatus, "UNAVAILABLE");
assert.equal(built[1].models["A-v1"].score, null, "결측 모델 점수를 0으로 바꾸지 않습니다.");
const analysis = calculateMarketAnalysis(rows.map(([basDt, mkp, hipr, lopr, clpr, trqu]) => ({ basDt, mkp, hipr, lopr, clpr, trqu })));
assert.equal(built[0].indicators.rsi, analysis.indicators.rsi14);
assert.equal(built[0].indicators.volumeMultiple, analysis.indicators.volumeRatio / 100);
assert.equal(built[0].indicators.dailyChangePercent, analysis.indicators.dailyReturn);
assert.deepEqual(inputs, before, "기존 입력/점수/snapshot은 불변입니다.");
assert.deepEqual(built, buildTransitionRows(inputs));

const filters = (query = "") => parseTransitionFilters(new URLSearchParams(query));
assert.equal(screenTransitions(built, filters()).results.length, 2);
const screened = screenTransitions(built, filters("market=KOSPI&rsiMin=0&rsiMax=100&volumeMin=0&changeMin=0&scoreA=70&scoreB=60&scoreC=50&scoreD=40"));
assert.equal(screened.results.length, 1);
assert.equal(screened.exclusions.dataMissing, 1);
assert.equal(screened.exclusions.filterMissing, 1, "결측과 조건 미충족은 별도입니다.");
assert.equal(screenTransitions(built, filters("scoreB=90")).exclusions.conditionNotMet, 2);
assert.equal(screenTransitions(built, filters("scoreA=0")).exclusions.filterMissing, 1);
assert.equal(screenTransitions(built, filters("model=A-v1&sort=score&direction=desc")).results.at(-1).score, null, "결측 정렬은 내림차순에서도 마지막입니다.");
for (const query of ["rsiMin=-1", "rsiMax=101", "rsiMin=70&rsiMax=20", "volumeMin=-2", "scoreA=NaN", "scoreA=0xff", "pair=toString", "state=APPROACHING", "state=CONFIRMED", "model=__proto__", "macd=foo", "changeMin=5&changeMax=1"]) assert.throws(() => filters(query), /FILTER_INVALID/);
const fail = (modify, expected) => { const value = structuredClone(inputs); modify(value); assert.throws(() => buildTransitionRows(value), expected); };
fail((v) => { v.seed.records[0].rows[0][0] = "20261008"; sign(v.seed); }, /SEED_INVALID/);
fail((v) => { v.seed.requestedDate = "2026-10-06"; }, /DATE_MISMATCH/);
fail((v) => { v.seed.contentHash = "corrupt"; }, /SEED_INVALID/);
fail((v) => { v.history.sourceManifest.sources.officialDailyPrice.normalizedInputHash = "other"; }, /SOURCE_MISMATCH/);
fail((v) => { v.calendar.dates[history.asOfDate].status = "marketClosed"; }, /TRADING_DATE_UNVERIFIED/);
const missingBar = structuredClone(inputs);
missingBar.seed.records[0].rows.splice(1, 1); missingBar.seed.records[0].rows.push(["20250101", 700, 710, 690, 700, 100]); sign(missingBar.seed);
assert.ok(buildTransitionRows(missingBar)[0].missingReasons.includes("missingTradingBar"));
const allMissingBar = structuredClone(inputs);
for (const record of allMissingBar.seed.records.filter((r) => r.eligible)) { record.rows.splice(1, 1); record.rows.push(["20250101", 700, 710, 690, 700, 100]); }
sign(allMissingBar.seed);
assert.ok(buildTransitionRows(allMissingBar)[0].missingReasons.includes("missingTradingBar"), "所有 종목이 동일 거래일 봉을 놓쳐도 알려진 거래일로 차단합니다.");
const priceMismatch = structuredClone(inputs); priceMismatch.history.records[0].closePrice = 999;
assert.ok(buildTransitionRows(priceMismatch)[0].missingReasons.includes("officialCloseMismatch"));
const zeroVolume = structuredClone(inputs); zeroVolume.seed.records[0].rows[0][5] = 0; sign(zeroVolume.seed);
assert.ok(buildTransitionRows(zeroVolume)[0].missingReasons.includes("noTradingVolume"));
const observations = createTransitionObservationSnapshot({ rows: built, history, seed });
assert.equal(observations.futureOutcomes.entryContract, null);
assert.equal(observations.futureOutcomes.status, "NOT_OBSERVED");
assert.equal(observations.records.length, 2);
assert.deepEqual(observations, createTransitionObservationSnapshot({ rows: built, history, seed }));

const root = await mkdtemp(path.join(os.tmpdir(), "tb-transition-test-"));
try {
  for (const dir of ["data/history", "data/analysis/market-seeds", "data/trading-calendar"]) await mkdir(path.join(root, dir), { recursive: true });
  await writeFile(path.join(root, "data/history/2026-10-07.json"), JSON.stringify(history));
  await writeFile(path.join(root, "data/analysis/market-seeds/2026-10-07.json"), JSON.stringify(seed));
  await writeFile(path.join(root, "data/trading-calendar/status.json"), JSON.stringify(calendar));
  const load = createTransitionStore({ root });
  const [one, two, three] = await Promise.all([load(), load(), load()]);
  assert.strictEqual(one, two); assert.strictEqual(two, three, "동시 요청은 하나의 계산 결과를 공유합니다.");
  assert.strictEqual(await load(), one);
  const updated = structuredClone(history); updated.records[0].scoresByVersion["A-v1"] = 100.123;
  await writeFile(path.join(root, "data/history/2026-10-07.json"), JSON.stringify(updated));
  assert.equal((await load()).rows[0].models["A-v1"].score, 100.123, "파일 변경 시 캐시를 무효화합니다.");
  await writeFile(path.join(root, "data/history/2026-10-08.json"), JSON.stringify({ ...history, asOfDate: "2026-10-08" }));
  await assert.rejects(load(), /ENOENT/, "최신 seed가 없으면 이전 기준일로 조용히 후퇴하지 않습니다.");
} finally { await rm(root, { recursive: true, force: true }); }
console.log("transition screener cross/equality/dates/AND/missing/quality/no-lookahead/cache/single-flight/isolation tests passed");
