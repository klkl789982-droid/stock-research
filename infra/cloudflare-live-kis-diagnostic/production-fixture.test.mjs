import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { verifyNativeProductionFixture } from "./production-fixture.mjs";
import { PRODUCTION_BUDGET } from "./production-core.mjs";

test("unchanged production state machine completes synthetic553 native-SQL lifecycle and reopens only isolated private records", async t => {
  const db = new DatabaseSync(":memory:"), values = new Map(); t.after(() => db.close());
  const sql = { get databaseSize() { return db.prepare("PRAGMA page_count").get().page_count * 4096; }, exec(query, ...args) {
    const rows = db.prepare(query).all(...args); return { toArray: () => rows, rowsRead: rows.length + 1, rowsWritten: /^(INSERT|UPDATE)/u.test(query) ? 2 : 0 };
  } };
  const remote = { async verifyPrivateRepository() {}, async writeImmutable(k, v) {
    assert.ok(k.startsWith("cloud-isolated-tests/pf/fixture-only/"));
    if (values.has(k)) assert.deepEqual(values.get(k), v); values.set(k, structuredClone(v));
  }, async read(k) { assert.ok(k.startsWith("cloud-isolated-tests/pf/fixture-only/")); return values.has(k) ? { value: structuredClone(values.get(k)) } : null; },
  async listKeys(prefix) {
    const entries = new Map();
    for (const k of values.keys()) if (k.startsWith(`${prefix}/`)) {
      const rest = k.slice(prefix.length + 1), [name] = rest.split("/"); entries.set(name, { name, type: rest.includes("/") ? "dir" : "file" });
    }
    return [...entries.values()];
  } };
  const first = await verifyNativeProductionFixture({ sql, remote, run: "fixture-only", phase: "create" });
  const read = await verifyNativeProductionFixture({ sql, remote, run: "fixture-only", phase: "read" });
  assert.equal(first.deliveryHash, read.deliveryHash); assert.equal(first.firstCreatedAt, read.firstCreatedAt);
  assert.equal(first.kisCalls, 0); assert.equal(first.universe, 553); assert.equal(first.eligible, 508); assert.equal(first.topRows, 20);
  assert.equal(first.existingResolver, "BLOCKED_MISSING_REFERENCE_PRICE"); assert.equal(values.size, 4);
  assert.ok(values.size && [...values.values()].every(v => v.syntheticOnly && v.publicationEligible === false));
  assert.ok(read.sqliteBytes < PRODUCTION_BUDGET.retainedBytesPerDay); assert.ok(read.nativeSqlMeter.w < 40000);
  await assert.rejects(verifyNativeProductionFixture({ sql, remote, run: "../normal", phase: "create" }), /INVALID/u);
});
