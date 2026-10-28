import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

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
  let now = initial, index = 0, slotHead = 0, complete = null,firstQuoteAt=null,clockReads=0;
  const actualStarts = [];
  t.mock.method(Date, "now", () => {
    if(failures.finalClockSlip&&now===firstQuoteAt&&++clockReads===3)now+=21;
    return now;
  });
  Date.fixtureAdvance = ms => { now += ms; };
  t.after(() => { delete Date.fixtureAdvance; });
  const slot = () => { const n = Math.max(slotHead, Math.ceil((now + 220) / 220)); slotHead = n + 1; return { slot: n, notBefore: n * 220 }; };
  const broker = { async fetch(input, init) {
    const url = new URL(input);
    if (url.pathname === "/slot-pair-acquire" && failures.acquire) return Response.json({ reason: failures.acquire }, { status: 503 });
    if (url.pathname === "/slot-pair-acquire") {const quoteSlot=slot();firstQuoteAt=quoteSlot.notBefore;return Response.json({ record: { eligible: true }, authenticationRecord: { accessToken: "fixture-only-not-real", generation: 1, expiresAtMs: end + 86400000 }, quoteSlot, minuteSlot: slot(), deadline: end });}
    if (url.pathname === "/extra-slot") return Response.json(slot());
    if (url.pathname === "/slot-pair-complete") { complete = JSON.parse(init.body); return failures.complete
      ? Response.json({ reason: failures.complete }, { status: 503 }) : Response.json({ stored: true }); }
    return Response.json({ reason: "LIVE_CLOUD_AUTH_INVALIDATED" }, { status: 503 });
  } };
  t.mock.method(globalThis, "fetch", async () => {
    actualStarts.push(now);
    const value = responses[Math.min(index++, responses.length - 1)];
    now += value.delay ?? 10;
    return value.response();
  });
  class FixtureShard extends KisSlotShard {
    assertInvocation() {}
    brokerFor() { return broker; }
    minuteQueryTime() { return "14:00:00"; }
    projectResult({ code, timing }) { return { code, ...timing, status: "AVAILABLE", rawPricesStored: false }; }
  }
  const shard = new FixtureShard({}, { KIS_APP_KEY: "fixture-key", KIS_APP_SECRET: "fixture-secret" });
  return { async run() { const r = await shard.fetch(new Request("https://isolated/collect?run=failure-fixture&codes=203650")); return { value: (await r.json()).records[0], complete, actualStarts }; } };
}
const success = { response: () => Response.json({ rt_cd: "0" }) };
const html500 = { response: () => new Response("upstream unavailable, not JSON", { status: 500 }) };

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
});

test("a21ms slip between guard and actual start consumes no market call in the missed slot",async t=>{
 const r=await harness(t,[success,success],start,{finalClockSlip:true}).run();
 assert.equal(r.value.status,"AVAILABLE");assert.ok(r.complete.skipped.some(v=>v.kind==="quote"));
 assert.equal(r.complete.calls.length,2);
 for(const c of r.complete.calls)assert.ok(c.started>=c.slot*220&&c.started<=c.slot*220+20);
 assert.ok(r.actualStarts.every((v,i)=>!i||v-r.actualStarts[i-1]>=200));
});
