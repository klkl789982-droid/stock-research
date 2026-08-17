import assert from "node:assert/strict";
import { createPublicEodQuery, createPublicEodRequestShape, createPublicEodSingleFlight, evaluatePublicEodCandidate, normalizePublicEodRows, publicEodRequestFingerprint } from "../lib/public-eod-request.mjs";

const shape = (overrides = {}) => createPublicEodRequestShape({ code: "A005930", purpose: "historyCollection", endBasDt: "20260813", pageNo: 1, numOfRows: 260, resultType: "json", ...overrides });
assert.notEqual(publicEodRequestFingerprint(shape()), publicEodRequestFingerprint(shape({ endBasDt: "20260812" })));
assert.notEqual(publicEodRequestFingerprint(shape()), publicEodRequestFingerprint(shape({ purpose: "latestProbe", endBasDt: null })));
assert.notEqual(publicEodRequestFingerprint(shape()), publicEodRequestFingerprint(shape({ pageNo: 2 })));
assert.notEqual(publicEodRequestFingerprint(shape()), publicEodRequestFingerprint(shape({ numOfRows: 100 })));
assert.notEqual(publicEodRequestFingerprint(shape()), publicEodRequestFingerprint(shape({ resultType: "xml" })));
assert.match(createPublicEodQuery(shape()).toString(), /endBasDt=20260813/);
assert.throws(() => shape({ beginBasDt: "2026-08-13" }));
assert.equal(publicEodRequestFingerprint(shape()), publicEodRequestFingerprint(shape()));
assert.doesNotMatch(JSON.stringify(shape()), /serviceKey|token|secret/i);

const singleFlight = createPublicEodSingleFlight(); let calls = 0;
const loader = async () => { calls += 1; return { ok: true }; };
await Promise.all([singleFlight.run(shape(), loader), singleFlight.run(shape(), loader)]);
assert.equal(calls, 1);
const failedShape = shape({ pageNo: 9 });
await assert.rejects(() => singleFlight.run(failedShape, async () => { throw new Error("failed"); }));
await singleFlight.run(failedShape, loader); assert.equal(calls, 2, "실패 결과는 cache하면 안 됩니다.");

const normalized = normalizePublicEodRows([{ srtnCd: "005930", basDt: "20260812" }, { srtnCd: "A005930", basDt: "20260814" }, { srtnCd: "005930", basDt: "20260813" }], { code: "005930", requestedDate: "20260813" });
assert.deepEqual(normalized.rows.map((row) => row.basDt), ["20260813", "20260812"]);
assert.equal(normalized.futureRowCount, 1); assert.equal(normalized.exactDateFound, true);
assert.equal(normalizePublicEodRows([{ srtnCd: "005930", basDt: "20260812" }], { code: "005930", requestedDate: "20260813" }).exactDateFound, false);
assert.throws(() => normalizePublicEodRows([{ srtnCd: "005930", basDt: "20260813" }, { srtnCd: "005930", basDt: "20260813" }], { code: "005930", requestedDate: "20260813" }));
assert.equal(createPublicEodRequestShape({ code: "0009K0" }).code, "0009K0");
assert.equal(evaluatePublicEodCandidate({ requestedDate: "20260813", latestDates: Array(553).fill("20260813") }).approved, true);
const split = evaluatePublicEodCandidate({ requestedDate: "20260813", latestDates: [...Array(3).fill("20260813"), ...Array(550).fill("20260812")] });
assert.equal(split.status, "FULL_UNIVERSE_DATE_MISMATCH"); assert.equal(split.approved, false); assert.equal(split.distribution["20260812"], 550);
assert.equal(evaluatePublicEodCandidate({ requestedDate: "20260813", latestDates: Array(553).fill("20260813"), existingLatestDate: "20260813" }).status, "NO_NEW_OFFICIAL_EOD");
assert.equal(evaluatePublicEodCandidate({ requestedDate: "20260812", latestDates: Array(553).fill("20260812"), existingLatestDate: "20260813" }).status, "CANDIDATE_OLDER_THAN_HISTORY");
console.log("공공 일봉 canonical query·fingerprint·single-flight·정규화 테스트 통과");
