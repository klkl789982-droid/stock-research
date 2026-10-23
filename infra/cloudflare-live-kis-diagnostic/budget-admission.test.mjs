import test from "node:test";
import assert from "node:assert/strict";
import { admitFreeBudget } from "./budget-admission.mjs";
const latest = { observedAt: "2026-10-19T10:17:08.891Z", utcDay: "2026-10-19", workflowAllOperationsReported: 99,
  workersRequestsReported: 96, doRequestsReported: 1209, doDurationRawMetric: 2166.5725888, sqlRowsReadReported: 1886542,
  sqlRowsWrittenReported: 32814, doDurationUnit: "GB_SECONDS_OFFICIAL_SCHEMA", persistentSqlNamespacePeakBytes: 2908160,
  workflowStorageEvidence: { unit: "BYTES_OFFICIAL_SCHEMA", completeUnsampledRows: true, positiveGrowthBytes: 87212032 } };
const before = { ...latest, observedAt: "2026-10-19T09:10:00Z" };
const inventory = { checkedAt: latest.observedAt, workerCount: 4, workflowCount: 3, activeInstances: 0, allPagesRead: true,
  zeroMonthOpeningWorkflowState: true, onlyDailyCronActive: true, noAdditionalCollectionSinceLastReceipt: true };
const args = () => structuredClone({ before, latest, inventory, workersFree: true, noPaymentMethod: true });
test("settled reported counters plus explicit unreported-work reservation, not exact-zero delay", () => {
  const v = admitFreeBudget(args(), Date.parse(latest.observedAt));
  assert.equal(v.upperBound.sqlRowsWritten, 42814); assert.equal(v.headroomAfterAnotherWholeNormalDay.sqlRowsWritten, 2186);
  assert.equal(v.workflowStorageGbMonthsUpperBound, 0.184424064); assert.equal(v.persistentSqlBytes, 100000000);
  assert.equal(v.sqlDailyCapBytes, 8000000);
  assert.equal(v.aggregationLagMs, null); assert.equal(v.exactBillingClaimed, false); assert.equal(v.paidFallback, false);
});
test("unknown resources, active instances, stale metrics, sampling and excess budget block", () => {
  for (const mutate of [x => x.inventory.activeInstances = 1, x => x.inventory.allPagesRead = false,
    x => x.latest.sqlRowsWrittenReported = 60000, x => x.latest.workflowStorageEvidence.completeUnsampledRows = false,
    x => x.workersFree = false, x => x.latest.observedAt = x.before.observedAt]) {
    const a = args(); mutate(a); assert.throws(() => admitFreeBudget(a, Date.parse(latest.observedAt)), /FREE_/u);
  }
});
