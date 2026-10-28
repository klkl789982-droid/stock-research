import test from "node:test";
import assert from "node:assert/strict";
import { runCompoundReplay } from "./compound-replay.mjs";

test("139 real shard batches +553 formula inputs +2ms receipt skew + transient retries + restart + lost relay ack", async t => {
  const r = await runCompoundReplay({ retryEvery: 20, restartAfter: 553, dropRelayAck: true });
  t.diagnostic(JSON.stringify(r));
  assert.equal(r.batches, 139); assert.equal(r.peakActive, 8); assert.ok(r.peakPending > 200);
  assert.equal(r.completed, 553); assert.equal(r.outbox, true); assert.equal(r.topRows, 20);
  assert.equal(r.formulaMatch, true); assert.equal(r.readback, true); assert.equal(r.immutableFirstIssuance, true);
  assert.equal(r.relayError, "PRIVATE_STORE_NETWORK_FAILED"); assert.deepEqual(r.errors, {});
  assert.ok(r.minActualStartSpacingMs >= 200); assert.ok(r.simulatedMarketCalls <= 1400); assert.ok(r.peakInvocationCalls < 50);
  assert.equal(r.activeAfter, 0); assert.equal(r.pendingAfter, 0); assert.ok(r.meter.w < 34000);
  assert.equal(r.batchesOverInvocationDeadline, 0);
});

test("same combined topology without receipt fix reproduces the false clock rejection", async t => {
  const r = await runCompoundReplay({ receiptFix: false }); t.diagnostic(JSON.stringify(r));
  assert.equal(r.outbox, false); assert.ok(r.errors.LIVE_CLOUD_RATE_EVIDENCE_INVALID > 0);
  assert.equal(r.activeAfter, 0); assert.equal(r.pendingAfter, 0);
});

test("persistent provider failure never becomes partial publication while other batches drain", async t => {
  const r = await runCompoundReplay({ persistentCode: "900013", retryEvery: 35 }); t.diagnostic(JSON.stringify(r));
  assert.equal(r.outbox, false); assert.equal(r.finishError, "KIS_HTTP_500"); assert.equal(r.errors.KIS_HTTP_500, 1);
  assert.equal(r.completed, 553); assert.equal(r.activeAfter, 0); assert.equal(r.pendingAfter, 0);
});

test("hard market-close deadline settles the queue and blocks partial ranking", async t => {
  const r = await runCompoundReplay({ startOffset: 5399000, responseMs: 100 }); t.diagnostic(JSON.stringify(r));
  assert.equal(r.outbox, false); assert.ok(Object.keys(r.errors).some(c => /WINDOW|DEADLINE/u.test(c)));
  assert.equal(r.activeAfter, 0); assert.equal(r.pendingAfter, 0);
});

test("250ms provider latency exhausts stale reservations before fix; unused-slot retirement completes unchanged553", async t => {
  const before = await runCompoundReplay({ responseMs: 250, retireUnused: false, deferMinute: false });
  const after = await runCompoundReplay({ responseMs: 250, restartAfter: 553, dropRelayAck: true });
  t.diagnostic(JSON.stringify({ before, after }));
  assert.equal(before.outbox, false); assert.equal(before.reservedSlots, 1400); assert.ok(before.simulatedMarketCalls < 1400);
  assert.equal(after.outbox, true); assert.equal(after.completed, 553); assert.equal(after.retiredUnused, 0);
  assert.equal(after.simulatedMarketCalls, 1106); assert.equal(after.reservedSlots - after.retiredUnused, 1106);
  assert.equal(after.formulaMatch, true); assert.equal(after.readback, true); assert.ok(after.minActualStartSpacingMs >= 200);
  assert.equal(after.batchesOverInvocationDeadline, 0);
});

test("slow responses plus twice-retried timeouts stay bounded; widespread failures still hit original1400 cap", async t => {
  const recovered = await runCompoundReplay({ responseMs: 250, retryEvery: 50, transportTimeout: true });
  const exhausted = await runCompoundReplay({ retryEvery: 2 });
  t.diagnostic(JSON.stringify({ recovered, exhausted }));
  assert.equal(recovered.outbox, true); assert.equal(recovered.formulaMatch, true);
  assert.equal(recovered.batchesOverInvocationDeadline, 0);
  assert.equal(recovered.activeAfter, 0); assert.equal(recovered.pendingAfter, 0);
  assert.equal(exhausted.outbox, false); assert.ok(exhausted.simulatedMarketCalls <= 1400);
  assert.equal(exhausted.reservedSlots - exhausted.retiredUnused, 1400);
  assert.equal(exhausted.activeAfter, 0); assert.equal(exhausted.pendingAfter, 0);
});

test("SQL collection reserve exhaustion leaves diagnostic budget and cannot publish partial results", async t => {
  const r = await runCompoundReplay({ budgetNear: true }); t.diagnostic(JSON.stringify(r));
  assert.equal(r.outbox, false); assert.equal(r.finishError, "LIVE_CLOUD_SQL_BUDGET");
  assert.equal(r.pendingAfter, 0); assert.equal(r.activeAfter, 0); assert.ok(r.meter.w < 40000);
});

test("350ms control round trips +15s timeouts +lost completion ACKs still fit the unchanged invocation deadline", async t => {
  const r = await runCompoundReplay({ responseMs: 250, controlMs: 350, retryEvery: 50, transportTimeout: true, dropCompletionEvery: 30 });
  t.diagnostic(JSON.stringify(r));
  assert.equal(r.outbox, true); assert.equal(r.formulaMatch, true); assert.equal(r.readback, true);
  assert.equal(r.batchesOverInvocationDeadline, 0); assert.equal(r.simulatedMarketCalls, 1130);
  assert.equal(r.controls["/slot-pair-complete"], 572); assert.ok(r.peakInvocationCalls < 50);
  assert.equal(r.activeAfter, 0); assert.equal(r.pendingAfter, 0);
});
