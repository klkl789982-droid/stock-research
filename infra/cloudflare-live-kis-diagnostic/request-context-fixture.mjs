import { ProductionDayState } from "./production-state.mjs";
import { syntheticProductionInputs } from "./swing-fixture.mjs";
import { bounds } from "./production-core.mjs";

// Native multi-request test, not a production collector. The existing isolated
// Worker has no secrets, market binding, Cron, public route or normal namespace.
export function requestContextFixture(object) {
  if(object.contextFixture)return object.contextFixture;
  const input=syntheticProductionInputs({date:"2002-01-03",seedDate:"2001-12-28"}),b=bounds(input.date);
  let now=b.start-1000;const meter={r:0,w:0};
  const raw=object.ctx.storage.sql,sql={get databaseSize(){return raw.databaseSize;},exec(query,...args){
    if(meter.r+2048>10000||meter.w+16>2000)throw Error("CONTEXT_FIXTURE_SQL_BUDGET");
    const cursor=raw.exec(query,...args),rows=cursor.toArray();meter.r+=cursor.rowsRead;meter.w+=cursor.rowsWritten;
    return{rowsRead:cursor.rowsRead,rowsWritten:cursor.rowsWritten,toArray:()=>rows};
  }};
  const state=new ProductionDayState({sql,now:()=>now,transaction:fn=>object.ctx.storage.transactionSync(fn),
    env:{LIVE_PRODUCTION_ENABLED:"true",LIVE_PRODUCER:"cloud",LIVE_CUTOVER_RECEIPT_HASH:"f".repeat(64)},
    prepare:async()=>({...input.prepared,remoteCheckedAt:new Date(now).toISOString()}),
    bundle:async(_date,_prepared,code)=>{
      // Actual RPC I/O occurs after a different incoming completion request
      // releases a queued acquisition. A single-request replay cannot test it.
      const value=await object.env.SQL_REPLAY_DAYS.get(object.env.SQL_REPLAY_DAYS.idFromName("context-fixture-echo-only")).contextEcho(code);
      if(value!==code)throw Error("CONTEXT_FIXTURE_ECHO_INVALID");
      return{syntheticOnly:true};
    }});
  const fixture={input,b,state,meter,peakPending:0,peakActive:0,setClock:value=>{now=Math.max(now,value);},now:()=>now};
  object.contextFixture=fixture;return fixture;
}

export async function contextRequest(object,request) {
  const f=requestContextFixture(object),url=new URL(request.url),code=url.searchParams.get("code");
  if(!f.input.prepared.codes.slice(0,12).includes(code))throw Error("CONTEXT_FIXTURE_CODE_INVALID");
  if(url.pathname==="/context-acquire"){
    const value=f.state.acquire(f.input.date,code);f.peakPending=Math.max(f.peakPending,f.state.pending.size);
    const lease=await value;f.peakActive=Math.max(f.peakActive,f.state.q("SELECT code FROM leases WHERE completed=0 AND expires>?",f.now()).length);
    return Response.json(lease);
  }
  if(url.pathname!=="/context-complete")throw Error("CONTEXT_FIXTURE_ROUTE_INVALID");
  const lease=await request.json();f.setClock(lease.minuteSlot.notBefore+2);
  const stamp=n=>new Date(n).toISOString(),source=f.input.rows.find(row=>row.code===code);
  const metadata={...source,quoteRequestedAt:stamp(lease.quoteSlot.notBefore),quoteReceivedAt:stamp(lease.quoteSlot.notBefore+1),
    minuteRequestedAt:stamp(lease.minuteSlot.notBefore),minuteReceivedAt:stamp(lease.minuteSlot.notBefore+2),
    observedTime:new Date(lease.quoteSlot.notBefore+9*3600000).toISOString().slice(11,19)};
  const calls=[["quote",lease.quoteSlot],["minute",lease.minuteSlot]].map(([kind,s])=>({kind,slot:s.slot,started:s.notBefore,completed:s.notBefore+1,status:200}));
  f.state.complete(f.input.date,code,{metadata,calls});return Response.json({stored:true});
}
