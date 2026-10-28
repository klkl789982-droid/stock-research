import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { verifyNativeSlotPolicy } from "./slot-policy-fixture.mjs";

test("small native-target fixture is first checked locally without credentials or outbound fetch", async t => {
  const db = new DatabaseSync(":memory:"); t.after(() => db.close());
  t.mock.method(globalThis, "fetch", () => { throw Error("OUTBOUND_FETCH_FORBIDDEN_IN_FIXTURE"); });
  const sql = { get databaseSize() { return db.prepare("PRAGMA page_count").get().page_count * 4096; }, exec(q, ...args) {
    const rows = db.prepare(q).all(...args); return { toArray: () => rows, rowsRead: rows.length + 1, rowsWritten: /^(INSERT|UPDATE)/u.test(q) ? 2 : 0 };
  } };
  const owner = { ctx: { storage: { sql, transactionSync(fn) { db.exec("BEGIN"); try { const r = fn(); db.exec("COMMIT"); return r; } catch (e) { db.exec("ROLLBACK"); throw e; } } } } };
  const r = await verifyNativeSlotPolicy(owner);
  assert.equal(r.completed, 12); assert.equal(r.chargedReservations, 24); assert.equal(r.peak, 8);
  assert.equal(r.outbox, false); assert.equal(r.kisCalls, 0); assert.ok(r.retiredUnused >= 1);
  assert.ok(r.minStartSpacingMs >= 200); assert.equal(r.restartReadback, true);
  await assert.rejects(verifyNativeSlotPolicy(owner), /ALREADY_ATTEMPTED/u);
});
