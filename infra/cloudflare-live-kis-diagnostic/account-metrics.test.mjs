import test from "node:test";
import assert from "node:assert/strict";
import { readAccountMetrics, summarizeAccountMetrics, summarizeWorkflowStorage } from "./account-metrics.mjs";
const at = "2026-10-19T04:52:15.618Z";
const payload = { data: { viewer: { accounts: [{ workers: [{ sum: { requests: 2 } }], doRequests: [], doCompute: [], dayWorkflows: [],
  monthStorage: [{ sum: { storageRate: 81543168 } }], sql: [
    { dimensions: { namespaceId: "one" }, max: { storedBytes: 100 } }, { dimensions: { namespaceId: "one" }, max: { storedBytes: 150 } },
    { dimensions: { namespaceId: "two" }, max: { storedBytes: 10 } }] }] } } };
test("today filter is UTC midnight, never the month-to-date step counter", async () => {
  const r = await readAccountMetrics({ token: "fixture-only", now: at, async fetchImpl(url, init) {
    assert.equal(url, "https://api.cloudflare.com/client/v4/graphql"); assert.equal(init.redirect, "error");
    const p = JSON.parse(init.body); assert.equal(p.variables.s, "2026-10-19T00:00:00Z"); assert.equal(p.variables.month, "2026-10-01");
    assert.match(p.query, /stepCount allStepCount/u, "sleep/wait operations must not disappear from the daily billing evidence");
    return Response.json(payload);
  } });
  assert.equal(r.workersRequestsReported, 2); assert.equal(r.doRequestsReported, null);
  assert.equal(r.persistentSqlNamespacePeakBytes, 160); assert.equal(r.completeAdmissionProof, false);
  assert.equal(r.workflowStorageGrowthRawMetric, 81543168); assert.equal(r.aggregationLagMs, null);
  assert.ok(!JSON.stringify(r).includes("fixture-only"));
});

test("official byte growth and unsampled complete rows produce only a reported-state upper bound, not a daily allowance or bill", () => {
  const schema = { fields: [{ name: "storageRate", description: "Instance storage size growth in timestamp (bytes)" }] };
  const rows = [{ sampleInterval: 1, storageRate: 100 }, { sampleInterval: 1, storageRate: -20 }, { sampleInterval: 1, storageRate: 50 }];
  const result = summarizeWorkflowStorage(rows, schema);
  assert.equal(result.positiveGrowthBytes, 150); assert.equal(result.reportedPeakEquivalentGbMonths, 150 / 1e9);
  assert.equal(result.admissionVerified, false); assert.equal(result.requiresZeroMonthBaselineInventory, true);
  assert.equal(summarizeWorkflowStorage([{ sampleInterval: 2, storageRate: 100 }], schema).positiveGrowthBytes, null);
  assert.equal(summarizeWorkflowStorage(rows, {}).positiveGrowthBytes, null);
  assert.equal(summarizeWorkflowStorage(Array(10000).fill(rows[0]), schema).positiveGrowthBytes, null);
});
test("analytics errors, authorization and query rate limits stop without retry or secret logging", async () => {
  let calls = 0;
  await assert.rejects(readAccountMetrics({ token: "fixture-only", now: at, async fetchImpl() { calls++; return Response.json({ errors: [{ extensions: { code: "budget" } }] }); } }), /RATE_LIMITED/u);
  assert.equal(calls, 1);
  await assert.rejects(readAccountMetrics({ token: "fixture-only", now: at, async fetchImpl() { return Response.json({}, { status: 403 }); } }), /NOT_AUTHORIZED/u);
  assert.throws(() => summarizeAccountMetrics({}, at), /ANALYTICS_INVALID/u);
});
