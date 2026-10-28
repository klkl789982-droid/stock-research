import { DurableObject, WorkflowEntrypoint } from "cloudflare:workers";
import { runCongestion } from "./congestion-runner.mjs";
import { ProductionDayState as Before } from "./incident-baseline.mjs";
import { ProductionDayState as After } from "./production-state.mjs";
import { requestContextFixture,contextRequest } from "./request-context-fixture.mjs";
import { createFixedBatchGroup } from "./batch-creation.mjs";
import { verifyNativeReceiptClock } from "./receipt-clock-fixture.mjs";

// Dedicated binding-only fixture: no secrets, KIS binding, Cron, public route
// or operational object namespace. All dates/data are explicitly synthetic.
export class SqlReplayDay extends DurableObject {
  receiptClockProof(){return verifyNativeReceiptClock(this);}
  contextEcho(code){if(!/^9000(?:0[0-9]|1[01])$/u.test(code))throw Error("CONTEXT_FIXTURE_CODE_INVALID");return code;}
  async contextInitialize(){const f=requestContextFixture(this);await f.state.prepare(f.input.date,true);f.setClock(f.b.start);return{codes:f.input.prepared.codes.slice(0,12)};}
  async fanoutInitialize(){const f=requestContextFixture(this);await f.state.prepare(f.input.date,true);f.setClock(f.b.start);return{codes:f.input.prepared.codes,batchSize:4};}
  fanoutComplete(index,codes){const f=requestContextFixture(this);if(!Number.isSafeInteger(index)||index<0||index>138||JSON.stringify(codes)!==JSON.stringify(f.input.prepared.codes.slice(index*4,index*4+4)))throw Error("FANOUT_FIXTURE_ASSIGNMENT");
    return f.state.recordBatchResult(f.input.date,`live-${f.input.date}`,codes,{status:"complete",output:{attempted:codes.length,successful:codes.length,failed:[]}});
  }
  fanoutReadback(){const f=requestContextFixture(this),reopened=new After({sql:this.ctx.storage.sql,now:f.now,env:f.state.env,transaction:fn=>this.ctx.storage.transactionSync(fn)}),result=reopened.reconcileJournal(f.input.date,`live-${f.input.date}`);
    return{...result,syntheticOnly:true,topologyOnly:true,kisCalls:0,symbols:553,batches:139,sqlCursor:f.meter,outbox:!!reopened.read("outbox"),productionPathUsed:false};
  }
  fanoutDropOnce(){const f=requestContextFixture(this);if(f.state.read("test-created-response-dropped"))return false;f.state.write("test-created-response-dropped",{syntheticOnly:true});return true;}
  async fetch(request){try{return await contextRequest(this,request);}catch(e){return Response.json({reason:/^[A-Z0-9_]{1,100}$/u.test(e.message)?e.message:"CONTEXT_FIXTURE_REQUEST_FAILED"},{status:503});}}
  async contextReadback(){const f=requestContextFixture(this),codes=f.input.prepared.codes.slice(0,12);
    const reopened=new After({sql:this.ctx.storage.sql,now:f.now,env:f.state.env,transaction:fn=>this.ctx.storage.transactionSync(fn)});
    const duplicate=await reopened.acquire(f.input.date,codes[0]);
    return{syntheticOnly:true,kisCalls:0,codes:codes.length,completed:codes.filter(code=>reopened.read(`observation:${code}`)?.status==="AVAILABLE").length,
      peakPending:f.peakPending,peakActive:f.peakActive,duplicateReturnsOriginal:!!duplicate.existing,pending:f.state.pending.size,
      active:reopened.q("SELECT code FROM leases WHERE completed=0 AND expires>?",f.now()).length,sqlCursor:f.meter,outbox:!!reopened.read("outbox"),productionPathUsed:false};
  }
  readback() {
    const state = new After({ sql: this.ctx.storage.sql, now: () => Date.parse("2002-01-03T05:05:01.000Z"),
      env: { LIVE_PRODUCTION_ENABLED: "true", LIVE_PRODUCER: "cloud", LIVE_CUTOVER_RECEIPT_HASH: "f".repeat(64) },
      transaction: fn => this.ctx.storage.transactionSync(fn) });
    const first = state.read("outbox"), before = { ...state.credit };
    let failedSqlCharged = false;
    try { state.q("SELECT synthetic_missing_column FROM docs"); } catch { failedSqlCharged = state.credit.r <= before.r - 32 && state.credit.w <= before.w - 16; }
    const reopenedDelivery = state.finish("2002-01-03");
    const again = state.read("outbox");
    return { syntheticOnly: true, kisCalls: 0, failedSqlCharged, frozenHashUnchanged: first.delivery.deliveryHash === reopenedDelivery.deliveryHash,
      firstIssuanceUnchanged: first.swing.createdAt === again.swing.createdAt, topRows: again.swing.selections.length,
      predictionsNull: again.swing.records.every(r => r.predictions.expectedReturn === null), nativeStatus: state.status(), sourcePricesIncluded: false };
  }
  async replay(mode) {
    if (!["before", "after"].includes(mode)) throw new Error("TEST_MODE_INVALID");
    const native = { queries: 0, usageUpdates: 0, rowsRead: 0, rowsWritten: 0 };
    const raw = this.ctx.storage.sql;
    const sql = { get databaseSize() { return raw.databaseSize; }, exec(query, ...args) {
      // Separate hard fixture cap; abort rather than pay/raise production caps.
      if (native.rowsWritten + 16 > 22000 || native.rowsRead + 2048 > 150000) throw new Error("ISOLATED_SQL_TEST_BUDGET");
      const c = raw.exec(query, ...args), rows = c.toArray();
      native.queries++; if (query.startsWith("UPDATE usage")) native.usageUpdates++;
      native.rowsRead += c.rowsRead; native.rowsWritten += c.rowsWritten;
      return { rowsRead: c.rowsRead, rowsWritten: c.rowsWritten, toArray: () => rows };
    } };
    const result = await runCongestion({ sql, State: mode === "before" ? Before : After, transaction: fn => this.ctx.storage.transactionSync(fn) });
    return { ...result, rowMeasurement: "ACTUAL_CLOUDFLARE_SQL_CURSOR", native, productionPathUsed: false, sourcePricesIncluded: false };
  }
}
export class SqlReplay extends WorkflowEntrypoint {
  async run(event, step) {
    const mode = event.payload?.mode;
    if(mode==="receipt-clock"){
      if(!/^sql-receipt-[a-z0-9-]{1,32}$/u.test(event.instanceId))throw Error("TEST_INSTANCE_INVALID");
      return step.do("isolated native receipt-clock reproduction and fix",{retries:{limit:0,delay:"1 second"},timeout:"30 seconds"},()=>this.env.SQL_REPLAY_DAYS.get(this.env.SQL_REPLAY_DAYS.idFromName(event.instanceId)).receiptClockProof());
    }
    if(mode==="fanout-child"){
      const p=event.payload;if(!/^sql-fanout-[a-z0-9-]{1,32}$/u.test(p.parent??"")||event.instanceId!==`${p.parent}-b${p.index}`)throw Error("TEST_INSTANCE_INVALID");
      return step.do("persist one synthetic fixed batch journal",{retries:{limit:0,delay:"1 second"},timeout:"30 seconds"},()=>this.env.SQL_REPLAY_DAYS.get(this.env.SQL_REPLAY_DAYS.idFromName(p.parent)).fanoutComplete(p.index,p.codes));
    }
    if(mode==="fanout-parent"){
      const parent=event.payload.targetParent??event.instanceId;if(!/^sql-fanout-[a-z0-9-]{1,32}$/u.test(parent)||!/^sql-fanout-[a-z0-9-]{1,32}$/u.test(event.instanceId))throw Error("TEST_INSTANCE_INVALID");
      const target=this.env.SQL_REPLAY_DAYS.get(this.env.SQL_REPLAY_DAYS.idFromName(parent)),config={retries:{limit:0,delay:"1 second"},timeout:"30 seconds"};
      const prepared=await step.do("initialize synthetic139batch topology",config,()=>target.fanoutInitialize());
      const definitions=Array.from({length:139},(_,index)=>({id:`${parent}-b${index}`,params:{mode:"fanout-child",parent,index,codes:prepared.codes.slice(index*4,index*4+4)}}));
      for(let offset=0;offset<definitions.length;offset+=50){
        if(offset)await step.sleep(`pace isolated creation ${offset}`,"2 seconds");
        await step.do(`native object-form fixed batch create ${offset}`,{...config,retries:{limit:2,delay:"5 seconds",backoff:"exponential"}},async()=>{
          const result=await createFixedBatchGroup(this.env.SQL_REPLAY,definitions.slice(offset,offset+50));
          if(event.payload.injectLostResponse===true&&offset===50&&await target.fanoutDropOnce())throw Error("LIVE_CLOUD_BATCH_CREATE_UNCONFIRMED");
          return result;
        });
      }
      await step.sleep("bounded wait for synthetic batch journals","10 seconds");
      return step.do("native139batch durable journal readback",config,async()=>{const result=await target.fanoutReadback();if(!result.ready||result.firstFailure||result.pendingBatches)throw Error("FANOUT_FIXTURE_INCOMPLETE");return result;});
    }
    if(mode==="context"){
      if(!/^sql-context-[a-z0-9-]{1,32}$/u.test(event.instanceId))throw Error("TEST_INSTANCE_INVALID");
      const target=this.env.SQL_REPLAY_DAYS.get(this.env.SQL_REPLAY_DAYS.idFromName(event.instanceId));
      const config={retries:{limit:0,delay:"1 second"},timeout:"30 seconds"};
      const {codes}=await step.do("initialize context-only synthetic input",config,()=>target.contextInitialize());
      await step.do("twelve independent incoming requests with eight durable slots",config,async()=>{
        const outcomes=await Promise.all(codes.map(async code=>{
          const acquired=await target.fetch(`https://isolated/context-acquire?code=${code}`),lease=await acquired.json();
          if(!acquired.ok)throw Error(lease.reason);
          await new Promise(resolve=>setTimeout(resolve,100));
          const completed=await target.fetch(`https://isolated/context-complete?code=${code}`,{method:"POST",body:JSON.stringify(lease)}),value=await completed.json();
          if(!completed.ok)throw Error(value.reason);return code;
        }));return{completed:outcomes.length};
      });
      return step.do("reopen and verify no stranded or duplicate acquisition",config,()=>target.contextReadback());
    }
    if (!["before", "after", "fault"].includes(mode) || !/^sql-(?:before|after|fault)-[a-z0-9-]{1,32}$/u.test(event.instanceId)) throw new Error("TEST_INSTANCE_INVALID");
    if (mode === "fault") return await step.do("isolated restart readback and failedSQL charge", { retries: { limit: 0, delay: "1 second" }, timeout: "30 seconds" }, () =>
      this.env.SQL_REPLAY_DAYS.get(this.env.SQL_REPLAY_DAYS.idFromName("sql-after-20261020-final")).readback());
    return await step.do("isolated70batch553nativecursor", { retries: { limit: 0, delay: "1 second" }, timeout: "2 minutes" }, () =>
      this.env.SQL_REPLAY_DAYS.get(this.env.SQL_REPLAY_DAYS.idFromName(event.instanceId)).replay(mode));
  }
}
const closedHttp = { fetch() { return new Response(null, { status: 404 }); } };
export default closedHttp;
