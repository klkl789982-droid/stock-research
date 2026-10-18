import test from "node:test";
import assert from "node:assert/strict";
import { FREE_LIMITS, reviewFreeBudget, nextUtcReset } from "./free-budget.mjs";
const nowMs = Date.parse("2026-10-18T17:00:00Z");
const snapshot = { observedAt: new Date(nowMs).toISOString(), utcDay: "2026-10-18", exact: true,
  aggregationLagMs: 0, upperBound: Object.fromEntries(Object.keys(FREE_LIMITS).map(name => [name, 0])) };
test("daily reset converts to 09:00 KST and does not reset retained storage", () => {
  assert.equal(nextUtcReset(nowMs), "2026-10-19T00:00:00.000Z");
  const result = reviewFreeBudget({ snapshot, nowMs });
  assert.equal(result.storageResetsDaily, false);
  assert.equal(result.status, "PLANNING_FITS");
  assert.equal(result.actualCollectionAuthorized, false);
});
test("rounded account totals never admit collection; EOD reserve remains held", () => {
  const result = reviewFreeBudget({ snapshot: { ...snapshot, exact: false, aggregationLagMs: null,
    upperBound: { ...snapshot.upperBound, sqlRowsRead: 3100000, sqlRowsWritten: 62980 } }, nowMs });
  assert.equal(result.status, "BLOCKED");
  assert.ok(result.reasons.includes("BUDGET_INSUFFICIENT_sqlRowsRead"));
  assert.ok(result.reasons.includes("BUDGET_INSUFFICIENT_sqlRowsWritten"));
  assert.equal(result.remainingAfterOperationalReserve.workerRequests, 99000);
});
test("future reset does not silently zero counters or grant free budget", () => {
  const result = reviewFreeBudget({ snapshot, nowMs: Date.parse("2026-10-19T04:00:00Z") });
  assert.ok(result.reasons.includes("FRESH_POST_RESET_SNAPSHOT_REQUIRED"));
  assert.equal(result.status, "BLOCKED");
});
test("missing metric and retained storage exhaustion fail closed without paid fallback", () => {
  const used = { ...snapshot.upperBound, storageBytes: FREE_LIMITS.storageBytes };
  delete used.workflowSteps;
  const result = reviewFreeBudget({ snapshot: { ...snapshot, upperBound: used }, nowMs });
  assert.ok(result.reasons.includes("BUDGET_UNKNOWN_workflowSteps"));
  assert.ok(result.reasons.includes("BUDGET_INSUFFICIENT_storageBytes"));
  assert.equal(result.paidFallback, false);
});
