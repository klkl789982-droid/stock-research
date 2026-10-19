import test from "node:test";
import assert from "node:assert/strict";
import { readinessRequest, probeReadiness } from "./probe-official-readiness.mjs";

test("exact readiness uses basDt equality, never the exclusive begin=end range", () => {
  const exact = readinessRequest("2026-10-16", true), latest = readinessRequest("2026-10-16", false);
  assert.equal(exact.query.get("basDt"), "20261016");
  for (const request of [exact, latest]) {
    assert.equal(request.query.has("beginBasDt"), false); assert.equal(request.query.has("endBasDt"), false);
    assert.equal(request.query.get("numOfRows"), "5"); assert.equal(request.query.get("likeSrtnCd"), "005930");
  }
  assert.equal(latest.query.has("basDt"), false);
  assert.throws(() => readinessRequest("2026-02-30", true), /PROBE_DATE_REQUIRED/u);
});

test("bounded two-request probe reports actual exact-date response without prices or credential", async () => {
  const requests = [], key = "synthetic-test-only";
  const result = await probeReadiness({ date: "2026-10-16", serviceKey: key, fetchImpl: async (url, options) => {
    const u = new URL(url); requests.push(u);
    assert.equal(options.redirect, "error"); assert.equal(options.cache, "no-store");
    return Response.json({ response: { header: { resultCode: "00" }, body: { totalCount: 1,
      items: { item: [{ srtnCd: "005930", basDt: "20261016", clpr: "12345" }] } } } });
  } });
  assert.equal(requests.length, 2); assert.equal(requests[1].searchParams.get("basDt"), "20261016");
  assert.ok(result.results.every(r => r.targetFound && r.totalCount === 1 && /^[a-f0-9]{64}$/u.test(r.rawBodySha256)));
  assert.ok(!JSON.stringify(result).includes(key)); assert.ok(!JSON.stringify(result).includes("12345"));
  assert.ok(!JSON.stringify(result).includes("clpr"));
});

test("zero exact rows and transport failure never fabricate availability", async () => {
  let calls = 0;
  const result = await probeReadiness({ date: "2026-10-16", serviceKey: "test-only", fetchImpl: async () => {
    if (calls++ === 0) throw new Error("sensitive URL must not be printed");
    return Response.json({ response: { header: { resultCode: "00" }, body: { totalCount: 0, items: {} } } });
  } });
  assert.equal(calls, 2); assert.equal(result.results[0].reason, "PROBE_TRANSPORT_FAILED");
  assert.equal(result.results[1].targetFound, false); assert.equal(result.results[1].totalCount, 0);
  assert.ok(!JSON.stringify(result).includes("sensitive"));
});
