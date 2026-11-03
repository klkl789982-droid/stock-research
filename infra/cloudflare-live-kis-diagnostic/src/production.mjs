import { DurableObject, WorkflowEntrypoint } from "cloudflare:workers";
import { KisSlotShard } from "./slot-shard.mjs";
import { ProductionDayState } from "../production-state.mjs";
import { assertProduction, assertWindow, bounds, kst, productionObservation, productionPinnedExclusion, isLiveMissingReason, observationFailureReasons, WATCH_CRON } from "../production-core.mjs";
import { safeCode, edgeFetch, transportReason } from "../core.mjs";
import { createKisEodPrivateStore } from "../../../lib/kis-eod-private-store.mjs";
import { privateRequestBudget } from "../relay-budget.mjs";
import { verifyNativeProductionFixture } from "../production-fixture.mjs";
import { executionRecordKey } from "../../../lib/private-live-execution-status.mjs";
import { createFixedBatchGroup } from "../batch-creation.mjs";
import { runCloudWatchdog,watchSlot,WATCH_SLOTS } from "../watchdog.mjs";
import { completeWithReceiptClock, extraWithReceiptClock } from "../receipt-clock.mjs";
const options = { retries: { limit: 0, delay: "1 second" }, timeout: "6 minutes" };
const runOf = run => { const m = /^live-(\d{4}-\d{2}-\d{2})(?:-(recovery-[A-Za-z0-9_-]{1,24}|missing-only))?$/u.exec(run ?? ""); if (!m) throw new Error("LIVE_CLOUD_DATE_INVALID"); return { date: m[1], dayName: m[2]?.startsWith("recovery-") ? `${m[1]}-${m[2]}` : m[1], missingOnly:m[2]==="missing-only" }; };
const vault = env => env.BROKER.get(env.BROKER.idFromName("single-approved-kis-credential-v1"));
const day = (env, name) => env.LIVE_DAYS.get(env.LIVE_DAYS.idFromName(name), { locationHint: "apac-ne" });
async function publishExecutionRecord(state,remote,date,event,workflowState,error) {
  const record=state.freezeExecution(date,event,workflowState,error),key=`published-policy-status:${event}`;
  if(!event.startsWith("POLICY_") || state.read(key)?.recordHash!==record.recordHash){
    await remote.writeImmutable(executionRecordKey(record),record);
    if(event.startsWith("POLICY_"))state.write(key,{recordHash:record.recordHash});
  }
  return {status:"EXECUTION_METADATA_STORED",signalDate:date,recordHash:record.recordHash};
}
export function assertIsolatedProductionFixture(env, now = Date.now()) {
  assertProduction(env);
  if (env.LIVE_ENABLED !== "false" || env.DIAGNOSTIC_ONLY !== "true") throw new Error("DIAG_PRODUCTION_FIXTURE_DISABLED");
  const t = kst(now), weekday = new Date(`${t.date}T00:00:00Z`).getUTCDay();
  if (weekday > 0 && weekday < 6 && t.time >= "13:35:00" && t.time <= "15:35:00") throw new Error("DIAG_PRODUCTION_FIXTURE_WINDOW_EXCLUDED");
}
const childState = value => String(value ?? "unknown").toLowerCase();
export function batchResult(definition, status) {
  const codes = definition.params.codes, workflowStatus = childState(status?.status);
  if (workflowStatus === "complete") {
    const output = status?.output;
    if (!output || output.attempted !== codes.length || !Number.isSafeInteger(output.successful) || !Array.isArray(output.failed)
      || output.successful < 0 || output.successful + output.failed.length !== codes.length
      || new Set(output.failed.map(row => row.code)).size !== output.failed.length
      || output.failed.some(row => !codes.includes(row.code) || safeCode({ code: row.reason }) !== row.reason
        || row.failureStage !== undefined && !["LEASE_ACQUIRE","LEASED_SETUP","COLLECTION","UNKNOWN"].includes(row.failureStage)))
      return { id: definition.id, codes, workflowStatus, attempted: 0, successful: 0,
        failures: codes.map(code => ({ code, reason: "LIVE_CLOUD_CHILD_OUTPUT_INVALID", failureStage: "UNKNOWN" })) };
    return { id: definition.id, codes, workflowStatus, attempted: output.attempted, successful: output.successful,
      failures: output.failed.map(row => ({ code: row.code, reason: row.reason, failureStage: row.failureStage ?? "UNKNOWN" })) };
  }
  const wrapper = safeCode(status?.error);
  const reason = wrapper === "DIAG_REQUEST_FAILED" ? workflowStatus === "errored" ? "LIVE_CLOUD_CHILD_ERRORED"
    : workflowStatus === "terminated" ? "LIVE_CLOUD_CHILD_TERMINATED" : "LIVE_CLOUD_CHILD_NOT_COMPLETE" : wrapper;
  return { id: definition.id, codes, workflowStatus: ["errored","terminated","queued","running","waiting","paused"].includes(workflowStatus) ? workflowStatus : "unknown",
    attempted: 0, successful: 0, failures: codes.map(code => ({ code, reason, failureStage: "UNKNOWN" })) };
}

export class LiveDay extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.state = new ProductionDayState({ sql: ctx.storage.sql, env, transaction: fn => ctx.storage.transactionSync(fn),
      prepare: async date => ({ ...await vault(env).livePrepare(date), transitionReplayVersion: 1 }),
      bundle: (date, prepared, code) => vault(env).liveBundle(date, prepared, code),
      remote: createKisEodPrivateStore({ repository: "klkl789982-droid/tight-budget-private-data", token: env.PRIVATE_LIVE_DELIVERY_WRITE_TOKEN, fetchImpl: edgeFetch }) });
  }
  prepare(date, final) { return this.state.prepare(date, final); }
  recoverySource(date) { return this.state.recoverySource(date); }
  adoptPrepared(date, prepared) { return this.state.adoptPrepared(date, prepared); }
  finish(date,runId=`live-${date}`) {
    if(this.ctx.id.toString()!==this.env.LIVE_DAYS.idFromName(runOf(runId).dayName).toString() || runOf(runId).date!==date) throw new Error("LIVE_CLOUD_DATE_CONFLICT");
    return this.state.refreshPublication(date,runId);
  }
  publicationStatus(date) { return this.state.publicationStatus(date,`live-${date}`); }
  async retryMissing(date) {
    if(this.ctx.id.toString()!==this.env.LIVE_DAYS.idFromName(date).toString())throw new Error("LIVE_CLOUD_DATE_CONFLICT");
    const codes=this.state.claimMissingRetries(date);
    if(!codes.length)return {attempted:0};
    const run=`live-${date}-missing-only`, shard=this.env.LIVE_BATCHES.get(this.env.LIVE_BATCHES.idFromName(run),{locationHint:"apac-ne"});
    let response;
    try { response=await shard.fetch(`https://internal/collect-batch?run=${run}&codes=${codes.join(",")}`,{signal:AbortSignal.timeout(Math.max(1,Math.min(60000,bounds(date).end-Date.now())))}); }
    catch(error){this.state.write("missing-retry-outcome",{status:"FETCH_REJECTED",reason:transportReason(error)});}
    try{
    if(response){
      if(!response.ok)throw new Error("LIVE_CLOUD_RECOVERY_EVIDENCE_INVALID");
      const {records}=await response.json();
      if(!Array.isArray(records) || records.length!==codes.length || !codes.every(code=>records.some(row=>row?.code===code)))throw new Error("LIVE_CLOUD_RECOVERY_EVIDENCE_INVALID");
      records.forEach(observationFailureReasons);
      const failures=records.filter(row=>row.status!=="AVAILABLE").map(row=>({code:row.code,reason:safeCode({code:row.reason})}));
      this.state.write("missing-retry-outcome",{status:"RETURNED",failures});
      const global=failures.find(row=>!isLiveMissingReason(row.reason));if(global)throw new Error(global.reason);
    }
    // A lost shard acknowledgement cannot create another attempt. Use its
    // independently validated, immutable completion records on every refresh.
    return {attempted:codes.length,...this.state.refreshPublication(date,`live-${date}`)};
    }catch(error){
      const reason=safeCode(error);this.state.failure(reason,"BATCH_COLLECTION");
      if(!isLiveMissingReason(reason))try{await this.publishExecution(date,"POLICY_GLOBAL_BLOCKED","ERRORED");}
      catch(reportError){console.error(JSON.stringify({event:"LIVE_CLOUD_POLICY_BLOCK_REPORT_FAILED",reason,recordingCode:safeCode(reportError)}));}
      throw new Error(reason);
    }
  }
  async relay(date) {
    const io = privateRequestBudget(edgeFetch);
    const remote = createKisEodPrivateStore({ repository: "klkl789982-droid/tight-budget-private-data", token: this.env.PRIVATE_LIVE_DELIVERY_WRITE_TOKEN, fetchImpl: io.fetch });
    try { return await this.state.relay(date, remote); }
    catch (e) { if (io.exhausted) throw new Error("LIVE_CLOUD_RELAY_HTTP_BUDGET"); throw e; }
  }
  status() { return { ...this.state.status(), productionEnabled: this.env.LIVE_PRODUCTION_ENABLED === "true", producer: this.env.LIVE_PRODUCER }; }
  incidentStatus() { return { ...this.state.incidentStatus(true), productionEnabled: this.env.LIVE_PRODUCTION_ENABLED === "true", producer: this.env.LIVE_PRODUCER }; }
  failure(code, stage) { return this.state.failure(safeCode({ code }), stage); }
  reconcileBatches(date, value) { return this.state.reconcileBatches(date, value); }
  recordBatchResult(date,runId,codes,result) { return this.state.recordBatchResult(date,runId,codes,result); }
  recoverBatchAcknowledgement(date,runId,codes,reason) {
    if (runOf(runId).date !== date || this.ctx.id.toString() !== this.env.LIVE_DAYS.idFromName(runOf(runId).dayName).toString())
      throw new Error("LIVE_CLOUD_DATE_CONFLICT");
    return this.state.recoverBatchAcknowledgement(date,runId,codes,reason);
  }
  reconcileJournal(date,runId,deadline) { return this.state.reconcileJournal(date,runId,deadline); }
  async watch(date,slot,scheduledAt){
    const io=privateRequestBudget(edgeFetch);
    const remote=createKisEodPrivateStore({repository:"klkl789982-droid/tight-budget-private-data",token:this.env.PRIVATE_LIVE_DELIVERY_WRITE_TOKEN,fetchImpl:io.fetch});
    return runCloudWatchdog({state:this.state,workflow:this.env.LIVE,remote,fetchImpl:io.fetch,date,slot,scheduledAt,
      publishExecution:(...args)=>publishExecutionRecord(this.state,remote,...args),retryMissing:()=>this.retryMissing(date)});
  }
  watchStatus(){const last=this.state.read("watch-latest");return last?this.state.read(`watch-snapshot:${last.slot}`):null;}
  async publishExecution(date,event,workflowState,error) {
    const io=privateRequestBudget(edgeFetch,12);
    const remote=createKisEodPrivateStore({repository:"klkl789982-droid/tight-budget-private-data",token:this.env.PRIVATE_LIVE_DELIVERY_WRITE_TOKEN,fetchImpl:io.fetch});
    return publishExecutionRecord(this.state,remote,date,event,workflowState,error);
  }
  async isolatedFixture(run, phase) {
    assertIsolatedProductionFixture(this.env);
    if (!/^[A-Za-z0-9_-]{1,24}$/u.test(run ?? "") || this.ctx.id.toString() !== this.env.LIVE_DAYS.idFromName(`isolated-fixture-${run}`).toString()) throw new Error("DIAG_PRODUCTION_FIXTURE_IDENTITY");
    const io = privateRequestBudget(edgeFetch);
    const remote = createKisEodPrivateStore({ repository: "klkl789982-droid/tight-budget-private-data", token: this.env.PRIVATE_LIVE_DELIVERY_WRITE_TOKEN, fetchImpl: io.fetch });
    return verifyNativeProductionFixture({ sql: this.ctx.storage.sql, remote, run, phase,probeFetch:io.fetch });
  }
  async fetch(request) {
    try {
      const u = new URL(request.url), run=runOf(u.searchParams.get("run")),date=run.date,ticker=u.searchParams.get("code");
      if(ticker!==null&&!/^[0-9A-Z]{6}$/u.test(ticker))throw new Error("LIVE_CLOUD_CODES_INVALID");
      const code=run.missingOnly?`retry:${ticker}`:ticker;
      if (u.pathname === "/slot-pair-acquire") return Response.json(await this.state.acquire(date, code, { deferMinute: true, acquisitionId: u.searchParams.get("acquisitionId") }));
      if (u.pathname === "/extra-slot") return Response.json(await extraWithReceiptClock(this.state, date, code, u.searchParams.get("kind"), request.method === "POST" ? (await request.json()).skipped : []));
      if (u.pathname === "/slot-pair-complete") return Response.json(await completeWithReceiptClock(this.state, date, code, await request.json()));
      // Tokens may NOT be refreshed inside the market window. The already
      // pinned credential must cover it; an actual401 fails the observation.
      if (["/shared-auth", "/shared-invalidate"].includes(u.pathname)) throw new Error("LIVE_CLOUD_AUTH_INVALIDATED");
      return new Response(null, { status: 404 });
    } catch (e) { return Response.json({ reason: safeCode(e) }, { status: 503 }); }
  }
}

export class LiveBatch extends KisSlotShard {
  acquisitionId() { return crypto.randomUUID(); }
  assertInvocation() { assertProduction(this.env); }
  brokerFor(run) { return day(this.env, runOf(run).dayName); }
  minuteQueryTime(timing) { return kst(Date.parse(timing.quoteRequestedAt)).time; }
  projectPinnedExclusion(args) { return productionPinnedExclusion(args); }
  projectResult(args, retainVerifiedPrice) { return productionObservation(args, retainVerifiedPrice); }
}

export class CloudLive extends WorkflowEntrypoint {
  async run(event, step) {
    const p = event.payload ?? {}, date = p.date;
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(date ?? "")) throw new Error("LIVE_CLOUD_DATE_INVALID");
    const recovery = p.mode === "recovery-day";
    if (recovery && !/^[A-Za-z0-9_-]{1,24}$/u.test(p.attempt ?? "")) throw new Error("LIVE_CLOUD_RECOVERY_ID_INVALID");
    const runId = p.mode === "batch" ? p.runId ?? `live-${date}` : recovery ? `live-${date}-recovery-${p.attempt}` : `live-${date}`;
    const target = day(this.env, p.mode === "batch" ? runOf(runId).dayName : recovery ? `${date}-recovery-${p.attempt}` : date);
    if (p.mode === "status") return step.do("read only production readiness", options, () => target.status());
    if (p.mode === "incident-status") return step.do("bounded score-only incident inventory", options, () => target.incidentStatus());
    if (p.mode === "watch-status") return step.do("read existing rule-based watch record",options,()=>target.watchStatus());
    if (p.mode === "publication-status") return step.do("inspect preserved publication coverage",options,()=>target.publicationStatus(date));
    assertProduction(this.env);
    if(p.mode==="publish-preserved" && (kst(Date.now()).date!==date || Date.now()<bounds(date).start)) throw new Error("LIVE_CLOUD_WINDOW_EXPIRED");
    // Management-only metadata reconciliation; never prepare/collect/finish/relay.
    if(p.mode==="publish-execution-status")return step.do("publish existing execution metadata only",options,async()=>{
      const original=await (await this.env.LIVE.get(`live-${date}`)).status();
      const state=String(original.status??"UNKNOWN").toUpperCase();
      // The durable failure has the original code and stage. A generic
      // Workflow wrapper error must not replace that more specific evidence.
      return target.publishExecution(date,"RECONCILE",["RUNNING","COMPLETE","ERRORED","TERMINATED"].includes(state)?state:"UNKNOWN");
    });
    const emit=async(event,error=null)=>{
      try{return await target.publishExecution(date,event,"RUNNING",error);}
      catch(e){console.error(JSON.stringify({event:"LIVE_CLOUD_STATUS_DELIVERY_FAILED",phase:event,code:safeCode(e)}));return {status:"STATUS_DELIVERY_FAILED"};}
    };
    const report=async(event,error=null)=>{
      try{return await step.do(`private execution metadata ${event}`,{retries:{limit:0,delay:"1 second"},timeout:"30 seconds"},()=>emit(event,error));}
      catch(e){console.error(JSON.stringify({event:"LIVE_CLOUD_STATUS_STEP_FAILED",phase:event,code:safeCode(e)}));return {status:"STATUS_DELIVERY_FAILED"};}
    };
    const retryPartial=async result=>{
      if(result.publication?.status==="PARTIAL" && Date.now()+30000<bounds(date).end)
        await step.do("bounded retry of verified missing symbols",options,()=>target.retryMissing(date));
    };
    let stage = p.mode === "batch" ? "BATCH_COLLECTION" : ["relay","publish-preserved"].includes(p.mode) ? "RELAY" : "PREPARE";
    try {
      if (p.mode === "relay" || p.mode === "publish-preserved") {
        const result=await step.do("retry frozen score-only outbox", options, async () => {
          const stored=await target.status();
          if(!stored.finalInputReady && !stored.outbox) return {status:"WAITING_FOR_BATCHES"};
          if(!stored.outbox || stored.publication?.status==="PARTIAL"){
            const current=await target.finish(date,runId);
            if(current.status==="WITHHELD") return current;
          }
          return target.relay(date);
        });
        if(result.status==="WITHHELD") await report(`POLICY_W${result.coverage.missing.length}`);
        else if(result.status!=="WAITING_FOR_BATCHES") await report(result.publication?`POLICY_R${result.publication.revision}`:"DELIVERED");
        if(p.mode==="relay")await retryPartial(result);
        return result;
      }
      if (p.mode === "batch") {
        if (Date.now() < bounds(date).start) await step.sleepUntil("wait for absolute1400", new Date(bounds(date).start));
        try { const result=await step.do("bounded eight-symbol LIVE invocation", options, async () => {
          assertWindow(date, Date.now());
          if (!Array.isArray(p.codes) || !p.codes.length || p.codes.length > 8) throw new Error("LIVE_CLOUD_CODES_INVALID");
          if (runOf(runId).date !== date) throw new Error("LIVE_CLOUD_DATE_INVALID");
          const shard = this.env.LIVE_BATCHES.get(this.env.LIVE_BATCHES.idFromName(`${runId}-${p.codes[0]}`), { locationHint: "apac-ne" });
          // Start the independent collector before optional metadata I/O. A
          // telemetry outage cannot postpone the first broker request or mask a
          // rejection. Only one precreated batch reports collection progress.
          const collecting=shard.fetch(`https://internal/collect-batch?run=${runId}&codes=${p.codes.join(",")}`, {
            // A recovery window can be much longer than one batch invocation.
            // Keep the request deadline within the already proven five-minute
            // primary-window bound; the day cutoff is still enforced below.
            signal: AbortSignal.timeout(Math.max(1, Math.min(300000, bounds(date).end + 5000 - Date.now()))) }).then(response=>({response}),error=>({error}));
          if(p.reportStatus===true&&runId===`live-${date}`)await emit("COLLECTION");
          const outcome=await collecting;
          if(outcome.error){
            const diagnostic=String(outcome.error?.message??"").slice(0,160).replace(/[A-Za-z0-9+/=_-]{32,}/gu,"[redacted]");
            console.error(JSON.stringify({event:"LIVE_BATCH_FETCH_REJECTED",errorName:String(outcome.error?.name??"Error").slice(0,40),diagnostic}));
            const reason=transportReason(outcome.error);
            if (["DIAG_UNKNOWN_TRANSPORT_FAILURE","DIAG_TRANSPORT_CONNECTION_RESET","DIAG_TRANSPORT_SOCKET","DIAG_TRANSPORT_TIMEOUT"].includes(reason)) {
              try { return await target.recoverBatchAcknowledgement(date,runId,p.codes,reason); }
              catch (error) { console.error(JSON.stringify({event:"LIVE_BATCH_ACK_UNVERIFIED",primaryCode:reason,verificationCode:safeCode(error)})); }
            }
            throw new Error(reason);
          }
          const r=outcome.response;
          if (!r.ok) throw new Error("LIVE_CLOUD_BATCH_FAILED");
          const value = await r.json();
          if (value.records.length !== p.codes.length) throw new Error("LIVE_CLOUD_BATCH_INCOMPLETE");
          const result={ attempted: value.records.length, successful: value.records.filter(r => ["AVAILABLE", "EXCLUDED"].includes(r.status)).length,
            failed: value.records.filter(r => !["AVAILABLE", "EXCLUDED"].includes(r.status)).map(r => ({ code: r.code, reason: safeCode({ code: r.reason }),
              failureStage: ["LEASE_ACQUIRE","LEASED_SETUP","COLLECTION"].includes(r.failureStage) ? r.failureStage : "UNKNOWN" })), sourcePricesIncluded: false };
          if(result.failed.length)try{await target.failure(result.failed[0].reason,"BATCH_COLLECTION");}
          catch(error){console.error(JSON.stringify({event:"LIVE_CLOUD_BATCH_FAILURE_RECORD_FAILED",primaryCode:result.failed[0].reason,recordingCode:safeCode(error)}));}
          return result;
        });
          if (!result.recoveredFetchError) await step.do("persist immutable batch outcome",options,()=>target.recordBatchResult(date,runId,p.codes,{status:"complete",output:result}));
          return result;
        } catch (error) {
          const diagnostic=String(error?.message??"").slice(0,160).replace(/[A-Za-z0-9+/=_-]{32,}/gu,"[redacted]");
          console.error(JSON.stringify({event:"LIVE_BATCH_STEP_REJECTED",errorName:String(error?.name??"Error").slice(0,40),diagnostic}));
          throw error;
        }
      }
      let prepared = null, lastInputFailure = null;
      if (recovery) {
        prepared = await step.do("adopt immutable pre-1400 input", options, async () => {
          const source = await day(this.env, date).recoverySource(date);
          return target.adoptPrepared(date, source);
        });
      } else {
        if (p.mode !== "day") throw new Error("LIVE_CLOUD_MODE_INVALID");
        const initial=await step.do("1340 preparation no market prices", options, async () => {
          try { return { prepared: await target.prepare(date, false) }; } catch (e) { return { reason: safeCode(e) }; }
        });
        await report("PREPARATION",initial.reason?{code:initial.reason,stage:"PREPARE"}:null);
        stage = "FINAL_INPUT";
        await step.sleepUntil("1359 fresh EOD recheck", new Date(bounds(date).start - 60000));
        for (let i = 0; i < 6 && !prepared; i++) {
          const attempt = await step.do(`fresh input attempt${i}`, options, async () => {
            try { return { prepared: await target.prepare(date, true) }; } catch (e) { return { reason: safeCode(e) }; }
          });
          prepared = attempt.prepared;
          lastInputFailure = attempt.reason ?? lastInputFailure;
          if (!prepared && i < 5) await step.sleep(`bounded input backoff${i}`, "10 seconds");
        }
      }
      if (!prepared) throw new Error(lastInputFailure ?? "LIVE_CLOUD_INPUT_NOT_READY");
      // Fixed child IDs are created BEFORE the quote window. The scheduled
      // parent may start at13:40:58; it never waits for a14:00 cron invocation.
      stage = "CREATE_BATCHES";
      const definitions = [];
      const batchSize=prepared.batchSize??8;
      if(![4,8].includes(batchSize))throw new Error("LIVE_CLOUD_CODES_INVALID");
      for (let i = 0; i < prepared.codes.length; i += batchSize) definitions.push({ id: `${runId}-batch${i / batchSize}`,
        params: { mode: "batch", date, runId, codes: prepared.codes.slice(i, i + batchSize), ...(i===0&&!recovery?{reportStatus:true}:{}) } });
      for(let offset=0;offset<definitions.length;offset+=50){
        if(offset)await step.sleep(`pace fixed batch creation ${offset/50}`,"2 seconds");
        const group=definitions.slice(offset,offset+50);
        await step.do(`precreate fixed batch ids ${offset/50}`,
          {...options,retries:{limit:2,delay:"5 seconds",backoff:"exponential"}},
          ()=>createFixedBatchGroup(this.env.LIVE,group));
      }
      // All collectors are already precreated; this read/write does not hold
      // their broker slots or delay their absolute14:00 wake-up.
      if (!recovery) await report("READY");
      stage = "BATCH_COLLECTION";
      let journal=null;
      // At most19 bounded SQL-backed progress checks, never SQL polling or
      // 70+ Workflow control API calls. Complete runs can publish at14:06;
      // unfinished collectors retain their real timestamps until15:30.
      for(let checkpoint=0;checkpoint<19;checkpoint++){
        const at=Math.min(bounds(date).start+(6+checkpoint*5)*60000,bounds(date).end+1000);
        if(Date.now()<at)await step.sleepUntil(`bounded completion checkpoint ${checkpoint}`,new Date(at));
        journal=await step.do(`read durable batch completion ${checkpoint}`,options,()=>target.reconcileJournal(date,runId,Date.now()>bounds(date).end));
        if(journal.ready)break;
      }
      if(!journal?.ready)throw new Error("LIVE_CLOUD_CHILD_RESULT_MISSING");
      const firstFailure=journal.firstFailure;
      if(firstFailure)try{await step.do("preserve first child failure",options,()=>target.failure(firstFailure.reason,"BATCH_COLLECTION"));}
      catch(error){console.error(JSON.stringify({event:"LIVE_CLOUD_FAILURE_RECORD_FAILED",primaryCode:firstFailure.reason,stage:"BATCH_COLLECTION",recordingCode:safeCode(error)}));}
      if(firstFailure&&!isLiveMissingReason(firstFailure.reason))throw new Error(firstFailure.reason);
      stage = "FINALIZE";
      const frozen=await step.do("validate all required inputs and freeze outbox", options, () => target.finish(date,runId));
      if(frozen?.status==="WITHHELD"){
        if(!recovery) await report(`POLICY_W${frozen.coverage.missing.length}`);
        return frozen;
      }
      if (!recovery) await report("VALIDATED");
      stage = "RELAY";
      const result=await step.do("publish private score-only delivery", options, () => target.relay(date));
      if (!recovery) {await report(result.publication?`POLICY_R${result.publication.revision}`:"DELIVERED");await retryPartial(result);}return result;
    } catch (e) {
      const primaryCode = p.mode==="batch"?transportReason(e):safeCode(e);
      if(p.mode==="batch")try{
        await step.do("persist failed batch outcome",options,()=>target.recordBatchResult(date,runId,p.codes,{status:"errored",reason:primaryCode}));
      }catch(recordError){console.error(JSON.stringify({event:"LIVE_CLOUD_BATCH_JOURNAL_FAILED",primaryCode,recordingCode:safeCode(recordError)}));}
      try { await step.do("record fixed failure code", options, () => target.failure(primaryCode, stage)); }
      catch (recordError) { console.error(JSON.stringify({ event: "LIVE_CLOUD_FAILURE_RECORD_FAILED", primaryCode, stage, recordingCode: safeCode(recordError) })); }
      // Batch failures remain in per-symbol/day evidence. Do not fan out70
      // telemetry writes; the day/three relay parents publish bounded failures.
      if(p.mode!=="batch"&&!recovery)await report(p.mode==="relay"&&["06","08","10","31","33","35"].includes(p.relaySlot)?`FAILURE_RELAY${p.relaySlot}`:"FAILURE_DAY",{code:primaryCode,stage});
      throw new Error(primaryCode);
    }
  }
}

export async function productionScheduled(event, env) {
  if (env.LIVE_PRODUCTION_ENABLED !== "true") return { status: "DISABLED" };
  assertProduction(env);
  const t = kst(event.scheduledTime), weekday = new Date(`${t.date}T00:00:00Z`).getUTCDay();
  if ([0, 6].includes(weekday)) return { status: "WEEKEND" };
  if(String(event.cron??"").trim().replace(/\s+/gu," ").toUpperCase()===WATCH_CRON){const slot=watchSlot(t.time);if(!WATCH_SLOTS.includes(slot))return{status:"WATCH_UNUSED_MINUTE"};
    return day(env,t.date).watch(t.date,slot,event.scheduledTime);
  }
  const mode = t.time < "14:00:00" ? "day" : "relay", id = mode === "day" ? `live-${t.date}` : `live-${t.date}-relay${t.time.slice(3, 5)}`;
  try { await env.LIVE.create({ id, params: { mode, date: t.date, ...(mode==="relay"?{relaySlot:t.time.slice(3,5)}:{}) } }); }
  catch { const existing = await env.LIVE.get(id); await existing.status(); }
  return { id, mode };
}
