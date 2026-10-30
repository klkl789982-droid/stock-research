import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { productionPinnedExclusion } from "./production-core.mjs";

// Execute the real slot transport. Only the Cloudflare base class, clock,
// network, and final model projection are replaced by isolated fixtures.
let source = await fs.readFile(new URL("./src/slot-shard.mjs", import.meta.url), "utf8");
source = source.replace('import { DurableObject } from "cloudflare:workers";', 'class DurableObject { constructor(ctx,env){this.ctx=ctx;this.env=env;} }');
source = source.replace('const sleep = ms => new Promise(r => setTimeout(r, ms));', 'const sleep = async ms => Date.fixtureAdvance(ms);');
for (const relative of ["../../../lib/kis-api-client-core.mjs", "../../../lib/intraday-model-top-official-signal.mjs", "../core.mjs"])
  source = source.replaceAll(JSON.stringify(relative), JSON.stringify(new URL(relative, new URL("./src/slot-shard.mjs", import.meta.url)).href));
const { KisSlotShard } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
const start = Date.parse("2026-10-19T05:00:00Z"), end = start + 300000;

function harness(t, responses, initial = start, failures = {}) {
  let now = initial, index = 0, slotHead = 0, complete = null,firstQuoteAt=null,clockReads=0,completionAttempts=0;
  const completionBodies=[];
  const actualStarts = [], acquisitionRequests = [], events = [];
  let acquisitionCalls = 0, acquisitionIdCalls = 0, grant = null, grantCount = 0, acquiring = 0, peakAcquiring = 0;
  t.mock.method(Date, "now", () => {
    if(failures.finalClockSlip&&now===firstQuoteAt&&++clockReads===3)now+=21;
    return now;
  });
  Date.fixtureAdvance = ms => { now += ms; };
  t.after(() => { delete Date.fixtureAdvance; });
  const slot = () => { const n = Math.max(slotHead, Math.ceil((now + 220) / 220)); slotHead = n + 1; return { slot: n, notBefore: n * 220 }; };
  const broker = { async fetch(input, init) {
    const url = new URL(input);
    if (url.pathname === "/slot-pair-acquire") {
      acquisitionCalls++; acquisitionRequests.push(url.searchParams.get("acquisitionId")); events.push("acquire");
      acquiring++; peakAcquiring = Math.max(peakAcquiring, acquiring);
      try {
      if (failures.acquire) return Response.json({ reason: failures.acquire }, { status: 503 });
      if (failures.acquireMalformed) return new Response("not-json", { status: 503 });
      if (failures.acquireTransport) throw Error(failures.acquireTransport);
      if (!grant || !failures.acquisitionId) {const quoteSlot=slot();firstQuoteAt=quoteSlot.notBefore;grantCount++;grant={ record: failures.pinnedInput ?? { code: "203650", eligible: true },
      signalDate: "2026-10-19", seedReferenceDate: "2026-10-16", seedContext: { requestedDate: "2026-10-16", contentHash: "a".repeat(64) },
      authenticationRecord: { accessToken: "fixture-only-not-real", generation: 1, expiresAtMs: end + 86400000 }, quoteSlot, minuteSlot: slot(), deadline: end };}
      if (acquisitionCalls <= (failures.acquireNetwork ?? 0)) throw Error("synthetic lost lease response after grant");
      return Response.json(grant);
      } finally { acquiring--; events.push("acquireSettled"); }
    }
    if (url.pathname === "/extra-slot") return Response.json(slot());
    if (url.pathname === "/slot-pair-complete") { complete = JSON.parse(init.body);completionBodies.push(init.body);completionAttempts++;
      if(completionAttempts <= (failures.completeNetwork??0))throw Error("synthetic lost completion acknowledgement");
      return failures.complete
      ? Response.json({ reason: failures.complete }, { status: 503 }) : Response.json({ stored: true }); }
    return Response.json({ reason: "LIVE_CLOUD_AUTH_INVALIDATED" }, { status: 503 });
  } };
  t.mock.method(globalThis, "fetch", async () => {
    events.push("market");
    actualStarts.push(now);
    const value = responses[Math.min(index++, responses.length - 1)];
    now += value.delay ?? 10;
    return value.response();
  });
  class FixtureShard extends KisSlotShard {
    assertInvocation() {}
    brokerFor() { return broker; }
    minuteQueryTime() { return "14:00:00"; }
    acquisitionId() { acquisitionIdCalls++; return failures.acquisitionId ?? super.acquisitionId(); }
    projectPinnedExclusion(args) { return failures.production ? productionPinnedExclusion(args) : null; }
    projectResult({ code, timing }) { return { code, ...timing, status: "AVAILABLE", rawPricesStored: false }; }
  }
  const shard = new FixtureShard({}, { KIS_APP_KEY: "fixture-key", KIS_APP_SECRET: "fixture-secret" });
  return { completionAttempts:()=>completionAttempts, async run() { const r = await shard.fetch(new Request("https://isolated/collect?run=failure-fixture&codes=203650")); return { value: (await r.json()).records[0], complete, actualStarts,completionAttempts,completionBodies,
    acquisitionRequests, acquisitionCalls, acquisitionIdCalls, grantCount, peakAcquiring, events }; } };
}
const success = { response: () => Response.json({ rt_cd: "0" }) };
const html500 = { response: () => new Response("upstream unavailable, not JSON", { status: 500 }) };
const acquisitionId = "11111111-1111-4111-8111-111111111111";

test("lost lease response retries one invocation ID serially and reuses the grant before any market call", async t => {
  const r = await harness(t, [success, success], start, { acquisitionId, acquireNetwork: 2 }).run();
  assert.equal(r.value.status, "AVAILABLE"); assert.equal(r.acquisitionCalls, 3); assert.equal(r.acquisitionIdCalls, 1);
  assert.deepEqual(r.acquisitionRequests, [acquisitionId, acquisitionId, acquisitionId]);
  assert.equal(r.grantCount, 1); assert.equal(r.peakAcquiring, 1);
  assert.deepEqual(r.events.slice(0, 6), ["acquire", "acquireSettled", "acquire", "acquireSettled", "acquire", "acquireSettled"]);
  assert.equal(r.actualStarts.length, 2); assert.equal(r.complete.calls.length, 2);
  assert.equal(r.value.retryEvidence.filter(row => row.kind === "lease").length, 2);
});

test("lease response loss is bounded at three attempts with no market call or false success", async t => {
  const r = await harness(t, [], start, { acquisitionId, acquireNetwork: 3 }).run();
  assert.equal(r.acquisitionCalls, 3); assert.equal(r.grantCount, 1); assert.equal(r.actualStarts.length, 0);
  assert.equal(r.value.reason, "DIAG_UNKNOWN_TRANSPORT_FAILURE"); assert.equal(r.value.failureStage, "LEASE_ACQUIRE");
  assert.equal(r.value.status, undefined); assert.equal(r.complete, null);
});

test("explicit HTTP, platform and budget acquisition errors are not retried", async t => {
  for (const failure of [{ acquire: "LIVE_CLOUD_SQL_BUDGET" }, { acquireMalformed: true },
    { acquireTransport: "Too many subrequests" }, { acquireTransport: "LIVE_CLOUD_RETRY_BUDGET" }]) {
    const r = await harness(t, [], start, { acquisitionId, ...failure }).run();
    assert.equal(r.acquisitionCalls, 1); assert.equal(r.actualStarts.length, 0); assert.equal(r.value.status, undefined);
  }
});

test("diagnostic shard without an invocation ID does not retry an ambiguous lease", async t => {
  const r = await harness(t, [], start, { acquireNetwork: 1 }).run();
  assert.deepEqual(r.acquisitionRequests, [null]); assert.equal(r.acquisitionCalls, 1); assert.equal(r.actualStarts.length, 0);
  assert.equal(r.value.reason, "DIAG_UNKNOWN_TRANSPORT_FAILURE");
});

test("pinned noneligible input is durably excluded without quote/minute calls or invented timestamps", async t => {
  const r = await harness(t, [], start, { production: true, pinnedInput: { code: "203650", name: "Excluded fixture", eligible: false } }).run();
  assert.equal(r.value.status, "EXCLUDED"); assert.equal(r.value.exclusionBasis, "PINNED_EOD_INELIGIBLE");
  assert.equal(r.actualStarts.length, 0); assert.deepEqual(r.complete.calls, []); assert.equal(r.completionAttempts, 1);
  assert.equal(r.value.scores, null); assert.equal(r.value.seedReferenceDate, "2026-10-16");
  assert.match(r.value.inputHash, /^[a-f0-9]{64}$/u);
  for (const field of ["observedDate", "observedTime", "quoteReceivedAt", "minuteReceivedAt"]) assert.equal(r.value[field], undefined);
});

test("unknown eligibility or wrong pinned identity cannot silently become an exclusion", async t => {
  for (const pinnedInput of [{ code: "203650" }, { code: "999999", eligible: false }]) {
    const r = await harness(t, [], start, { production: true, pinnedInput }).run();
    assert.equal(r.value.reason, "LIVE_CLOUD_INPUT_REJECTED"); assert.equal(r.value.status, undefined); assert.equal(r.actualStarts.length, 0);
  }
});

test("durable storage failure on a pinned exclusion remains blocking", async t => {
  const h = harness(t, [], start, { production: true, pinnedInput: { code: "203650", eligible: false }, complete: "LIVE_CLOUD_STORAGE_BUDGET" });
  await assert.rejects(h.run(), /LIVE_CLOUD_STORAGE_BUDGET/u); assert.equal(h.completionAttempts(), 1);
});

test("non-JSON HTTP500 is retried once; the successful attempt retains its real timestamps", async t => {
  const r = await harness(t, [html500, success, success]).run();
  assert.equal(r.value.status, "AVAILABLE");
  assert.equal(r.complete.calls.length, 3);
  assert.equal(r.complete.calls[0].status, 500);
  assert.equal(r.value.retryEvidence[0].reason, "KIS_HTTP_500");
  assert.equal(Date.parse(r.value.quoteRequestedAt), r.complete.calls[1].started);
  assert.equal(Date.parse(r.value.quoteReceivedAt), r.complete.calls[1].completed);
  assert.notEqual(r.value.quoteRequestedAt, r.value.retryEvidence[0].requestedAt);
  assert.ok(r.actualStarts.every((v, i) => !i || v - r.actualStarts[i - 1] >= 200));
  assert.ok(!/fixture-key|fixture-secret|fixture-only-not-real|upstream unavailable/u.test(JSON.stringify(r.value)));
});

test("persistent HTTP500 is bounded at three requests and remains a failed required input", async t => {
  const r = await harness(t, [html500]).run();
  assert.equal(r.complete.calls.length, 3);
  assert.equal(r.value.reason, "KIS_HTTP_500");
  assert.equal(r.value.inputEligible, true);
  assert.equal(r.value.status, undefined);
});
test("two transient HTTP500 responses may recover on the third unique paced attempt",async t=>{
 const r=await harness(t,[html500,html500,success,success]).run();
 assert.equal(r.value.status,"AVAILABLE");assert.equal(r.complete.calls.length,4);assert.equal(r.value.retryEvidence.length,2);
 assert.equal(Date.parse(r.value.quoteRequestedAt),r.complete.calls[2].started);
 assert.equal(new Set(r.complete.calls.map(c=>c.slot)).size,4);
 assert.ok(r.actualStarts.every((v,i)=>!i||v-r.actualStarts[i-1]>=200));
});
test("two transient network errors may recover on the third unique attempt",async t=>{
 const broken={response:()=>{throw Error("synthetic network disconnect");}};
 const r=await harness(t,[broken,broken,success,success]).run();assert.equal(r.value.status,"AVAILABLE");assert.equal(r.complete.calls.length,4);
});
test("non-transient HTTP400 is not retried",async t=>{
 const r=await harness(t,[{response:()=>new Response(null,{status:400})}]).run();
 assert.equal(r.value.reason,"KIS_HTTP_400");assert.equal(r.complete.calls.length,1);
});

test("HTTP500 near14:05 cannot start a retry outside the observation window", async t => {
  const r = await harness(t, [html500], end - 800).run();
  assert.equal(r.complete.calls.length, 1);
  assert.equal(r.value.reason, "KIS_HTTP_500");
  assert.equal(r.value.status, undefined);
});

test("late success cannot replace a failed first attempt or become a valid observation", async t => {
  const r = await harness(t, [{ ...success, delay: 2500 }], end - 1000).run();
  assert.equal(r.complete.calls.length, 1);
  assert.equal(r.value.reason, "DIAG_COLLECTION_DEADLINE");
  assert.equal(r.value.status, undefined);
  assert.equal(r.complete.calls[0].completed > end, true);
});

test("HTTP200 malformed JSON fails closed instead of fabricating a usable result", async t => {
  const r = await harness(t, [{ response: () => new Response("not-json", { status: 200 }) }]).run();
  assert.equal(r.value.status, undefined);
  assert.equal(r.value.reason, "KIS_RESPONSE_INVALID");
  assert.equal(r.complete.calls.length, 1);
});

test("failure before lease acquisition is retained in the batch output with its stage", async t => {
  const r = await harness(t, [], start, { acquire: "LIVE_CLOUD_SQL_BUDGET" }).run();
  assert.equal(r.value.reason, "LIVE_CLOUD_SQL_BUDGET");
  assert.equal(r.value.failureStage, "LEASE_ACQUIRE");
  assert.equal(r.complete, null);
});

test("successful collection followed by durable storage failure preserves the storage code", async t => {
  const h = harness(t, [success, success], start, { complete: "LIVE_CLOUD_STORAGE_BUDGET" });
  await assert.rejects(h.run(), /LIVE_CLOUD_STORAGE_BUDGET/u);
  assert.equal(h.completionAttempts(), 1, "explicit durable rejection must not be retried as an ambiguous ACK");
});

test("a21ms slip between guard and actual start consumes no market call in the missed slot",async t=>{
 const r=await harness(t,[success,success],start,{finalClockSlip:true}).run();
 assert.equal(r.value.status,"AVAILABLE");assert.ok(r.complete.skipped.some(v=>v.kind==="quote"));
 assert.equal(r.complete.calls.length,2);
 for(const c of r.complete.calls)assert.ok(c.started>=c.slot*220&&c.started<=c.slot*220+20);
 assert.ok(r.actualStarts.every((v,i)=>!i||v-r.actualStarts[i-1]>=200));
});

test("lost immutable completion acknowledgement is retried once with identical bytes and no recollection",async t=>{
  const r=await harness(t,[success,success],start,{completeNetwork:1}).run();
  assert.equal(r.value.status,"AVAILABLE");assert.equal(r.actualStarts.length,2);assert.equal(r.completionAttempts,2);
  assert.equal(r.completionBodies[0],r.completionBodies[1]);
});

test("persistent completion transport loss stops after2; explicit durable rejection is not retried",async t=>{
  const h= harness(t,[success,success],start,{completeNetwork:2});
  await assert.rejects(h.run(),/DIAG_UNKNOWN_TRANSPORT_FAILURE/u);assert.equal(h.completionAttempts(),2);
});
