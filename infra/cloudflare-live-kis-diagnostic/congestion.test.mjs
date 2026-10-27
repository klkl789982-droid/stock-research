import test from "node:test";
import assert from "node:assert/strict";
import { replayCongestion } from "./congestion-replay.mjs";
import { ProductionDayState as Before } from "./incident-baseline.mjs";

test("actual70 batch topology reproduces baseline SQL exhaustion and fixes all553 without relaxing cap", async t => {
  const before = await replayCongestion({ State: Before }), after = await replayCongestion();
  assert.equal(before.finishError, "LIVE_CLOUD_SQL_BUDGET"); assert.ok(before.completed < 553);
  assert.equal(before.batches,70);assert.equal(after.completed, 553); assert.equal(after.batches, 139); assert.equal(after.peakGlobalActive, 8);
  assert.equal(after.outbox, true); assert.deepEqual(after.errors, {});
  assert.ok(after.stats.usageUpdates < before.stats.usageUpdates / 100);
  assert.ok(after.meter.w < 15000); assert.ok(after.collectionSpanMs < 245000);
  t.diagnostic(JSON.stringify({ before, after }));
});
test("queued responses complete while the first collector failure remains the outbox blocker", async () => {
  const slow = await replayCongestion({ delay: 180 });
  assert.equal(slow.completed, 553); assert.equal(slow.outbox, true); assert.equal(slow.peakGlobalActive, 8);
  const failed = await replayCongestion({ failCode: "900001" });
  assert.equal(failed.completed, 553); assert.equal(failed.outbox, false);
  assert.equal(failed.finishError, "KIS_HTTP_500");
});
test("deadline settles queued callers; collection budget reserves finalization diagnostics", async () => {
  const late = await replayCongestion({ stopAt: 100000 });
  assert.equal(late.outbox, false); assert.ok(late.errors.LIVE_CLOUD_WINDOW_EXPIRED > 0);
  const near = await replayCongestion({ budgetNear: true });
  assert.equal(near.outbox, false); assert.ok(near.errors.LIVE_CLOUD_SQL_BUDGET > 0);
  assert.equal(near.finishError, "LIVE_CLOUD_SQL_BUDGET");
});
