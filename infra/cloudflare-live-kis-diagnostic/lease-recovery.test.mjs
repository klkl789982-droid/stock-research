import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { ProductionDayState } from "./production-state.mjs";
import { syntheticProductionInputs } from "./swing-fixture.mjs";
import { bounds } from "./production-core.mjs";

const id = "12345678-1234-4123-8123-123456789abc";
const other = "12345678-1234-4123-8123-123456789abd";
function fixture(t) {
  const db = new DatabaseSync(":memory:"); t.after(() => db.close());
  const input = syntheticProductionInputs({ date: "2002-01-03", seedDate: "2001-12-28" }), b = bounds(input.date);
  let now = b.start - 1000, bundled = 0, bundleFailure = false;
  const sql = { get databaseSize() { return db.prepare("PRAGMA page_count").get().page_count * 4096; }, exec(query, ...args) {
    const rows = db.prepare(query).all(...args);
    return { toArray: () => rows, rowsRead: rows.length + 1, rowsWritten: /^(INSERT|UPDATE)/u.test(query) ? 2 : 0 };
  } };
  const options = { sql, now: () => now, env: { LIVE_PRODUCTION_ENABLED: "true", LIVE_PRODUCER: "cloud", LIVE_CUTOVER_RECEIPT_HASH: "a".repeat(64) },
    prepare: async () => ({ ...input.prepared, remoteCheckedAt: new Date(now).toISOString() }),
    bundle: async () => { bundled++; if (bundleFailure) throw new Error("LIVE_CLOUD_PIN_UNAVAILABLE"); return { record: { eligible: true }, authenticationRecord: { accessToken: "fixture-not-a-real-secret" } }; },
    transaction: fn => { db.exec("BEGIN"); try { const result = fn(); db.exec("COMMIT"); return result; } catch (e) { db.exec("ROLLBACK"); throw e; } },
    scheduleDeadline: () => () => {} };
  return { db, input, b, options, state: new ProductionDayState(options), code: input.prepared.codes[0],
    set: value => { now = value; }, bundled: () => bundled, failBundle: () => { bundleFailure = true; } };
}
async function prepared(t) { const f = fixture(t); await f.state.prepare(f.input.date, true); f.set(f.b.start); return f; }
const opts = { acquisitionId: id, deferMinute: true };

test("lost lease response recovers the exact grant without allocating or calling market data again", async t => {
  const f = await prepared(t), first = await f.state.acquire(f.input.date, f.code, opts);
  const allocator = f.state.read("allocator"), grant = f.state.read(`lease-grant:${f.code}`);
  f.set(f.b.start + 1000);
  const recovered = await f.state.acquire(f.input.date, f.code, opts);
  assert.deepEqual(recovered, first);
  assert.deepEqual(f.state.read("allocator"), allocator);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM leases").get().n, 1);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM slots").get().n, 1);
  assert.ok(!JSON.stringify(grant).includes("fixture-not-a-real-secret"));
  assert.ok(recovered.quoteSlot.notBefore < f.b.start + 1000, "replay never relabels an expired slot as a current slot");
  await assert.rejects(f.state.acquire(f.input.date, f.code, { ...opts, acquisitionId: other }), /ALREADY_RESERVED/);
  await assert.rejects(f.state.acquire(f.input.date, f.code), /ALREADY_RESERVED/);
});

test("same-invocation reconnect joins queued acquisition while another caller cannot", async t => {
  const f = await prepared(t), codes = f.input.prepared.codes;
  for (const code of codes.slice(0, 8)) await f.state.acquire(f.input.date, code);
  const waiting = f.state.acquire(f.input.date, codes[8], opts);
  const reconnected = f.state.acquire(f.input.date, codes[8], opts);
  await assert.rejects(f.state.acquire(f.input.date, codes[8], { ...opts, acquisitionId: other }), /ALREADY_RESERVED/);
  assert.equal(f.state.pending.size, 1);
  f.state.complete(f.input.date, codes[0], { metadata: { code: codes[0], reason: "KIS_HTTP_500", rawPricesStored: false }, calls: [] });
  assert.deepEqual(await waiting, await reconnected);
  assert.equal(f.bundled(), 9);
  assert.equal(f.state.pending.size, 0);
});

test("restart after granted response loss recovers only its persisted identity and original slots", async t => {
  const f = await prepared(t), first = await f.state.acquire(f.input.date, f.code, opts);
  const reopened = new ProductionDayState(f.options), allocator = reopened.read("allocator");
  assert.deepEqual(await reopened.acquire(f.input.date, f.code, opts), first);
  assert.deepEqual(reopened.read("allocator"), allocator);
  await assert.rejects(reopened.acquire(f.input.date, f.code, { ...opts, acquisitionId: other }), /ALREADY_RESERVED/);
});

test("restart before grant retains queued owner; no grant proof never reclaims a legacy lease", async t => {
  const f = await prepared(t), codes = f.input.prepared.codes;
  for (const code of codes.slice(0, 8)) await f.state.acquire(f.input.date, code);
  const waiting = f.state.acquire(f.input.date, codes[8], opts).catch(e => e.message);
  const oldJob = f.state.pending.get(codes[8]);
  const reopened = new ProductionDayState(f.options);
  await assert.rejects(reopened.acquire(f.input.date, codes[8], { ...opts, acquisitionId: other }), /ALREADY_RESERVED/);
  await assert.rejects(reopened.acquire(f.input.date, codes[0], opts), /ALREADY_RESERVED/);
  const continued = reopened.acquire(f.input.date, codes[8], opts);
  reopened.complete(f.input.date, codes[0], { metadata: { code: codes[0], reason: "KIS_HTTP_500", rawPricesStored: false }, calls: [] });
  assert.ok((await continued).quoteSlot);
  oldJob.reject(new Error("synthetic disconnected old process"));
  assert.equal(await waiting, "synthetic disconnected old process");
});

test("bundle failure on recovery releases its lease and preserves failure without new reservations", async t => {
  const f = await prepared(t); await f.state.acquire(f.input.date, f.code, opts);
  const allocator = f.state.read("allocator"); f.failBundle();
  await assert.rejects(f.state.acquire(f.input.date, f.code, opts), /PIN_UNAVAILABLE/);
  assert.equal(f.db.prepare("SELECT completed FROM leases WHERE code=?").get(f.code).completed, 1);
  assert.equal(f.state.read(`observation:${f.code}`).reason, "LIVE_CLOUD_PIN_UNAVAILABLE");
  assert.deepEqual(f.state.read("allocator"), allocator);
  const previous = await f.state.acquire(f.input.date, f.code, opts);
  assert.equal(previous.existing.reason, "LIVE_CLOUD_PIN_UNAVAILABLE");
  assert.equal(previous.existing.status, undefined);
});

test("recovery cannot bypass cutoff, completed-without-evidence fence or invalid identity", async t => {
  const f = await prepared(t); await f.state.acquire(f.input.date, f.code, opts);
  await assert.rejects(f.state.acquire(f.input.date, f.code, { acquisitionId: "not-an-id" }), /ID_INVALID/);
  f.db.prepare("UPDATE leases SET completed=1 WHERE code=?").run(f.code);
  await assert.rejects(f.state.acquire(f.input.date, f.code, opts), /ALREADY_RESERVED/);
  f.set(f.b.end + 1);
  await assert.rejects(f.state.acquire(f.input.date, f.code, opts), /WINDOW_EXPIRED/);
});

test("recorded HTTP attempts and advanced minute reservations prohibit initial grant replay", async t => {
  const f = await prepared(t), first = await f.state.acquire(f.input.date, f.code, opts);
  f.db.prepare("UPDATE slots SET body=? WHERE slot=?").run(JSON.stringify({ status: 200 }), first.quoteSlot.slot);
  await assert.rejects(f.state.acquire(f.input.date, f.code, opts), /ALREADY_RESERVED/);
  const code = f.input.prepared.codes[1]; await f.state.acquire(f.input.date, code, opts);
  f.state.extra(f.input.date, code, "minute");
  const reopened = new ProductionDayState(f.options);
  await assert.rejects(reopened.acquire(f.input.date, code, opts), /ALREADY_RESERVED/);
});

test("bundle completing after cutoff never returns a usable grant", async t => {
  const f = await prepared(t); await f.state.acquire(f.input.date, f.code, opts);
  const reopened = new ProductionDayState({ ...f.options, bundle: async () => { f.set(f.b.end + 1); return {}; } });
  await assert.rejects(reopened.acquire(f.input.date, f.code, opts), /WINDOW_EXPIRED/);
  assert.equal(f.db.prepare("SELECT completed FROM leases WHERE code=?").get(f.code).completed, 1);
});

test("553 identified callers across139 fixed batches stay within unchanged accounting budgets", async t => {
  const f = await prepared(t); let batches = 0;
  for (let at = 0; at < f.input.prepared.codes.length; at += 4) {
    batches++;
    for (const [offset, code] of f.input.prepared.codes.slice(at, at + 4).entries()) {
      const acquisitionId = `12345678-1234-4123-8123-${String(at + offset).padStart(12, "0")}`;
      const lease = await f.state.acquire(f.input.date, code, { acquisitionId, deferMinute: true });
      f.set(Math.max(f.b.start, lease.quoteSlot.notBefore + 1));
      const minute = f.state.extra(f.input.date, code, "minute"); f.set(minute.notBefore + 1);
      f.state.complete(f.input.date, code, { metadata: { code, reason: "KIS_HTTP_500", rawPricesStored: false },
        calls: [["quote", lease.quoteSlot], ["minute", minute]].map(([kind, slot]) => ({ slot: slot.slot, kind, started: slot.notBefore, completed: slot.notBefore + 1, status: 500 })) });
    }
  }
  assert.equal(batches, 139);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM leases WHERE completed=1").get().n, 553);
  assert.equal(f.state.read("allocator").count, 1106);
  assert.ok(f.state.status().meteredSql.w < 40000);
  assert.ok(f.state.status().meteredSql.r < 1000000);
  assert.ok(f.db.prepare("PRAGMA page_count").get().page_count * 4096 < 8000000);
});
