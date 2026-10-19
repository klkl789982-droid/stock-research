import test from "node:test";
import assert from "node:assert/strict";
import { cloudSwingFixture, verifyCloudSwingFixture } from "./swing-fixture.mjs";

test("isolated cloud swing first issuance, restart readback and existing evaluation are immutable and blocked, not invented returns", async () => {
  const values = new Map(), keys = [];
  const store = { async writeImmutable(key, value) {
    keys.push(key); const before = values.get(key);
    if (before && JSON.stringify(before) !== JSON.stringify(value)) throw Object.assign(new Error("CONFLICT"), { code: "PRIVATE_STORE_IMMUTABLE_CONFLICT" });
    values.set(key, structuredClone(value));
  }, async read(key) { keys.push(key); return values.has(key) ? { value: structuredClone(values.get(key)) } : null; } };
  const first = await verifyCloudSwingFixture(store, "fixture-only", "create");
  const again = await verifyCloudSwingFixture({ ...store }, "fixture-only", "read");
  assert.equal(first.intentHash, again.intentHash); assert.equal(first.createdAt, again.createdAt);
  assert.equal(values.size, 1); assert.equal(first.selections, 20); assert.equal(first.kisCalls, 0);
  assert.equal(again.existingFiveSessionResolver, "BLOCKED_MISSING_REFERENCE_PRICE");
  assert.ok(keys.every(k => k.startsWith("cloud-isolated-tests/swing/fixture-only/")));
  assert.ok(cloudSwingFixture().records.every(r => r.predictions.expectedReturn === null));
  await assert.rejects(verifyCloudSwingFixture(store, "../production", "create"), /INVALID/u);
  await assert.rejects(verifyCloudSwingFixture(store, "fixture-only", "replace"), /INVALID/u);
});

test("missing or changed remote swing evidence never counts as a successful readback", async () => {
  await assert.rejects(verifyCloudSwingFixture({ async read() { return null; } }, "missing-only", "read"), /READBACK_FAILED/u);
  await assert.rejects(verifyCloudSwingFixture({ async read() { return { value: { changed: true } }; } }, "tamper-only", "read"), /READBACK_FAILED/u);
});
