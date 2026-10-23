import { DurableObject, WorkflowEntrypoint } from "cloudflare:workers";
import { KisSlotShard } from "./slot-shard.mjs";
import { ProductionDayState } from "../production-state.mjs";
import { assertProduction, assertWindow, bounds, kst, productionObservation } from "../production-core.mjs";
import { safeCode, edgeFetch } from "../core.mjs";
import { createKisEodPrivateStore } from "../../../lib/kis-eod-private-store.mjs";
import { privateRequestBudget } from "../relay-budget.mjs";
import { verifyNativeProductionFixture } from "../production-fixture.mjs";
import { executionRecordKey } from "../../../lib/private-live-execution-status.mjs";
const options = { retries: { limit: 0, delay: "1 second" }, timeout: "6 minutes" };
const runOf = run => { const m = /^live-(\d{4}-\d{2}-\d{2})(?:-(recovery-[A-Za-z0-9_-]{1,24}))?$/u.exec(run ?? ""); if (!m) throw new Error("LIVE_CLOUD_DATE_INVALID"); return { date: m[1], dayName: m[2] ? `${m[1]}-${m[2]}` : m[1] }; };
const dateOf = run => runOf(run).date;
const vault = env => env.BROKER.get(env.BROKER.idFromName("single-approved-kis-credential-v1"));
const day = (env, name) => env.LIVE_DAYS.get(env.LIVE_DAYS.idFromName(name), { locationHint: "apac-ne" });
export function assertIsolatedProductionFixture(env, now = Date.now()) {
  assertProduction(env);
  if (env.LIVE_ENABLED !== "false" || env.DIAGNOSTIC_ONLY !== "true") throw new Error("DIAG_PRODUCTION_FIXTURE_DISABLED");
  const t = kst(now), weekday = new Date(`${t.date}T00:00:00Z`).getUTCDay();
  if (weekday > 0 && weekday < 6 && t.time >= "13:35:00" && t.time <= "14:10:00") throw new Error("DIAG_PRODUCTION_FIXTURE_WINDOW_EXCLUDED");
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
      prepare: date => vault(env).livePrepare(date), bundle: (date, prepared, code) => vault(env).liveBundle(date, prepared, code),
      remote: createKisEodPrivateStore({ repository: "klkl789982-droid/tight-budget-private-data", token: env.PRIVATE_LIVE_DELIVERY_WRITE_TOKEN, fetchImpl: edgeFetch }) });
  }
  prepare(date, final) { return this.state.prepare(date, final); }
  recoverySource(date) { return this.state.recoverySource(date); }
  adoptPrepared(date, prepared) { return this.state.adoptPrepared(date, prepared); }
  finish(date) { this.state.finish(date); return { status: "OUTBOX_FROZEN" }; }
  async relay(date) {
    const io = privateRequestBudget(edgeFetch);
    const remote = createKisEodPrivateStore({ repository: "klkl789982-droid/tight-budget-private-data", token: this.env.PRIVATE_LIVE_DELIVERY_WRITE_TOKEN, fetchImpl: io.fetch });
    try { return await this.state.relay(date, remote); }
    catch (e) { if (io.exhausted) throw new Error("LIVE_CLOUD_RELAY_HTTP_BUDGET"); throw e; }
  }
  status() { return { ...this.state.status(), productionEnabled: this.env.LIVE_PRODUCTION_ENABLED === "true", producer: this.env.LIVE_PRODUCER }; }
  incidentStatus() { return { ...this.state.incidentStatus(), productionEnabled: this.env.LIVE_PRODUCTION_ENABLED === "true", producer: this.env.LIVE_PRODUCER }; }
  failure(code, stage) { return this.state.failure(safeCode({ code }), stage); }
  reconcileBatches(date, value) { return this.state.reconcileBatches(date, value); }
  async publishExecution(date,event,workflowState,error) {
    const record=this.state.freezeExecution(date,event,workflowState,error);
    const io=privateRequestBudget(edgeFetch,12);
    const remote=createKisEodPrivateStore({repository:"klkl789982-droid/tight-budget-private-data",token:this.env.PRIVATE_LIVE_DELIVERY_WRITE_TOKEN,fetchImpl:io.fetch});
    await remote.writeImmutable(executionRecordKey(record),record);
    return {status:"EXECUTION_METADATA_STORED",signalDate:date,recordHash:record.recordHash};
  }
  async isolatedFixture(run, phase) {
    assertIsolatedProductionFixture(this.env);
    if (!/^[A-Za-z0-9_-]{1,24}$/u.test(run ?? "") || this.ctx.id.toString() !== this.env.LIVE_DAYS.idFromName(`isolated-fixture-${run}`).toString()) throw new Error("DIAG_PRODUCTION_FIXTURE_IDENTITY");
    const io = privateRequestBudget(edgeFetch);
    const remote = createKisEodPrivateStore({ repository: "klkl789982-droid/tight-budget-private-data", token: this.env.PRIVATE_LIVE_DELIVERY_WRITE_TOKEN, fetchImpl: io.fetch });
    return verifyNativeProductionFixture({ sql: this.ctx.storage.sql, remote, run, phase });
  }
  async fetch(request) {
    try {
      const u = new URL(request.url), date = dateOf(u.searchParams.get("run")), code = u.searchParams.get("code");
      if (u.pathname === "/slot-pair-acquire") return Response.json(await this.state.acquire(date, code));
      if (u.pathname === "/extra-slot") return Response.json(this.state.extra(date, code, u.searchParams.get("kind")));
      if (u.pathname === "/slot-pair-complete") return Response.json(this.state.complete(date, code, await request.json()));
      // Tokens may NOT be refreshed inside the market window. The already
      // pinned credential must cover it; an actual401 fails the observation.
      if (["/shared-auth", "/shared-invalidate"].includes(u.pathname)) throw new Error("LIVE_CLOUD_AUTH_INVALIDATED");
      return new Response(null, { status: 404 });
    } catch (e) { return Response.json({ reason: safeCode(e) }, { status: 503 }); }
  }
}

export class LiveBatch extends KisSlotShard {
  assertInvocation() { assertProduction(this.env); }
  brokerFor(run) { return day(this.env, runOf(run).dayName); }
  minuteQueryTime(timing) { return kst(Date.parse(timing.quoteRequestedAt)).time; }
  projectResult(args) { return productionObservation(args); }
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
    assertProduction(this.env);
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
    let stage = p.mode === "batch" ? "BATCH_COLLECTION" : p.mode === "relay" ? "RELAY" : "PREPARE";
    try {
      if (p.mode === "relay") { const result=await step.do("retry frozen score-only outbox", options, async () => { await target.finish(date); return target.relay(date); });await report("DELIVERED");return result; }
      if (p.mode === "batch") {
        await step.sleepUntil("wait for absolute1400", new Date(bounds(date).start));
        return await step.do("bounded eight-symbol LIVE invocation", options, async () => {
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
          if(p.reportStatus===true)await emit("COLLECTION");
          const outcome=await collecting;
          if(outcome.error){
            const diagnostic=String(outcome.error?.message??"").slice(0,160).replace(/[A-Za-z0-9+/=_-]{32,}/gu,"[redacted]");
            console.error(JSON.stringify({event:"LIVE_BATCH_FETCH_REJECTED",errorName:String(outcome.error?.name??"Error").slice(0,40),diagnostic}));
            throw outcome.error;
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
      }
      let prepared = null;
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
          if (!prepared && i < 5) await step.sleep(`bounded input backoff${i}`, "10 seconds");
        }
      }
      if (!prepared) throw new Error("LIVE_CLOUD_INPUT_NOT_READY");
      // Fixed child IDs are created BEFORE the quote window. The scheduled
      // parent may start at13:40:58; it never waits for a14:00 cron invocation.
      stage = "CREATE_BATCHES";
      const definitions = [];
      for (let i = 0; i < prepared.codes.length; i += 8) definitions.push({ id: `${runId}-batch${i / 8}`,
        params: { mode: "batch", date, runId, codes: prepared.codes.slice(i, i + 8), ...(i===0?{reportStatus:true}:{}) } });
      await step.do("precreate fixed batch ids", options, async () => {
        try { await this.env.LIVE.createBatch(definitions); }
        catch {
          // Never create replacement IDs after an unknown create response.
          // Recovery uses the same immutable IDs, not another observation.
          for (const d of definitions) { const prior = await this.env.LIVE.get(d.id); await prior.status(); }
        }
        return { batches: definitions.length, symbols: prepared.codes.length };
      });
      // All collectors are already precreated; this read/write does not hold
      // their broker slots or delay their absolute14:00 wake-up.
      if (!recovery) await report("READY");
      await step.sleepUntil("finalize after absolute collection cutoff", new Date(bounds(date).end + 1000));
      stage = "BATCH_COLLECTION";
      const batches=[];
      // Workflow status RPCs are split into bounded groups. A COMPLETE child
      // is not success unless its output accounts for every assigned symbol.
      for(let offset=0;offset<definitions.length;offset+=24){
        const group=definitions.slice(offset,offset+24);
        const values=await step.do(`reconcile child outputs ${offset/24}`,options,()=>Promise.all(group.map(async definition=>{
          try{return batchResult(definition,await (await this.env.LIVE.get(definition.id)).status());}
          catch(error){return batchResult(definition,{status:"unknown",error});}
        })));
        batches.push(...values);
      }
      const firstFailure=batches.flatMap(batch=>batch.failures.map(row=>({...row,batchId:batch.id})))[0]??null;
      if(firstFailure)try{await step.do("preserve first child failure",options,()=>target.failure(firstFailure.reason,"BATCH_COLLECTION"));}
      catch(error){console.error(JSON.stringify({event:"LIVE_CLOUD_FAILURE_RECORD_FAILED",primaryCode:firstFailure.reason,stage:"BATCH_COLLECTION",recordingCode:safeCode(error)}));}
      await step.do("persist child reconciliation",options,()=>target.reconcileBatches(date,{schemaVersion:1,date,runId,batches,firstFailure}));
      if(firstFailure)throw new Error(firstFailure.reason);
      stage = "FINALIZE";
      await step.do("validate all required inputs and freeze outbox", options, () => target.finish(date));
      if (!recovery) await report("VALIDATED");
      stage = "RELAY";
      const result=await step.do("publish private score-only delivery", options, () => target.relay(date));
      if (!recovery) await report("DELIVERED");return result;
    } catch (e) {
      const primaryCode = safeCode(e);
      try { await step.do("record fixed failure code", options, () => target.failure(primaryCode, stage)); }
      catch (recordError) { console.error(JSON.stringify({ event: "LIVE_CLOUD_FAILURE_RECORD_FAILED", primaryCode, stage, recordingCode: safeCode(recordError) })); }
      // Batch failures remain in per-symbol/day evidence. Do not fan out70
      // telemetry writes; the day/three relay parents publish bounded failures.
      if(p.mode!=="batch"&&!recovery)await report(p.mode==="relay"&&["06","08","10"].includes(p.relaySlot)?`FAILURE_RELAY${p.relaySlot}`:"FAILURE_DAY",{code:primaryCode,stage});
      throw new Error(primaryCode);
    }
  }
}

export async function productionScheduled(event, env) {
  if (env.LIVE_PRODUCTION_ENABLED !== "true") return { status: "DISABLED" };
  assertProduction(env);
  const t = kst(event.scheduledTime), weekday = new Date(`${t.date}T00:00:00Z`).getUTCDay();
  if ([0, 6].includes(weekday)) return { status: "WEEKEND" };
  const mode = t.time < "14:00:00" ? "day" : "relay", id = mode === "day" ? `live-${t.date}` : `live-${t.date}-relay${t.time.slice(3, 5)}`;
  try { await env.LIVE.create({ id, params: { mode, date: t.date, ...(mode==="relay"?{relaySlot:t.time.slice(3,5)}:{}) } }); }
  catch { const existing = await env.LIVE.get(id); await existing.status(); }
  return { id, mode };
}
