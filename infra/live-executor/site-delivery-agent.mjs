import { hashIntradayModelTop, isCurrentIntradayModelTopSignal, validateIntradayModelTopSignal } from "../../lib/intraday-model-top-official-signal.mjs";
import { createKisEodPrivateStore } from "../../lib/kis-eod-private-store.mjs";
import { queueSiteDelivery, flushSiteDelivery } from "./site-delivery.mjs";

const queueKey = "live/site-delivery-queue.json";
const validKey = key => /^live\/site-outbox\/\d{4}-\d{2}-\d{2}\/[a-f0-9]{64}\.json$/u.test(key ?? "");
const reason = error => /^[A-Z][A-Z0-9_]{2,95}$/u.test(error?.message ?? "") ? error.message : "SITE_RELAY_FAILED";
export function signalDeliveryModels(signal) {
  const { contentHash, ...body } = signal ?? {};
  if (!isCurrentIntradayModelTopSignal(signal) || validateIntradayModelTopSignal(signal).length || hashIntradayModelTop(body) !== contentHash) throw new Error("SITE_RELAY_SOURCE_NOT_CURRENT_VALID_LIVE");
  return ["A", "B", "C", "D"].map(model => {
    const version = `${model}-v1`;
    return { mode: "live", schemaVersion: signal.schemaVersion, observationPolicyId: signal.observationPolicyId, observationType: signal.observationType,
      officialSignalTime: signal.officialSignalTime, modelVersion: version, signalDate: signal.signalDate, seedReferenceDate: signal.seedReferenceDate,
      contentHash, collectionStartedAt: signal.collectionStartedAt, collectionCompletedAt: signal.collectionCompletedAt,
      records: signal.records.filter(row => Number.isFinite(row.ranks?.[version])).sort((a, b) => a.ranks[version] - b.ranks[version]).slice(0, 5)
        .map(row => ({ ticker: row.ticker, companyName: row.companyName, score: row.scores[version], rank: row.ranks[version] })) };
  });
}
async function inventory(store) {
  const value = await store.read(queueKey) ?? { keys: [] };
  if (!Array.isArray(value.keys) || value.keys.length > 1000 || new Set(value.keys).size !== value.keys.length || value.keys.some(key => !validKey(key))) throw new Error("SITE_RELAY_QUEUE_INVALID");
  return value.keys;
}
export async function enqueueStoredSiteDelivery(store, clock = () => new Date().toISOString()) {
  const pointer = await store.read("live/latest.json");
  if (!pointer) return { status: "NO_OBSERVATION" };
  if (!/^live\/\d{4}-\d{2}-\d{2}\/[A-Za-z0-9-]+\/result[.]json$/u.test(pointer.artifactKey ?? "")) throw new Error("SITE_RELAY_POINTER_INVALID");
  const signal = await store.read(pointer.artifactKey);
  if (signal?.signalDate !== pointer.signalDate || signal?.contentHash !== pointer.contentHash) throw new Error("SITE_RELAY_POINTER_MISMATCH");
  const queued = await queueSiteDelivery(store, signalDeliveryModels(signal), clock);
  await store.withLock("site-queue", async () => {
    const keys = await inventory(store);
    if (!keys.includes(queued.key)) await store.writeMutable(queueKey, { keys: [...keys, queued.key].sort() });
  });
  return { status: "QUEUED", ...queued };
}
export async function retrySiteDeliveries(store, remoteStore, { now = Date.now, limit = 3 } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 3) throw new Error("SITE_RELAY_BATCH_LIMIT_INVALID");
  return store.withLock("site-relay-agent", async () => {
    const results = [];
    for (const key of await inventory(store)) {
      if (results.length >= limit) break;
      const hash = key.split("/").at(-1).slice(0, -5), stateKey = `live/site-delivery-attempts/${hash}.json`;
      const state = await store.read(stateKey) ?? { attempts: 0, nextAttemptAt: 0 };
      if (state.status === "PRIVATE_RELAY_VERIFIED" || state.attempts >= 3 || state.nextAttemptAt > now()) continue;
      const pending = { attempts: state.attempts + 1, nextAttemptAt: now() + 60000, status: "IN_PROGRESS", attemptedAt: new Date(now()).toISOString() };
      // Reserve the attempt before any network work; process death cannot hot-loop.
      await store.writeMutable(stateKey, pending);
      try {
        const receipt = await flushSiteDelivery(store, remoteStore, key, () => new Date(now()).toISOString());
        await store.writeMutable(stateKey, { ...pending, status: receipt.status, completedAt: new Date(now()).toISOString(), websiteVerified: false });
        results.push({ key, status: receipt.status });
      } catch (error) {
        const failure = { ...pending, status: "FAILED", reason: reason(error) };
        await store.writeMutable(stateKey, failure); results.push({ key, status: failure.status, reason: failure.reason });
      }
    }
    return results;
  });
}
export function privateSiteWriter(env = process.env) {
  if (env.PRIVATE_LIVE_DELIVERY_SEND_ENABLED !== "true") return null;
  if (env.PRIVATE_LIVE_DELIVERY_REPOSITORY !== "klkl789982-droid/tight-budget-private-data") throw new Error("SITE_RELAY_REPOSITORY_INVALID");
  if (!env.PRIVATE_LIVE_DELIVERY_WRITE_TOKEN || env.PRIVATE_LIVE_DELIVERY_WRITE_TOKEN === env.PRIVATE_LIVE_DELIVERY_READ_TOKEN) throw new Error("SITE_RELAY_WRITER_NOT_CONFIGURED");
  return createKisEodPrivateStore({ repository: env.PRIVATE_LIVE_DELIVERY_REPOSITORY, token: env.PRIVATE_LIVE_DELIVERY_WRITE_TOKEN });
}
