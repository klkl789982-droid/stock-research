import test from "node:test";
import assert from "node:assert/strict";
import { currentSignal } from "../../scripts/fixtures/executor-1400-signal.mjs";
import { enqueueStoredSiteDelivery, retrySiteDeliveries, privateSiteWriter, signalDeliveryModels, siteDeliveryQueueStatus } from "./site-delivery-agent.mjs";
import { hashSwingContent } from "../../lib/forecast-swing-contract.mjs";
import { canonicalContentHash } from "../../lib/canonical-content-hash.mjs";
import { topDto } from "../../lib/local-live-executor.mjs";
import { projectPrivateLiveTop } from "../../lib/private-live-top-contract.mjs";
function setup() {
  const rows = new Map(), objects = new Map(); let writes = 0, failHead = true;
  const signal = currentSignal(5), key = `live/${signal.signalDate}/${signal.signalDate}/result.json`;
  rows.set("live/latest.json", { artifactKey: key, signalDate: signal.signalDate, contentHash: signal.contentHash }); rows.set(key, signal);
  const local = { read: async key => structuredClone(rows.get(key) ?? null), withLock: async (_, fn) => fn(),
    writeMutable: async (key, value) => rows.set(key, structuredClone(value)), writeImmutable: async (key, value) => { if (rows.has(key)) assert.deepEqual(rows.get(key), value); else rows.set(key, structuredClone(value)); } };
  const remote = { verifyPrivateRepository: async () => {}, read: async key => objects.has(key) ? { value: objects.get(key) } : null,
    writeImmutable: async (key, value) => { if (failHead && key.includes("/heads/")) throw new Error("PRIVATE_STORE_NETWORK_FAILED"); if (objects.has(key)) assert.deepEqual(objects.get(key), value); else { writes++; objects.set(key, structuredClone(value)); } } };
  return { local, remote, rows, signal, key, writes: () => writes, recover: () => { failHead = false; } };
}
test("stored executor signal is projected without price fields; hashes and TOP DTOs remain identical", () => {
  const { signal } = setup();
  for (const [index, value] of signalDeliveryModels(signal).entries()) assert.deepEqual(projectPrivateLiveTop(value, "live", ["A", "B", "C", "D"][index]), topDto(value, "live", ["A", "B", "C", "D"][index]));
  const source = { a: [{ z: 3, x: "unchanged" }], b: true };
  assert.equal(canonicalContentHash(source), hashSwingContent(source));
  const archive = structuredClone(signal); archive.officialSignalTime = "14:30:00";
  assert.throws(() => signalDeliveryModels(archive), /NOT_CURRENT_VALID_LIVE/);
});
test("queue survives failed head upload, bounded retry completes without recollection or replacement", async () => {
  const state = setup(); let ms = Date.parse("2026-10-06T06:00:00.000Z");
  const queued = await enqueueStoredSiteDelivery(state.local, () => new Date(ms).toISOString());
  assert.deepEqual(await enqueueStoredSiteDelivery(state.local, () => new Date(ms + 1000).toISOString()), queued);
  assert.equal((await retrySiteDeliveries(state.local, state.remote, { now: () => ms }))[0].status, "FAILED");
  assert.equal((await retrySiteDeliveries(state.local, state.remote, { now: () => ms })).length, 0);
  state.recover(); ms += 60001;
  assert.equal((await retrySiteDeliveries(state.local, state.remote, { now: () => ms }))[0].status, "PRIVATE_RELAY_VERIFIED");
  assert.equal(state.writes(), 2);
  assert.deepEqual(await siteDeliveryQueueStatus(state.local), { queuedCount: 1, pendingCount: 0, verifiedCount: 1, exhaustedCount: 0 });
  assert.equal((await retrySiteDeliveries(state.local, state.remote, { now: () => ms + 60001 })).length, 0);
  assert.equal(state.rows.get(`live/site-receipts/${queued.deliveryHash}.json`).websiteVerified, false);
  assert.deepEqual(state.rows.get(state.key), state.signal);
});
test("three reserved failed attempts stop retry storms across process restarts", async () => {
  const state = setup(); let ms = Date.parse("2026-10-06T06:00:00.000Z");
  await enqueueStoredSiteDelivery(state.local, () => new Date(ms).toISOString());
  for (let i = 0; i < 3; i++) { assert.equal((await retrySiteDeliveries(state.local, state.remote, { now: () => ms })).length, 1); ms += 60001; }
  state.recover(); assert.deepEqual(await retrySiteDeliveries(state.local, state.remote, { now: () => ms }), []);
  assert.equal((await siteDeliveryQueueStatus(state.local)).exhaustedCount, 1);
});
test("writer remains opt-in, repository scoped and separate from reader", () => {
  assert.equal(privateSiteWriter({}), null);
  for (const env of [{ PRIVATE_LIVE_DELIVERY_SEND_ENABLED: "true" }, { PRIVATE_LIVE_DELIVERY_SEND_ENABLED: "true", PRIVATE_LIVE_DELIVERY_REPOSITORY: "klkl789982-droid/tight-budget-private-data", PRIVATE_LIVE_DELIVERY_WRITE_TOKEN: "same", PRIVATE_LIVE_DELIVERY_READ_TOKEN: "same" }]) assert.throws(() => privateSiteWriter(env));
});
