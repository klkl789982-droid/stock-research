import test from"node:test";import assert from"node:assert/strict";import{DatabaseSync}from"node:sqlite";
import{ProductionDayState}from"./production-state.mjs";
import{syntheticProductionInputs}from"./swing-fixture.mjs";
import{runCloudWatchdog,WATCH_PREFIX}from"./watchdog.mjs";
import{canonicalContentHash as hash}from"../../lib/canonical-content-hash.mjs";
const date="2002-01-03",env={LIVE_PRODUCTION_ENABLED:"true",LIVE_PRODUCER:"cloud",LIVE_CUTOVER_RECEIPT_HASH:"f".repeat(64)};
async function fixture(t,{rows=553,frozen=false}={}){
 const db=new DatabaseSync(":memory:");t.after(()=>db.close());let now=Date.parse(`${date}T13:59:00+09:00`),fail=false;
 const values=new Map(),store={verifyPrivateRepository:async()=>{},async read(k){return values.has(k)?{value:structuredClone(values.get(k))}:null;},
  async writeImmutable(k,v){if(fail){fail=false;throw Error("PRIVATE_STORE_NETWORK_FAILED");}if(values.has(k))assert.equal(hash(values.get(k)),hash(v));else values.set(k,structuredClone(v));},
  async listKeys(prefix){const entries=new Map();for(const k of values.keys())if(k.startsWith(`${prefix}/`)){const rest=k.slice(prefix.length+1),[name]=rest.split("/");entries.set(name,{name,type:rest.includes("/")?"dir":"file"});}return[...entries.values()];}};
 const sql={get databaseSize(){return db.prepare("PRAGMA page_count").get().page_count*4096;},exec(q,...args){const rows=db.prepare(q).all(...args);return{rowsRead:rows.length+1,rowsWritten:/^(INSERT|UPDATE)/u.test(q)?2:0,toArray:()=>rows};}};
 const input=syntheticProductionInputs({date,seedDate:"2001-12-28"});
 const state=new ProductionDayState({sql,env,now:()=>now,remote:store,transaction(fn){db.exec("BEGIN");try{const r=fn();db.exec("COMMIT");return r;}catch(e){db.exec("ROLLBACK");throw e;}},prepare:async()=>({...input.prepared,remoteCheckedAt:new Date(now).toISOString()})});
 await state.prepare(date,true);
 for(const row of input.rows.slice(553-rows))state.write(`observation:${row.code}`,row);
 for(let i=0;i<553;i+=4){const codes=input.prepared.codes.slice(i,i+4);state.recordBatchResult(date,`live-${date}`,codes,{status:"complete",output:{attempted:codes.length,successful:codes.length,failed:[]}});}
 if(frozen){state.reconcileJournal(date,`live-${date}`,true);now=Date.parse(`${date}T14:06:00+09:00`);state.finish(date);}
 const calls=[],workflow={get:async()=>({status:async()=>({status:"running"})}),create:async p=>calls.push(p)};
 const run=async(slot,extra={})=>{now=Date.parse(`${date}T${slot.slice(0,2)}:${slot.slice(2)}:00+09:00`);return runCloudWatchdog({state,remote:store,workflow,fetchImpl:async url=>new Response(null,{status:url.endsWith("/login")?200:401}),date,slot,scheduledAt:now,now,...extra});};
 return{state,store,values,calls,workflow,run,now:()=>now,set:n=>{now=n;},failNext:()=>{fail=true;}};
}
test("all existing inputs can finalize without collection; frozen transfer recovers only in two approved watch slots",async t=>{
 const f=await fixture(t);const finalized=await f.run("1405");assert.equal(finalized.result.frozen,true);assert.equal(finalized.collectionStarted,false);
 const original=f.state.read("outbox").delivery;f.failNext();const failure=await f.run("1415");
 assert.equal(failure.status,"UNVERIFIED");assert.ok(failure.problems.some(p=>p.stage==="FROZEN_RELAY"));
 const success=await f.run("1515");assert.equal(success.status,"DELIVERY_VERIFIED");assert.equal(success.privateReadback.deliveryHash,original.deliveryHash);
 assert.equal(success.site.authenticatedUi,"NOT_CHECKED_NO_ADMIN_SESSION");assert.equal(f.state.read("outbox").delivery.exportedAt,original.exportedAt);
 assert.equal(f.state.read("relay-watch-attempt").count,2);await f.run("1515");assert.equal(f.state.read("relay-watch-attempt").count,2);
 assert.equal(f.calls.length,0);const {recordHash,...body}=success;assert.equal(hash(body),recordHash);
});
test("one missing required observation blocks result, not a partial ranking",async t=>{
 const f=await fixture(t,{rows:552}),r=await f.run("1405");assert.equal(r.status,"BLOCKED");assert.equal(f.state.read("outbox"),null);assert.equal(f.state.read("receipt"),null);
 assert.ok(r.problems.some(p=>p.code==="LIVE_CLOUD_COMPLETION_MISMATCH"));
});
test("a missing regular workflow is ensured once with the canonical ID, never restarted after14",async t=>{
 const f=await fixture(t);f.workflow.get=async()=>{throw Object.assign(Error("not found"),{code:10400});};
 const initial=await f.run("1340");assert.equal(initial.status,"WAITING");assert.equal(f.calls.length,0,"same-minute scheduler race is not an incident");
 const a=await f.run("1345");assert.equal(a.actions[0],"ENSURE_CANONICAL_DAY_ONLY");assert.deepEqual(f.calls,[{id:`live-${date}`,params:{mode:"day",date}}]);
 await f.run("1345");await f.run("1400");assert.equal(f.calls.length,1);
});
test("authorization/unknown lookup failures cannot trigger another collector",async t=>{
 const f=await fixture(t);f.workflow.get=async()=>{throw Error("PRIVATE_STORE_AUTHORIZATION_FAILED");};
 const r=await f.run("1345");assert.equal(f.calls.length,0);assert.equal(r.workflowState,"UNKNOWN");assert.equal(r.status,"UNVERIFIED");
});
test("late or wrong-slot invocations do not perform recovery or write audit",async t=>{
 const f=await fixture(t);const stamp=Date.parse(`${date}T14:15:00+09:00`);
 const r=await runCloudWatchdog({state:f.state,date,slot:"1415",scheduledAt:stamp,now:stamp+120001});
 assert.equal(r.status,"WATCH_SKIPPED_TIME");assert.equal(f.state.read("watch-claimed:1415"),null);
 await assert.rejects(f.state.relay(date,f.store,{watchdog:true}),/NO_OUTBOX/);
});
test("a bounded late Cron may relay the same bytes but cannot extend its retry window",async t=>{
 const f=await fixture(t,{frozen:true}),at=Date.parse(`${date}T14:15:00+09:00`);
 f.set(at+60000);f.failNext();await assert.rejects(f.state.relay(date,f.store,{watchdog:true,watchSlot:"1415"}),/NETWORK_FAILED/);
 assert.equal(f.state.read("relay-watch-attempt").count,1);
 f.set(at+120001);await assert.rejects(f.state.relay(date,f.store,{watchdog:true,watchSlot:"1415"}),/SLOT_INVALID/);
 assert.equal(f.state.read("relay-watch-attempt").count,1);
});
test("anonymous site probes are not reported as authenticated UI proof",async t=>{
 const f=await fixture(t,{frozen:true});await f.run("1415");const r=await f.run("1525",{fetchImpl:async()=>new Response(null,{status:403})});
 assert.equal(r.status,"DELIVERY_VERIFIED_WITH_WARNINGS");assert.equal(r.site.authenticatedUi,"NOT_CHECKED_NO_ADMIN_SESSION");assert.ok(r.problems.some(p=>p.stage==="SITE_ACCESS_BOUNDARY"));
});
test("an audit write failure keeps its immutable hash and is retransmitted without repeating recovery",async t=>{
 const f=await fixture(t);f.failNext();const r=await f.run("1405");const stored=f.state.read("watch-snapshot:1405");assert.deepEqual(stored,r);
 assert.ok(!f.state.read("watch-published:1405"));await f.run("1430");assert.ok(f.state.read("watch-published:1405"));
 assert.ok([...f.values.keys()].some(k=>k.startsWith(`${WATCH_PREFIX}/${date}/1405-`)));assert.equal(f.state.read("relay-watch-attempt"),null);
});
