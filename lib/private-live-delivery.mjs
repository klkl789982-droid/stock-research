import { projectPrivateLiveTop as topDto } from "./private-live-top-contract.mjs";
import { canonicalContentHash as hashSwingContent } from "./canonical-content-hash.mjs";
import { createKisEodPrivateStore } from "./kis-eod-private-store.mjs";
import { readDeliveryFixture, deliveryFixtureEnvironmentAllowed } from "./private-live-delivery-fixture.mjs";
import { validLivePublication, validLiveSuccessor } from "./live-publication-coverage.mjs";

// Scores only. Reuse the private, create-only GitHub adapter; never publish raw
// execution artifacts, prices, credentials or local paths. No automatic upload.
export const LIVE_DELIVERY_PREFIX = "live-site-delivery-v1";
const digest = /^[a-f0-9]{64}$/u;
const fail = () => { throw new Error("PRIVATE_LIVE_DELIVERY_INVALID"); };
const iso = value => typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const keys = (value, expected) => value && !Array.isArray(value) && Object.keys(value).sort().join() === [...expected].sort().join();

export function createLiveDelivery(rawModels, { exportedAt, now = new Date().toISOString(), publication } = {}) {
  if (!Array.isArray(rawModels) || rawModels.length !== 4 || !iso(exportedAt) || !iso(now) || exportedAt > now) fail();
  const models = rawModels.map((value, i) => topDto(value, "live", ["A", "B", "C", "D"][i]));
  const first = models[0];
  for (const model of models) {
    if (model.records.length !== 5 || Date.parse(model.collectionCompletedAt) > Date.parse(exportedAt)
      || ["signalDate", "seedReferenceDate", "contentHash", "collectionStartedAt", "collectionCompletedAt"].some(key => model[key] !== first[key])) fail();
  }
  if (publication !== undefined) {
    if (!validLivePublication(publication, exportedAt)) fail();
    const absent = new Set(publication.missing.map(row => row.ticker));
    const ranked = new Set();
    for (const model of models) {
      for (const [index, row] of model.records.entries()) {
        const previous = model.records[index - 1];
        if (absent.has(row.ticker) || previous && (row.score > previous.score || row.score === previous.score && row.ticker < previous.ticker)) fail();
        ranked.add(row.ticker);
      }
    }
    if (ranked.size > publication.validCount) fail();
  }
  const body = { schemaVersion: publication === undefined ? 1 : 2, namespace: LIVE_DELIVERY_PREFIX, exportedAt,
    ...(publication === undefined ? {} : { publication }), observationPolicyId: "intraday-1400-v1",
    observationType: "LIVE_OBSERVATION", signalDate: first.signalDate, sourceHash: first.contentHash, models };
  return { ...body, deliveryHash: hashSwingContent(body) };
}

export function validateLiveDelivery(value, now = new Date().toISOString()) {
  const fields = ["schemaVersion", "namespace", "exportedAt", "observationPolicyId", "observationType", "signalDate", "sourceHash", "models", "deliveryHash"];
  if (value?.schemaVersion === 2) fields.push("publication");
  if (!keys(value, fields)
    || !digest.test(value.deliveryHash) || ![1, 2].includes(value.schemaVersion) || value.namespace !== LIVE_DELIVERY_PREFIX
    || value.observationPolicyId !== "intraday-1400-v1" || value.observationType !== "LIVE_OBSERVATION"
    || !Array.isArray(value.models) || value.models.length !== 4) fail();
  const models = value.models.map(model => {
    if (!keys(model, ["model", "modelVersion", "signalDate", "seedReferenceDate", "officialSignalTime", "freshnessStatus", "contentHash", "collectionStartedAt", "collectionCompletedAt", "records"])
      || !Array.isArray(model.records) || model.records.some(row => !keys(row, ["ticker", "companyName", "score", "rank"]))) fail();
    return { ...model, mode: "live", schemaVersion: 2, observationPolicyId: value.observationPolicyId, observationType: value.observationType };
  });
  const expected = createLiveDelivery(models, { exportedAt: value.exportedAt, now, publication: value.publication });
  if (hashSwingContent(expected) !== hashSwingContent(value)) fail();
  return value;
}

const objectKey = value => `${LIVE_DELIVERY_PREFIX}/objects/${value.signalDate}/${value.deliveryHash}.json`;
const yearFolder = year => `${LIVE_DELIVERY_PREFIX}/heads/${year}`;
const revisionKey = (date, revision) => `${yearFolder(date.slice(0, 4))}/${date}/r${revision}.json`;
const headKey = value => value.schemaVersion === 2 ? revisionKey(value.signalDate, value.publication.revision)
  : `${yearFolder(value.signalDate.slice(0, 4))}/${value.signalDate}-${Date.parse(value.models[0].collectionCompletedAt)}-${value.deliveryHash}.json`;
function headOf(value, publishedAt) {
  const body = { schemaVersion: value.schemaVersion, signalDate: value.signalDate, deliveryHash: value.deliveryHash,
    ...(value.schemaVersion === 2 ? { revision: value.publication.revision, publishedAt } : {}),
    collectionCompletedAt: value.models[0].collectionCompletedAt };
  return value.schemaVersion === 2 ? { ...body, headHash: hashSwingContent(body) } : body;
}
function checkHead(head, value, now) {
  if (!head || value.schemaVersion === 2 && (!iso(head.publishedAt) || head.publishedAt < value.exportedAt || head.publishedAt > now)
    || hashSwingContent(head) !== hashSwingContent(headOf(value, head.publishedAt))) fail();
}

async function readHeadObject(store, key, date, now) {
  const head = (await store.read(key))?.value;
  if (!head || head.signalDate !== date || !digest.test(head.deliveryHash)) fail();
  const value = (await store.read(objectKey(head)))?.value;
  validateLiveDelivery(value, now);
  if (headKey(value) !== key) fail();
  checkHead(head, value, now);
  return { value, publishedAt: head.publishedAt ?? null };
}

export async function deliverPrivateLive(store, value, { now: fixedNow, clock = () => fixedNow ?? new Date().toISOString() } = {}) {
  const now = clock();
  validateLiveDelivery(value, now);
  await store.verifyPrivateRepository();
  let previousPublishedAt = null;
  if (value.schemaVersion === 1) {
    if (await store.read(revisionKey(value.signalDate, 1))) fail();
  } else {
    const { revision } = value.publication;
    if (revision > 1) {
      const previous = await readHeadObject(store, revisionKey(value.signalDate, revision - 1), value.signalDate, now);
      if (!validLiveSuccessor(previous.value, value)) fail();
      previousPublishedAt = previous.publishedAt;
    } else {
      // A filled, legacy day cannot be reopened as a partial post-cutover result.
      const entries = await store.listKeys(yearFolder(value.signalDate.slice(0, 4)));
      if (entries.some(entry => entry.name.startsWith(value.signalDate + "-"))) fail();
    }
  }
  // Export once to a durable local outbox, then retry these exact bytes. A failed
  // head write leaves an orphan object, never a partial public/latest result.
  await store.writeImmutable(objectKey(value), value);
  const reread = (await store.read(objectKey(value)))?.value;
  validateLiveDelivery(reread, now);
  if (reread.deliveryHash !== value.deliveryHash) fail();
  const key = headKey(value);
  let head = (await store.read(key))?.value;
  if (!head) {
    const publishedAt = clock();
    if (!iso(publishedAt) || publishedAt < now || previousPublishedAt && publishedAt < previousPublishedAt) fail();
    try { await store.writeImmutable(key, headOf(value, publishedAt)); }
    catch (error) {
      // A concurrent identical relay may win with its own wall-clock stamp.
      // Reuse only a verified head bound to precisely this immutable artifact.
      const winner = (await store.read(key))?.value;
      if (value.schemaVersion !== 2 || winner?.deliveryHash !== value.deliveryHash) throw error;
    }
    head = (await store.read(key))?.value;
  }
  if (head && head.deliveryHash !== value.deliveryHash) throw new Error("PRIVATE_STORE_IMMUTABLE_CONFLICT");
  checkHead(head, value, clock());
  if (previousPublishedAt && head.publishedAt < previousPublishedAt) fail();
  return { status: "PRIVATE_RELAY_VERIFIED", deliveryHash: value.deliveryHash, signalDate: value.signalDate,
    ...(value.schemaVersion === 2 ? { publishedAt: head.publishedAt } : {}),
    websiteVerified: false, sourcePricesIncluded: false };
}

export async function readLatestPublication(store, { now = new Date().toISOString(), signalDate = null } = {}) {
  if (!iso(now)) fail();
  if (signalDate !== null && !/^\d{4}-\d{2}-\d{2}$/u.test(signalDate)) fail();
  await store.verifyPrivateRepository();
  const years = await store.listKeys(`${LIVE_DELIVERY_PREFIX}/heads`);
  if (years.some(entry => entry.type !== "dir" || !/^\d{4}$/u.test(entry.name) || entry.name > now.slice(0, 4))) fail();
  if (!years.length) return null;
  const year = signalDate?.slice(0, 4) ?? years.map(entry => entry.name).sort().at(-1);
  if (!years.some(entry => entry.name === year)) return null;
  const entries = await store.listKeys(`${LIVE_DELIVERY_PREFIX}/heads/${year}`);
  const candidates = entries.map(entry => {
    if (entry.type === "dir" && /^\d{4}-\d{2}-\d{2}$/u.test(entry.name) && entry.name.startsWith(year + "-")) {
      return { entry, date: entry.name, time: 0, hash: "", revisions: true };
    }
    const match = /^(\d{4}-\d{2}-\d{2})-(\d{13})-([a-f0-9]{64})\.json$/u.exec(entry.name);
    if (entry.type !== "file" || !match || !match[1].startsWith(year) || Number(match[2]) > Date.parse(now)) fail();
    return { entry, date: match[1], time: Number(match[2]), hash: match[3] };
  }).filter(row => !signalDate || row.date === signalDate).sort((a, b) => b.date.localeCompare(a.date) || b.time - a.time || a.hash.localeCompare(b.hash));
  if (!candidates.length) { if (signalDate) return null; fail(); }
  const latest = candidates[0];
  const revised = candidates.find(row => row.date === latest.date && row.revisions);
  if (revised) {
    if (candidates.some(row => row.date === latest.date && !row.revisions)) fail();
    const folder = `${yearFolder(year)}/${latest.date}`, heads = await store.listKeys(folder);
    if (!heads.length || heads.length > 5) fail();
    heads.sort((a, b) => a.name.localeCompare(b.name));
    let previous = null, firstPublishedAt = null;
    for (const [index, head] of heads.entries()) {
      if (head.type !== "file" || head.name !== `r${index + 1}.json`) fail();
      const current = await readHeadObject(store, revisionKey(latest.date, index + 1), latest.date, now);
      if (previous && (!validLiveSuccessor(previous.value, current.value) || current.publishedAt < previous.publishedAt)) fail();
      firstPublishedAt ??= current.publishedAt;
      previous = current;
    }
    return { delivery: previous.value, publicationTimes: { firstPublishedAt, publishedAt: previous.publishedAt } };
  }
  // Equal observation time with conflicting content is ambiguous, not a
  // lexicographic winner. Operator review is required; never silently fall back.
  if (candidates.some(other => other !== latest && other.date === latest.date && other.time === latest.time && other.hash !== latest.hash)) fail();
  const result = await readHeadObject(store, `${yearFolder(year)}/${latest.entry.name}`, latest.date, now);
  return { delivery: result.value, publicationTimes: null };
}

export async function readLatestPrivateLive(store, options) {
  return (await readLatestPublication(store, options))?.delivery ?? null;
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
    const latest = await readLatestPublication(store, { now });
    const todayKst = new Date(Date.parse(now) + 9 * 3600000).toISOString().slice(0, 10);
    return respond(200, latest ? { status: "AVAILABLE", source: "privateLiveRelay", freshnessStatus: latest.delivery.signalDate < todayKst ? "HISTORICAL" : "NOT_EVALUATED", servedAt: now, ...latest }
      : { status: "UNAVAILABLE", reason: "NO_PRIVATE_DELIVERY", delivery: null });
  } catch { return respond(503, { error: "PRIVATE_LIVE_DELIVERY_UNAVAILABLE" }); }
}
