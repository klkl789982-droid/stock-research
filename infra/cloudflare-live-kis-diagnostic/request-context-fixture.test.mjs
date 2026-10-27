import test from"node:test";
import assert from"node:assert/strict";
import {DatabaseSync}from"node:sqlite";
import {requestContextFixture,contextRequest}from"./request-context-fixture.mjs";

test("isolated multi-request harness creates a real queued acquisition without market or publication I/O",async t=>{
  const db=new DatabaseSync(":memory:");t.after(()=>db.close());let echoCalls=0;
  const sql={get databaseSize(){return 4096*db.prepare("PRAGMA page_count").get().page_count;},exec(query,...args){const rows=db.prepare(query).all(...args);return{toArray:()=>rows,rowsRead:rows.length+1,rowsWritten:/^(INSERT|UPDATE|CREATE)/u.test(query)?1:0};}};
  const object={ctx:{storage:{sql,transactionSync(fn){db.exec("BEGIN");try{const result=fn();db.exec("COMMIT");return result;}catch(e){db.exec("ROLLBACK");throw e;}}}},
    env:{SQL_REPLAY_DAYS:{idFromName:value=>value,get:id=>{assert.equal(id,"context-fixture-echo-only");return{contextEcho:async code=>{echoCalls++;return code;}};}}}};
  const f=requestContextFixture(object);assert.equal(requestContextFixture(object),f);
  await f.state.prepare(f.input.date,true);f.setClock(f.b.start);
  const jobs=f.input.prepared.codes.slice(0,12).map(async code=>{
    const lease=await(await contextRequest(object,new Request(`https://isolated/context-acquire?code=${code}`))).json();
    const response=await contextRequest(object,new Request(`https://isolated/context-complete?code=${code}`,{method:"POST",body:JSON.stringify(lease)}));
    assert.equal((await response.json()).stored,true);
  });
  await Promise.all(jobs);
  assert.equal(echoCalls,12);assert.equal(f.peakPending,4);assert.equal(f.peakActive,8);assert.equal(f.state.pending.size,0);
  assert.equal(f.state.q("SELECT code FROM leases WHERE completed=0 AND expires>?",f.now()).length,0);
  assert.equal(f.state.read("outbox"),null);assert.equal(f.state.read("receipt"),null);
  const duplicate=await(await contextRequest(object,new Request("https://isolated/context-acquire?code=900000"))).json();
  assert.equal(duplicate.existing.status,"AVAILABLE");assert.equal(echoCalls,12);
  await assert.rejects(contextRequest(object,new Request("https://isolated/context-acquire?code=005930")),/CODE_INVALID/);
  await assert.rejects(contextRequest(object,new Request("https://isolated/not-allowed?code=900000")),/ROUTE_INVALID/);
});
