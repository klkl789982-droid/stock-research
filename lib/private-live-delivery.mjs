import { projectPrivateLiveTop as topDto } from "./private-live-top-contract.mjs";
import { canonicalContentHash as hashSwingContent } from "./canonical-content-hash.mjs";
import { createKisEodPrivateStore } from "./kis-eod-private-store.mjs";
import { readDeliveryFixture, deliveryFixtureEnvironmentAllowed } from "./private-live-delivery-fixture.mjs";

// Scores only. Reuse the private, create-only GitHub adapter; never publish raw
// execution artifacts, prices, credentials or local paths. No automatic upload.
export const LIVE_DELIVERY_PREFIX = "live-site-delivery-v1";
const digest = /^[a-f0-9]{64}$/u;
const fail = () => { throw new Error("PRIVATE_LIVE_DELIVERY_INVALID"); };
const iso = value => typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const keys = (value, expected) => value && !Array.isArray(value) && Object.keys(value).sort().join() === [...expected].sort().join();

export function createLiveDelivery(rawModels, { exportedAt, now = new Date().toISOString() } = {}) {
  if (!Array.isArray(rawModels) || rawModels.length !== 4 || !iso(exportedAt) || !iso(now) || exportedAt > now) fail();
  const models = rawModels.map((value, i) => topDto(value, "live", ["A", "B", "C", "D"][i]));
  const first = models[0];
  for (const model of models) {
    if (model.records.length !== 5 || Date.parse(model.collectionCompletedAt) > Date.parse(exportedAt)
      || ["signalDate", "seedReferenceDate", "contentHash", "collectionStartedAt", "collectionCompletedAt"].some(key => model[key] !== first[key])) fail();
  }
  const body = { schemaVersion: 1, namespace: LIVE_DELIVERY_PREFIX, exportedAt, observationPolicyId: "intraday-1400-v1",
    observationType: "LIVE_OBSERVATION", signalDate: first.signalDate, sourceHash: first.contentHash, models };
  return { ...body, deliveryHash: hashSwingContent(body) };
}

export function validateLiveDelivery(value, now = new Date().toISOString()) {
  if (!keys(value, ["schemaVersion", "namespace", "exportedAt", "observationPolicyId", "observationType", "signalDate", "sourceHash", "models", "deliveryHash"])
    || !digest.test(value.deliveryHash) || value.schemaVersion !== 1 || value.namespace !== LIVE_DELIVERY_PREFIX
    || value.observationPolicyId !== "intraday-1400-v1" || value.observationType !== "LIVE_OBSERVATION"
    || !Array.isArray(value.models) || value.models.length !== 4) fail();
  const models = value.models.map(model => {
    if (!keys(model, ["model", "modelVersion", "signalDate", "seedReferenceDate", "officialSignalTime", "freshnessStatus", "contentHash", "collectionStartedAt", "collectionCompletedAt", "records"])
      || !Array.isArray(model.records) || model.records.some(row => !keys(row, ["ticker", "companyName", "score", "rank"]))) fail();
    return { ...model, mode: "live", schemaVersion: 2, observationPolicyId: value.observationPolicyId, observationType: value.observationType };
  });
  const expected = createLiveDelivery(models, { exportedAt: value.exportedAt, now });
  if (hashSwingContent(expected) !== hashSwingContent(value)) fail();
  return value;
}

const objectKey = value => `${LIVE_DELIVERY_PREFIX}/objects/${value.signalDate}/${value.deliveryHash}.json`;
const headKey = value => `${LIVE_DELIVERY_PREFIX}/heads/${value.signalDate.slice(0, 4)}/${value.signalDate}-${String(Date.parse(value.models[0].collectionCompletedAt))}-${value.deliveryHash}.json`;
const headOf = value => ({ schemaVersion: 1, signalDate: value.signalDate, deliveryHash: value.deliveryHash,
  collectionCompletedAt: value.models[0].collectionCompletedAt });

export async function deliverPrivateLive(store, value, { now = new Date().toISOString() } = {}) {
  validateLiveDelivery(value, now);
  await store.verifyPrivateRepository();
  // Export once to a durable local outbox, then retry these exact bytes. A failed
  // head write leaves an orphan object, never a partial public/latest result.
  await store.writeImmutable(objectKey(value), value);
  const reread = (await store.read(objectKey(value)))?.value;
  validateLiveDelivery(reread, now);
  if (reread.deliveryHash !== value.deliveryHash) fail();
  await store.writeImmutable(headKey(value), headOf(value));
  const head = (await store.read(headKey(value)))?.value;
  if (hashSwingContent(head) !== hashSwingContent(headOf(value))) fail();
  return { status: "PRIVATE_RELAY_VERIFIED", deliveryHash: value.deliveryHash, signalDate: value.signalDate,
    websiteVerified: false, sourcePricesIncluded: false };
}

export async function readLatestPrivateLive(store, { now = new Date().toISOString() } = {}) {
  if (!iso(now)) fail();
  await store.verifyPrivateRepository();
  const years = await store.listKeys(`${LIVE_DELIVERY_PREFIX}/heads`);
  if (years.some(entry => entry.type !== "dir" || !/^\d{4}$/u.test(entry.name) || entry.name > now.slice(0, 4))) fail();
  if (!years.length) return null;
  const year = years.map(entry => entry.name).sort().at(-1);
  const entries = await store.listKeys(`${LIVE_DELIVERY_PREFIX}/heads/${year}`);
  const candidates = entries.map(entry => {
    const match = /^(\d{4}-\d{2}-\d{2})-(\d{13})-([a-f0-9]{64})\.json$/u.exec(entry.name);
    if (entry.type !== "file" || !match || !match[1].startsWith(year) || Number(match[2]) > Date.parse(now)) fail();
    return { entry, date: match[1], time: Number(match[2]), hash: match[3] };
  }).sort((a, b) => b.date.localeCompare(a.date) || b.time - a.time || a.hash.localeCompare(b.hash));
  if (!candidates.length) fail();
  const latest = candidates[0];
  // Equal observation time with conflicting content is ambiguous, not a
  // lexicographic winner. Operator review is required; never silently fall back.
  if (candidates.some(other => other !== latest && other.date === latest.date && other.time === latest.time && other.hash !== latest.hash)) fail();
  const head = (await store.read(`${LIVE_DELIVERY_PREFIX}/heads/${year}/${latest.entry.name}`))?.value;
  if (!head || head.signalDate !== latest.date || head.deliveryHash !== latest.hash || Date.parse(head.collectionCompletedAt) !== latest.time) fail();
  const value = (await store.read(objectKey(head)))?.value;
  validateLiveDelivery(value, now);
  if (value.deliveryHash !== latest.hash || value.signalDate !== latest.date || hashSwingContent(head) !== hashSwingContent(headOf(value))) fail();
  return value;
}

// Server-only consumer. A distinct repository-scoped Contents:read credential
// must be configured; never reuse the writer secret on Vercel. Disabled by default.
export async function privateLiveDeliveryResponse(request, { env = process.env, fetchImpl = fetch, now = new Date().toISOString() } = {}) {
  const respond = (status, body) => Response.json(body, { status, headers: { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
  if (env.PRIVATE_LIVE_DELIVERY_READ_ENABLED !== "true") return respond(404, { error: "NOT_FOUND" });
  if (request.method !== "GET" || new URL(request.url).search) return respond(400, { error: "INVALID_QUERY" });
  try {
    if (env.PRIVATE_LIVE_DELIVERY_FIXTURE_ID && !deliveryFixtureEnvironmentAllowed(request, env)) return respond(404, { error: "NOT_FOUND" });
    const store = createKisEodPrivateStore({ repository: env.PRIVATE_LIVE_DELIVERY_REPOSITORY, token: env.PRIVATE_LIVE_DELIVERY_READ_TOKEN, fetchImpl });
    if (env.PRIVATE_LIVE_DELIVERY_FIXTURE_ID) return respond(200, { ...await readDeliveryFixture(store, env, request), servedAt: now });
    const value = await readLatestPrivateLive(store, { now });
    const todayKst = new Date(Date.parse(now) + 9 * 3600000).toISOString().slice(0, 10);
    return respond(200, value ? { status: "AVAILABLE", source: "privateLiveRelay", freshnessStatus: value.signalDate < todayKst ? "HISTORICAL" : "NOT_EVALUATED", servedAt: now, delivery: value }
      : { status: "UNAVAILABLE", reason: "NO_PRIVATE_DELIVERY", delivery: null });
  } catch { return respond(503, { error: "PRIVATE_LIVE_DELIVERY_UNAVAILABLE" }); }
}
