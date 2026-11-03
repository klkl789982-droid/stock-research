import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createKisEodPrivateStore } from "../lib/kis-eod-private-store.mjs";
import { createLiveDelivery, deliverPrivateLive, readLatestPrivateLive, validateLiveDelivery, privateLiveDeliveryResponse } from "../lib/private-live-delivery.mjs";
import { isPublicResource } from "../lib/admin-route-policy.mjs";
import { isAutomationRequest } from "../lib/admin-auth.mjs";
import { queueSiteDelivery, flushSiteDelivery } from "../infra/live-executor/site-delivery.mjs";
import { createLocalExecutionStore } from "../infra/live-executor/store.mjs";

const now = "2026-10-17T02:00:00.000Z";
const fixture = (date = "2026-10-16", end = "05:02:00.000Z") => ["A", "B", "C", "D"].map(model => ({
  schemaVersion: 2, observationPolicyId: "intraday-1400-v1", officialSignalTime: "14:00:00", mode: "live", observationType: "LIVE_OBSERVATION",
  modelVersion: `${model}-v1`, signalDate: date, seedReferenceDate: "2026-10-14", contentHash: "a".repeat(64),
  collectionStartedAt: `${date}T05:00:01.000Z`, collectionCompletedAt: `${date}T${end}`,
  records: Array.from({ length: 5 }, (_, i) => ({ ticker: String(i + 1).padStart(6, "0"), companyName: `TEST ONLY ${i}`, score: 90 - i, rank: i + 1 })) }));
const exportFixture = (date, end) => createLiveDelivery(fixture(date, end), { exportedAt: "2026-10-16T05:06:00.000Z", now });
const revision = (missing, previous = null, overrides = {}) => {
  const raw = fixture(), n = (previous?.publication.revision ?? 0) + 1;
  const exportedAt = `2026-10-16T05:1${n}:00.000Z`;
  for (const model of raw) model.contentHash = String(n).repeat(64);
  const publication = { status: missing.length ? "PARTIAL" : "COMPLETE", revision: n, previousDeliveryHash: previous?.deliveryHash ?? null,
    firstIssuedAt: previous?.publication.firstIssuedAt ?? exportedAt, targetCount: 508, validCount: 508 - missing.length,
    missing: missing.map(ticker => ({ ticker, reason: "LIVE_CLOUD_OBSERVATION_MISSING" })), universeHash: "b".repeat(64), ...overrides };
  return createLiveDelivery(raw, { exportedAt, now, publication });
};

// Runs the existing real adapter against a deterministic fake GitHub HTTP API.
// No network, actual credentials or source prices are used.
function backend() {
  const files = new Map(), methods = [];
  const options = { private: true, deny: false, failHead: false, readOnly: false };
  const fetchImpl = async (url, init) => {
    methods.push(init.method);
    assert.equal(new URL(url).origin, "https://api.github.com"); assert.equal(init.redirect, "error");
    assert.equal(init.headers.Authorization, "Bearer FIXTURE_ONLY");
    if (options.deny) return new Response(null, { status: 401 });
    const key = decodeURIComponent(new URL(url).pathname.split("/contents/")[1] ?? "");
    if (!key) return Response.json({ private: options.private, full_name: "fixture/private", fork: false, has_pages: false });
    if (init.method === "PUT") {
      if (options.readOnly) return new Response(null, { status: 403 });
      if (options.failHead && key.includes("/heads/")) return new Response(null, { status: 503 });
      const body = JSON.parse(init.body); assert.equal(body.sha, undefined);
      if (files.has(key)) return new Response(null, { status: 409 });
      files.set(key, Buffer.from(body.content, "base64").toString());
      return Response.json({}, { status: 201 });
    }
    if (files.has(key)) {
      const bytes = files.get(key);
      return Response.json({ type: "file", encoding: "base64", size: Buffer.byteLength(bytes), content: Buffer.from(bytes).toString("base64") });
    }
    const names = new Map();
    for (const name of files.keys()) if (name.startsWith(`${key}/`)) {
      const rest = name.slice(key.length + 1), first = rest.split("/")[0];
      names.set(first, { name: first, type: rest.includes("/") ? "dir" : "file" });
    }
    return names.size ? Response.json([...names.values()]) : new Response(null, { status: 404 });
  };
  const store = createKisEodPrivateStore({ repository: "fixture/private", token: "FIXTURE_ONLY", fetchImpl, wait: async () => {} });
  return { files, methods, options, store, fetchImpl };
}

test("score-only projection, real adapter create/read/hash, identical retry and reader GET-only", async () => {
  const b = backend(), raw = fixture(); raw[0].records[0].closePrice = 123;
  const value = createLiveDelivery(raw, { exportedAt: "2026-10-16T05:06:00.000Z", now });
  assert.equal(JSON.stringify(value).includes("closePrice"), false);
  assert.ok(Buffer.byteLength(JSON.stringify(value)) < 10000);
  assert.equal((await deliverPrivateLive(b.store, value, { now })).websiteVerified, false);
  await deliverPrivateLive(b.store, value, { now });
  assert.equal(b.methods.filter(method => method === "PUT").length, 2);
  b.options.readOnly = true; b.methods.length = 0;
  assert.deepEqual(await readLatestPrivateLive(b.store, { now }), value);
  assert.ok(b.methods.every(method => method === "GET"));
});

test("interrupted publish preserves prior latest; exact retry completes orphan; old upload cannot rewind", async () => {
  const b = backend(), older = exportFixture("2026-10-15"), newer = exportFixture();
  await deliverPrivateLive(b.store, older, { now }); b.options.failHead = true;
  await assert.rejects(deliverPrivateLive(b.store, newer, { now }), /PRIVATE_STORE_RETRY_EXHAUSTED/);
  assert.equal((await readLatestPrivateLive(b.store, { now })).signalDate, "2026-10-15");
  b.options.failHead = false; await deliverPrivateLive(b.store, newer, { now });
  await deliverPrivateLive(b.store, older, { now });
  assert.equal((await readLatestPrivateLive(b.store, { now })).signalDate, "2026-10-16");
});

test("later observed version is immutable and selected, equal-time conflicting version blocks", async () => {
  const b = backend(); await deliverPrivateLive(b.store, exportFixture(), { now });
  const later = exportFixture(undefined, "05:03:00.000Z"); await deliverPrivateLive(b.store, later, { now });
  assert.equal((await readLatestPrivateLive(b.store, { now })).deliveryHash, later.deliveryHash);
  const changed = fixture(undefined, "05:03:00.000Z"); changed[0].records[0].score = 91;
  const conflict = createLiveDelivery(changed, { exportedAt: later.exportedAt, now });
  await deliverPrivateLive(b.store, conflict, { now });
  await assert.rejects(readLatestPrivateLive(b.store, { now }), /DELIVERY_INVALID/);
});

test("tampered, incomplete and future delivery fail closed without falling back", async () => {
  const b = backend(), value = exportFixture(); await deliverPrivateLive(b.store, value, { now });
  const key = [...b.files.keys()].find(key => key.includes("/objects/"));
  const changed = JSON.parse(b.files.get(key)); changed.models[0].records[0].score++;
  b.files.set(key, JSON.stringify(changed));
  await assert.rejects(readLatestPrivateLive(b.store, { now }), /DELIVERY_INVALID/);
  await assert.rejects(deliverPrivateLive(b.store, value, { now }), /IMMUTABLE_CONFLICT/);
  assert.throws(() => validateLiveDelivery(value, "2026-10-16T05:00:00.000Z"));
  const bad = structuredClone(value); bad.models[0].records[0].price = 1;
  assert.throws(() => validateLiveDelivery(bad, now));
});

test("partial revisions verify coverage, are create-only, and older retries cannot rewind the authenticated result", async () => {
  const b = backend(), older = exportFixture("2026-10-15");
  const first = revision(["000100","000101","000102","009450"]), second = revision(["009450"], first), complete = revision([], second);
  await deliverPrivateLive(b.store, older, { now });
  await deliverPrivateLive(b.store, first, { now });
  const env = {PRIVATE_LIVE_DELIVERY_READ_ENABLED:"true",PRIVATE_LIVE_DELIVERY_REPOSITORY:"fixture/private",PRIVATE_LIVE_DELIVERY_READ_TOKEN:"FIXTURE_ONLY"};
  const read = async () => (await privateLiveDeliveryResponse(new Request("https://fixture.invalid/api/private-live-delivery"), {env,now,fetchImpl:b.fetchImpl})).json();
  assert.deepEqual((await read()).delivery, first);
  await assert.rejects(deliverPrivateLive(b.store, complete, {now}), /DELIVERY_INVALID/);
  for (const wrong of [revision(["000200"],first),revision(["000100"],first,{universeHash:"e".repeat(64)}),
    revision(["000100"],first,{previousDeliveryHash:"f".repeat(64)}),revision(["000100"],first,{targetCount:510,validCount:509})]) {
    await assert.rejects(deliverPrivateLive(b.store, wrong, {now}), /DELIVERY_INVALID/);
  }
  b.options.failHead=true;
  await assert.rejects(deliverPrivateLive(b.store,second,{now}));
  assert.equal((await read()).delivery.deliveryHash,first.deliveryHash);
  b.options.failHead=false;
  await deliverPrivateLive(b.store,second,{now});
  await assert.rejects(deliverPrivateLive(b.store,revision(["000100"],first),{now}), /IMMUTABLE_CONFLICT/);
  await deliverPrivateLive(b.store,complete,{now});
  await deliverPrivateLive(b.store,first,{now});
  await assert.rejects(deliverPrivateLive(b.store,exportFixture(),{now}),/DELIVERY_INVALID/);
  assert.deepEqual((await read()).delivery,complete);
  const ancestor=[...b.files.keys()].find(key=>key.includes("/heads/")&&key.endsWith("/r2.json"));
  b.files.delete(ancestor);
  assert.deepEqual(await read(),{error:"PRIVATE_LIVE_DELIVERY_UNAVAILABLE"});
});

test("strict 0/1–4/5+ thresholds, exact missing identities and closed reason fields", async () => {
  assert.equal(revision([]).publication.status,"COMPLETE");
  assert.equal(revision(["00945A"]).publication.validCount,507);
  for (const bad of [
    ()=>revision(["000100","000101","000102","000103","000104"]),
    ()=>revision(["000100"],null,{status:"COMPLETE"}),()=>revision(["000100"],null,{validCount:506}),
    ()=>revision(["000101","000100"]),()=>revision(["000100","000100"]),()=>revision(["000001"]),
    ()=>revision(["000100"],null,{missing:[{ticker:"000100",reason:"free text"}]}),
    ()=>revision(["000100"],null,{missing:[{ticker:"000100",reason:"LIVE_CLOUD_OBSERVATION_MISSING",price:1}]}),
    ()=>revision([],null,{revision:2}),()=>revision([],null,{previousDeliveryHash:"c".repeat(64)}),
  ]) assert.throws(bad,/DELIVERY_INVALID/);
  const raw=fixture(),published=revision([]),options={exportedAt:published.exportedAt,now,publication:published.publication};
  raw[0].records[1].score=raw[0].records[0].score+1;
  assert.throws(()=>createLiveDelivery(raw,options),/DELIVERY_INVALID/);
  const disjoint=fixture();
  disjoint[0].records[0].ticker="00945A";
  assert.throws(()=>createLiveDelivery(disjoint,{...options,publication:{...options.publication,targetCount:5,validCount:5}}),/DELIVERY_INVALID/);
  const b=backend();
  await deliverPrivateLive(b.store,exportFixture(),{now});
  await assert.rejects(deliverPrivateLive(b.store,revision(["009450"]),{now}),/DELIVERY_INVALID/);
});

test("successful head creation timestamps survive delayed and competing retries independently of observation/issue times",async()=>{
  const b=backend(), first=revision(["009450"]), second=revision([],first);
  const env={PRIVATE_LIVE_DELIVERY_READ_ENABLED:"true",PRIVATE_LIVE_DELIVERY_REPOSITORY:"fixture/private",PRIVATE_LIVE_DELIVERY_READ_TOKEN:"FIXTURE_ONLY"};
  const read=async()=>(await privateLiveDeliveryResponse(new Request("https://fixture.invalid/api/private-live-delivery"),{env,now,fetchImpl:b.fetchImpl})).json();
  const earlier="2026-10-16T06:20:00.000Z",success="2026-10-16T06:35:00.000Z",updated="2026-10-16T07:00:00.000Z";
  b.options.failHead=true;
  await assert.rejects(deliverPrivateLive(b.store,first,{now:earlier}));
  assert.equal((await read()).delivery,null);
  b.options.failHead=false;
  // Another relay wins the race between this relay's empty-key check and its PUT.
  let competed=false;
  const delayed={...b.store,async writeImmutable(key,data){
    if(!competed&&key.endsWith("/r1.json")){
      competed=true;await deliverPrivateLive(b.store,first,{now:success});
    }
    return b.store.writeImmutable(key,data);
  }};
  const firstReceipt=await deliverPrivateLive(delayed,first,{now:"2026-10-16T06:36:00.000Z"});
  assert.equal(firstReceipt.publishedAt,success);
  assert.deepEqual((await read()).publicationTimes,{firstPublishedAt:success,publishedAt:success});
  assert.equal((await deliverPrivateLive(b.store,second,{now:updated})).publishedAt,updated);
  assert.equal((await deliverPrivateLive(b.store,first,{now})).publishedAt,success);
  const response=await read();
  assert.deepEqual(response.publicationTimes,{firstPublishedAt:success,publishedAt:updated});
  assert.equal(response.delivery.exportedAt,second.exportedAt);
  assert.ok(response.delivery.models[0].collectionCompletedAt<first.exportedAt && first.exportedAt<success && second.exportedAt<updated);
  const key=[...b.files.keys()].find(k=>k.endsWith("/r2.json")),head=JSON.parse(b.files.get(key));
  b.files.set(key,JSON.stringify({...head,publishedAt:success}));
  assert.deepEqual(await read(),{error:"PRIVATE_LIVE_DELIVERY_UNAVAILABLE"});
});

test("shadow, old policy, outside observation window, mixed sources and partial TOP are rejected", () => {
  for (const mutate of [r => { r[0].mode = "shadow"; }, r => { r[0].officialSignalTime = "14:30:00"; },
    r => { r[0].collectionCompletedAt = "2026-10-16T05:06:00.000Z"; }, r => { r[0].contentHash = "b".repeat(64); },
    r => { r[0].records.pop(); }]) {
    const raw = fixture(); mutate(raw);
    assert.throws(() => createLiveDelivery(raw, { exportedAt: "2026-10-16T05:07:00.000Z", now }));
  }
});

test("public repository, failed authentication and read-only writer never publish", async () => {
  for (const flag of ["private", "deny", "readOnly"]) {
    const b = backend(); b.options[flag] = flag === "private" ? false : true;
    await assert.rejects(deliverPrivateLive(b.store, exportFixture(), { now })); assert.equal(b.files.size, 0);
  }
});

test("remote reader default disabled, sanitized failure, no cache and no automatic writes", async () => {
  const b = backend(), request = new Request("https://fixture.invalid/api/private-live-delivery");
  assert.equal((await privateLiveDeliveryResponse(request, { env: {}, fetchImpl: b.fetchImpl })).status, 404);
  assert.equal(b.methods.length, 0);
  await deliverPrivateLive(b.store, exportFixture(), { now }); b.methods.length = 0; b.options.readOnly = true;
  const env = { PRIVATE_LIVE_DELIVERY_READ_ENABLED: "true", PRIVATE_LIVE_DELIVERY_REPOSITORY: "fixture/private", PRIVATE_LIVE_DELIVERY_READ_TOKEN: "FIXTURE_ONLY" };
  const response = await privateLiveDeliveryResponse(request, { env, fetchImpl: b.fetchImpl, now });
  assert.equal(response.status, 200); assert.match(response.headers.get("cache-control"), /no-store/);
  assert.equal((await response.json()).freshnessStatus, "HISTORICAL");
  assert.ok(b.methods.every(method => method === "GET"));
  b.options.deny = true;
  const failure = await privateLiveDeliveryResponse(request, { env, fetchImpl: b.fetchImpl, now });
  assert.equal(failure.status, 503); assert.doesNotMatch(await failure.text(), /FIXTURE_ONLY|Bearer/);
});

test("new reader remains behind admin guard and is not public or automation-eligible", async () => {
  const url = new URL("https://fixture.invalid/api/private-live-delivery");
  assert.equal(isPublicResource(url), false);
  assert.equal(isAutomationRequest(new Request(url), {}), false);
  const machineToken = "x".repeat(43);
  assert.equal(isAutomationRequest(new Request(url, { headers: { authorization: `Bearer ${machineToken}` } }), { TB_AUTOMATION_READ_TOKEN: machineToken }), false);
  const source = await readFile(new URL("../app/api/private-live-delivery/route.ts", import.meta.url), "utf8");
  assert.match(source, /GET = withAdminAccess\(/); assert.match(source, /POST = withAdminAccess\(/);
  assert.match(source, /sameOriginMutation/); assert.match(source, /VERCEL_ENV !== "preview"/);
});

test("outbox freezes export time, resumes after failure and keeps relay/site receipts distinct", async () => {
  const rows = new Map();
  const local = { read: async key => structuredClone(rows.get(key) ?? null), withLock: async (_, fn) => fn(),
    writeImmutable: async (key, value) => { if (rows.has(key)) assert.deepEqual(rows.get(key), value); else rows.set(key, structuredClone(value)); } };
  const b = backend();
  const first = await queueSiteDelivery(local, fixture(), () => "2026-10-16T05:06:00.000Z");
  assert.deepEqual(await queueSiteDelivery(local, fixture(), () => now), first);
  b.options.failHead = true;
  await assert.rejects(flushSiteDelivery(local, b.store, first.key, () => now));
  assert.equal(rows.size, 1);
  b.options.failHead = false;
  const receipt = await flushSiteDelivery(local, b.store, first.key, () => now);
  assert.equal(receipt.websiteVerified, false); assert.equal(rows.size, 2);
  assert.deepEqual(await flushSiteDelivery(local, b.store, first.key, () => now), receipt);
  const changed = fixture(); changed[0].records[0].score++;
  await assert.rejects(queueSiteDelivery(local, changed, () => now), /SOURCE_CONFLICT/);
  await assert.rejects(flushSiteDelivery(local, b.store, "shadow/anything.json", () => now), /KEY_INVALID/);
});

test("actual private local store survives reopened process boundary with immutable outbox and receipt", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "tb-delivery-outbox-"));
  t.after(async () => {
    assert.ok(path.resolve(directory).startsWith(`${path.resolve(os.tmpdir())}${path.sep}tb-delivery-outbox-`));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const local = createLocalExecutionStore(directory), remote = backend();
  const queued = await queueSiteDelivery(local, fixture(), () => "2026-10-16T05:06:00.000Z");
  const original = await fs.readFile(path.join(directory, queued.key), "utf8");
  const reopened = createLocalExecutionStore(directory);
  assert.deepEqual(await queueSiteDelivery(reopened, fixture(), () => now), queued);
  await flushSiteDelivery(reopened, remote.store, queued.key, () => now);
  const receipt = await reopened.read(`live/site-receipts/${queued.deliveryHash}.json`);
  assert.equal(receipt.status, "PRIVATE_RELAY_VERIFIED"); assert.equal(receipt.websiteVerified, false);
  assert.equal(await fs.readFile(path.join(directory, queued.key), "utf8"), original);
});
