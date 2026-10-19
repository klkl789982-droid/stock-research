import test from "node:test";
import assert from "node:assert/strict";
import { readAccountMetrics, summarizeAccountMetrics } from "./account-metrics.mjs";
const at = "2026-10-19T04:52:15.618Z";
const payload = { data: { viewer: { accounts: [{ workers: [{ sum: { requests: 2 } }], doRequests: [], doCompute: [], dayWorkflows: [],
  monthStorage: [{ sum: { storageRate: 81543168 } }], sql: [
    { dimensions: { namespaceId: "one" }, max: { storedBytes: 100 } }, { dimensions: { namespaceId: "one" }, max: { storedBytes: 150 } },
    { dimensions: { namespaceId: "two" }, max: { storedBytes: 10 } }] }] } } };
test("today filter is UTC midnight, never the month-to-date step counter", async () => {
  const r = await readAccountMetrics({ token: "fixture-only", now: at, async fetchImpl(url, init) {
    assert.equal(url, "https://api.cloudflare.com/client/v4/graphql"); assert.equal(init.redirect, "error");
    const p = JSON.parse(init.body); assert.equal(p.variables.s, "2026-10-19T00:00:00Z"); assert.equal(p.variables.month, "2026-10-01");
    return Response.json(payload);
  } });
  assert.equal(r.workersRequestsReported, 2); assert.equal(r.doRequestsReported, null);
  assert.equal(r.persistentSqlNamespacePeakBytes, 160); assert.equal(r.completeAdmissionProof, false);
  assert.equal(r.workflowStorageGrowthRawMetric, 81543168); assert.equal(r.aggregationLagMs, null);
  assert.ok(!JSON.stringify(r).includes("fixture-only"));
});
test("analytics errors, authorization and query rate limits stop without retry or secret logging", async () => {
  let calls = 0;
  await assert.rejects(readAccountMetrics({ token: "fixture-only", now: at, async fetchImpl() { calls++; return Response.json({ errors: [{ extensions: { code: "budget" } }] }); } }), /RATE_LIMITED/u);
  assert.equal(calls, 1);
  await assert.rejects(readAccountMetrics({ token: "fixture-only", now: at, async fetchImpl() { return Response.json({}, { status: 403 }); } }), /NOT_AUTHORIZED/u);
  assert.throws(() => summarizeAccountMetrics({}, at), /ANALYTICS_INVALID/u);
});
