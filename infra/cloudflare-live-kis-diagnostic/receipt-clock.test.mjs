import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { ProductionDayState } from "./production-state.mjs";
import { syntheticProductionInputs } from "./swing-fixture.mjs";
import { bounds } from "./production-core.mjs";
import { completeWithReceiptClock, extraWithReceiptClock } from "./receipt-clock.mjs";

async function fixture(t, ahead = 2, { frozen = false } = {}) {
  const db = new DatabaseSync(":memory:"); t.after(() => db.close());
  const input = syntheticProductionInputs({ date: "2002-01-03", seedDate: "2001-12-28" }), date = input.date, b = bounds(date);
  let now = b.start - 1000, waits = 0, waitingUnderLock = false;
  const sql = { get databaseSize() { return db.prepare("PRAGMA page_count").get().page_count * 4096; }, exec(q, ...args) {
    const rows = db.prepare(q).all(...args); return { rowsRead: rows.length + 1, rowsWritten: /^(INSERT|UPDATE)/u.test(q) ? 2 : 0, toArray: () => rows }; } };
  const state = new ProductionDayState({ sql, now: () => now,
    env: { LIVE_PRODUCTION_ENABLED: "true", LIVE_PRODUCER: "cloud", LIVE_CUTOVER_RECEIPT_HASH: "f".repeat(64) },
    transaction(fn) { db.exec("BEGIN"); try { const r = fn(); db.exec("COMMIT"); return r; } catch (e) { db.exec("ROLLBACK"); throw e; } },
    prepare: async () => ({ ...input.prepared, remoteCheckedAt: new Date(now).toISOString() }), bundle: async () => ({}),
    wait: async ms => { waits++; waitingUnderLock ||= state.controlDepth > 0 || state.inTransaction === true; if (!frozen) now += ms; },
  });
  await state.prepare(date, true); now = b.start;
  const code = input.prepared.codes[0], lease = await state.acquire(date, code);
  now = lease.minuteSlot.notBefore;
  const calls = [["quote", lease.quoteSlot], ["minute", lease.minuteSlot]].map(([kind, s]) => ({ kind, slot: s.slot, started: s.notBefore, completed: s.notBefore + ahead, status: 200 }));
  const value = { metadata: input.rows[0], calls };
  return { state, date, code, value, b, now: () => now, set: n => { now = n; }, waits: () => waits, waitingUnderLock: () => waitingUnderLock };
}
test("before fix: actual 1/2ms receiver-clock skew rejects an otherwise valid completion", async t => {
  for (const ahead of [1, 2]) {
    const f = await fixture(t, ahead);
    assert.throws(() => f.state.complete(f.date, f.code, f.value), /RATE_EVIDENCE_INVALID/u);
    assert.equal(f.state.read(`rate-rejection:${f.code}`).issue, "RESPONSE_AFTER_RECEIVER_CLOCK");
    assert.equal(f.state.read(`rate-rejection:${f.code}`).completionAheadMs, ahead);
  }
});
test("refreshed receipt clock preserves original timestamps and strict validator, without SQL lock during I/O", async t => {
  for (const ahead of [1, 2, 25]) {
    const f = await fixture(t, ahead), original = structuredClone(f.value);
    assert.deepEqual(await completeWithReceiptClock(f.state, f.date, f.code, f.value), { stored: true });
    assert.deepEqual(f.value, original); assert.ok(f.now() >= f.value.calls.at(-1).completed);
    assert.equal(f.waits(), 1); assert.equal(f.waitingUnderLock(), false);
    assert.deepEqual(f.state.read(`observation:${f.code}`), original.metadata);
    assert.equal(f.state.read(`rate-rejection:${f.code}`), null);
    const duplicate = await f.state.acquire(f.date, f.code); assert.deepEqual(duplicate.existing, original.metadata);
  }
});
test("large future timestamps and a non-advancing clock remain rejected, with finite waits", async t => {
  for (const [ahead, frozen] of [[26, false], [2000, false], [2, true]]) {
    const f = await fixture(t, ahead, { frozen });
    await assert.rejects(completeWithReceiptClock(f.state, f.date, f.code, f.value), /RATE_EVIDENCE_INVALID/u);
    assert.equal(f.state.read(`observation:${f.code}`), null); assert.ok(f.waits() <= 3);
    if (ahead > 25) assert.equal(f.waits(), 0);
  }
});
test("receipt wait cannot legalize late starts, reversed timestamps or wrong durable slots", async t => {
  for (const kind of ["late", "reversed", "identity"]) {
    const f = await fixture(t, 2), c = f.value.calls[0];
    if (kind === "late") { c.started += 21; c.completed = c.started + 1; }
    if (kind === "reversed") c.completed = c.started - 1;
    if (kind === "identity") c.slot++;
    await assert.rejects(completeWithReceiptClock(f.state, f.date, f.code, f.value), /RATE_EVIDENCE_INVALID/u);
    assert.equal(f.state.read(`observation:${f.code}`), null);
  }
});
test("an existing error result never becomes a normal observation", async t => {
  const f = await fixture(t, 2); f.value.metadata = { code: f.code, reason: "KIS_HTTP_500", rawPricesStored: false };
  await completeWithReceiptClock(f.state, f.date, f.code, f.value);
  assert.equal(f.state.read(`observation:${f.code}`).reason, "KIS_HTTP_500");
  assert.equal(f.state.read(`observation:${f.code}`).status, undefined);
  assert.equal(f.state.read("outbox"), null);
});
test("ownership cancellation during the I/O wait is still enforced by the original validator", async t => {
  const f = await fixture(t, 2);
  f.state.wait = async ms => { f.set(f.now() + ms); f.state.write("revoked", { revoked: true }); };
  await assert.rejects(completeWithReceiptClock(f.state, f.date, f.code, f.value), /OWNER_REVOKED/u);
  assert.equal(f.state.read(`observation:${f.code}`), null);
});
test("timer failure still runs the strict validator and releases the terminal lease",async t=>{
  const f=await fixture(t,2);f.state.wait=async()=>{throw Error("synthetic timer failed");};
  await assert.rejects(completeWithReceiptClock(f.state,f.date,f.code,f.value),/RATE_EVIDENCE_INVALID/u);
  assert.equal(f.state.q("SELECT completed FROM leases WHERE code=?",f.code)[0].completed,1);
  assert.equal(f.state.read(`observation:${f.code}`),null);
});

test("expired unused slot replacement preserves gross counts and tombstones across restart", async t => {
  const f = await fixture(t, 2), old = f.value.calls[1]; f.set(old.started + 30);
  const next = f.state.extra(f.date, f.code, "minute", [old.slot]);
  assert.ok(next.slot > old.slot);
  assert.deepEqual(f.state.read("allocator"), { head: next.slot + 1, count: 3, retiredUnused: 1 });
  const replay = f.state.extra(f.date, f.code, "minute", [old.slot]);
  assert.equal(f.state.read("allocator").retiredUnused, 1, "repeated tombstone cannot refund twice");
  assert.equal(f.state.read("allocator").count, 4);
  const reopened = new ProductionDayState({ sql: f.state.sql, env: f.state.env, now: f.state.now, transaction: f.state.transaction });
  assert.deepEqual(reopened.read("allocator"), f.state.read("allocator"));
  await assert.rejects(reopened.acquire(f.date, f.code, { deferMinute: true }), /ALREADY_RESERVED/u);
  f.set(replay.notBefore + 10);
  assert.throws(() => f.state.complete(f.date, f.code, f.value), /RETIRED_SLOT_USED/u);
  assert.equal(f.state.read(`observation:${f.code}`), null);
});

test("failed replacement rolls back unused-slot credit and keeps the original reservation", async t => {
  const f = await fixture(t, 2), old = f.value.calls[1]; f.set(old.started + 30);
  f.state.write("allocator", { head: Math.ceil(f.b.end / 220), count: 2, retiredUnused: 0 }, true);
  const prior = f.state.read("allocator");
  assert.throws(() => f.state.extra(f.date, f.code, "minute", [old.slot]), /RETRY_BUDGET/u);
  assert.deepEqual(f.state.read("allocator"), prior);
  assert.equal(f.state.q("SELECT body FROM slots WHERE slot=?", old.slot)[0].body, null);
});

test("unused-slot retirement rejects early, foreign, wrong-kind, duplicate and sent cells atomically", async t => {
  for (const mode of ["early", "foreign", "kind", "duplicate", "sent"]) {
    const f = await fixture(t, 2), old = f.value.calls[1]; f.set(old.started + (mode === "early" ? 20 : 30));
    if (mode === "sent") f.state.q("UPDATE slots SET body=? WHERE slot=?", JSON.stringify(old), old.slot);
    const before = f.state.read("allocator"), slots = mode === "duplicate" ? [old.slot, old.slot] : [mode === "foreign" ? old.slot + 10000 : old.slot];
    assert.throws(() => f.state.extra(f.date, f.code, mode === "kind" ? "quote" : "minute", slots), /SKIP_INVALID/u);
    assert.deepEqual(f.state.read("allocator"), before);
    const row = f.state.q("SELECT body FROM slots WHERE slot=?", old.slot)[0];
    assert.equal(row.body === null, mode !== "sent");
  }
});

test("the same cross-isolate clock boundary is handled for missed slots without allowing early cancellation", async t => {
  const f = await fixture(t, 2), missed = f.value.calls[1].slot;
  f.set(missed * 220 + 19);
  assert.throws(() => f.state.extra(f.date, f.code, "minute", [missed]), /SKIP_INVALID/u);
  const next = await extraWithReceiptClock(f.state, f.date, f.code, "minute", [missed]);
  assert.ok(f.now() >= missed * 220 + 21); assert.ok(next.slot > missed); assert.equal(f.waitingUnderLock(), false);
  assert.equal(f.state.read("allocator").retiredUnused, 1);
  const future = await fixture(t, 2); future.set(future.value.calls[1].started - 100);
  await assert.rejects(extraWithReceiptClock(future.state, future.date, future.code, "minute", [future.value.calls[1].slot]), /SKIP_INVALID/u);
  assert.equal(future.waits(), 0);
});
