import { canonicalContentHash as hash } from "./canonical-content-hash.mjs";
import { createKisEodPrivateStore } from "./kis-eod-private-store.mjs";
import { PRIVATE_LIVE_PROFILE } from "./private-live-top-contract.mjs";

// Metadata only, separate from immutable result/outbox/latest and outcome data.
export const EXECUTION_PREFIX = "cloud-live-execution-status-v1";
export const EXECUTION_EVENTS = Object.freeze(["PREPARATION", "READY", "COLLECTION", "VALIDATED", "DELIVERED", "FAILURE_DAY", "FAILURE_RELAY06", "FAILURE_RELAY08", "FAILURE_RELAY10", "FAILURE_RELAY31", "FAILURE_RELAY33", "FAILURE_RELAY35", "RECONCILE"]);
const iso = x => typeof x === "string" && Number.isFinite(Date.parse(x)) && new Date(x).toISOString() === x;
const date = x => typeof x === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(x) && Number.isFinite(Date.parse(`${x}T00:00:00Z`)) && new Date(`${x}T00:00:00Z`).toISOString().slice(0,10) === x;
const exact = (x, fields) => x && typeof x === "object" && !Array.isArray(x) && Object.keys(x).sort().join() === [...fields].sort().join();
const digest = x => typeof x === "string" && /^[a-f0-9]{64}$/u.test(x);
const invalid = () => { throw new Error("LIVE_CLOUD_EXECUTION_STATUS_INVALID"); };
const timestamp = (x, now) => x === null || iso(x) && x <= now;
export const executionRecordKey = value => `${EXECUTION_PREFIX}/${value.signalDate}/${Date.parse(value.recordedAt)}-${value.event.toLowerCase()}-${value.recordHash}.json`;

export function sealExecutionRecord(body) { const result = { ...body, recordHash: hash(body) }; validateExecutionRecord(result, body.recordedAt); return result; }
export function validateExecutionRecord(v, now = new Date().toISOString()) {
  if (!iso(now) || !exact(v,["schemaVersion","namespace","source","signalDate","runId","recordedAt","event","workflowState","error","input","collection","validation","delivery","recordHash"])
    || v.schemaVersion !== 1 || v.namespace !== EXECUTION_PREFIX || v.source !== "CLOUDFLARE_DURABLE_STATE" || !date(v.signalDate)
    || v.runId !== `live-${v.signalDate}` || !iso(v.recordedAt) || v.recordedAt > now || !EXECUTION_EVENTS.includes(v.event)
    || !["UNKNOWN","RUNNING","COMPLETE","ERRORED","TERMINATED"].includes(v.workflowState)) invalid();
  if (v.error !== null && (!exact(v.error,["code","stage"]) || !/^(?:KIS|PRIVATE_STORE|DIAG|LIVE_CLOUD)_[A-Z0-9_]{1,100}$/u.test(v.error.code)
    || !["PREPARE","FINAL_INPUT","CREATE_BATCHES","BATCH_COLLECTION","FINALIZE","RELAY","UNKNOWN"].includes(v.error.stage))) invalid();
  const i=v.input,c=v.collection,a=v.validation,d=v.delivery;
  if (!exact(i,["initialReady","finalReady","seedReferenceDate","checkedAt","initialReadyAt","finalReadyAt"])
    || typeof i.initialReady !== "boolean" || typeof i.finalReady !== "boolean" || i.seedReferenceDate !== null && (!date(i.seedReferenceDate) || i.seedReferenceDate >= v.signalDate)
    || ![i.checkedAt,i.initialReadyAt,i.finalReadyAt].every(t=>timestamp(t,now))
    || i.finalReady && (!i.seedReferenceDate || !i.checkedAt || !i.finalReadyAt)) invalid();
  if (!exact(c,["expected","eligible","available","excluded","failed","missing","requiredMissing","activeLeases","firstRequestedAt","lastReceivedAt"])
    || c.expected !== 553 || ![c.available,c.excluded,c.failed,c.missing].every(n=>Number.isSafeInteger(n)&&n>=0&&n<=553)
    || c.available+c.excluded+c.failed+c.missing !== 553
    || c.eligible !== null && (!Number.isSafeInteger(c.eligible)||c.eligible<0||c.eligible>553)
    || c.requiredMissing !== null && (!Number.isSafeInteger(c.requiredMissing)||c.requiredMissing<0||c.requiredMissing>(c.eligible??553))
    || !Number.isSafeInteger(c.activeLeases)||c.activeLeases<0||c.activeLeases>8
    || ![c.firstRequestedAt,c.lastReceivedAt].every(t=>timestamp(t,now))) invalid();
  if (!exact(a,["outboxFrozen","deliveryHash","frozenAt"]) || !exact(d,["verified","deliveryHash"])
    || typeof a.outboxFrozen !== "boolean" || typeof d.verified !== "boolean" || !timestamp(a.frozenAt,now)
    || a.deliveryHash !== null && !digest(a.deliveryHash) || d.deliveryHash !== null && !digest(d.deliveryHash)
    || a.outboxFrozen && (!a.deliveryHash||!a.frozenAt||!i.finalReady||c.missing!==0||c.requiredMissing!==0)
    || d.verified && (!a.outboxFrozen||d.deliveryHash!==a.deliveryHash)) invalid();
  const {recordHash,...body}=v;if(!digest(recordHash)||hash(body)!==recordHash)invalid();
  return v;
}

export function executionStatusDto(record, now = new Date().toISOString()) {
  validateExecutionRecord(record,now);
  const start=Date.parse(`${record.signalDate}T${PRIVATE_LIVE_PROFILE.signalTime}+09:00`),
    end=Date.parse(`${record.signalDate}T${PRIVATE_LIVE_PROFILE.windowEnd}+09:00`),ms=Date.parse(now),c=record.collection;
  const terminal=["ERRORED","TERMINATED"].includes(record.workflowState)||record.event.startsWith("FAILURE_");
  const full=c.missing===0&&c.requiredMissing===0&&record.input.finalReady;
  const observedAfterWindow=Date.parse(record.recordedAt)>end;
  const inputBlocked=!record.input.finalReady&&(terminal||Date.parse(record.recordedAt)>=start);
  const preparationFailed=["PREPARE","FINAL_INPUT"].includes(record.error?.stage)&&record.error?.code!=="LIVE_CLOUD_INPUT_NOT_READY";
  const collection=record.validation.outboxFrozen||full?"SUCCEEDED":inputBlocked?"BLOCKED":terminal||observedAfterWindow?"FAILED"
    :ms>end?"UNKNOWN":ms>=start&&(c.available+c.excluded+c.failed+c.activeLeases)>0?"RUNNING":"PENDING";
  const validation=record.validation.outboxFrozen?"SUCCEEDED":inputBlocked||collection==="FAILED"?"BLOCKED":record.error?.stage==="FINALIZE"?"FAILED":terminal||ms>end?"UNKNOWN":"PENDING";
  const delivery=record.delivery.verified?"SUCCEEDED":record.error?.stage==="RELAY"&&record.validation.outboxFrozen?"FAILED":["BLOCKED","FAILED","UNKNOWN"].includes(validation)?"BLOCKED":ms>end+6*60000?"UNKNOWN":"PENDING";
  return { ...record, status:record.delivery.verified?"SUCCEEDED":preparationFailed?"FAILED":inputBlocked?"BLOCKED":terminal||[collection,validation,delivery].includes("FAILED")?"FAILED":[collection,validation,delivery].includes("UNKNOWN")?"STALE":"IN_PROGRESS",
    stages:{preparation:record.input.finalReady?"SUCCEEDED":preparationFailed?"FAILED":inputBlocked?"BLOCKED":"PENDING",collection,validation,delivery},
    collectionComplete:full, observedAt:record.recordedAt, servedAt:now, sourcePricesIncluded:false };
}

// Fixed current KST date only; no arbitrary remote path or historical fallback.
export async function readTodayExecution(store,{now=new Date().toISOString()}={}) {
  if(!iso(now))invalid();
  const today=new Date(Date.parse(now)+9*3600000).toISOString().slice(0,10);
  await store.verifyPrivateRepository();
  const entries=await store.listKeys(`${EXECUTION_PREFIX}/${today}`);
  if(entries.length>EXECUTION_EVENTS.length)invalid();
  const candidates=entries.map(e=>{
    const m=/^(\d{13})-([a-z0-9_]+)-([a-f0-9]{64})\.json$/u.exec(e.name??"");
    if(e.type!=="file"||!m||!EXECUTION_EVENTS.includes(m[2].toUpperCase())||Number(m[1])>Date.parse(now))invalid();
    return {name:e.name,at:Number(m[1]),event:m[2].toUpperCase(),hash:m[3]};
  });
  // Older deployed recovery batches could append COLLECTION under the regular
  // run's directory. A later progress snapshot is not evidence that a finished
  // regular run resumed. Prefer existing terminal evidence without mutating it
  // or performing extra remote reads. Within each class preserve recency.
  const terminal = event => event.startsWith("FAILURE_") || ["DELIVERED","RECONCILE"].includes(event);
  candidates.sort((a,b)=>Number(terminal(b.event))-Number(terminal(a.event))||b.at-a.at||EXECUTION_EVENTS.indexOf(b.event)-EXECUTION_EVENTS.indexOf(a.event));
  if(!candidates.length)return {status:"NO_EXECUTION_RECORD",targetDate:today,servedAt:now,record:null};
  const last=candidates[0],value=(await store.read(`${EXECUTION_PREFIX}/${today}/${last.name}`))?.value;
  validateExecutionRecord(value,now);
  if(value.signalDate!==today||value.recordHash!==last.hash||value.event!==last.event||Date.parse(value.recordedAt)!==last.at)invalid();
  return {status:"AVAILABLE",targetDate:today,servedAt:now,record:executionStatusDto(value,now)};
}

export async function privateLiveExecutionResponse(request,{env=process.env,fetchImpl=fetch,now=new Date().toISOString()}={}) {
  const respond=(status,body)=>Response.json(body,{status,headers:{"Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff"}});
  if(env.PRIVATE_LIVE_DELIVERY_READ_ENABLED!=="true")return respond(404,{error:"NOT_FOUND"});
  if(request.method!=="GET"||new URL(request.url).search)return respond(400,{error:"INVALID_QUERY"});
  // Preview fixture settings never get interpreted as real operational status.
  if(env.PRIVATE_LIVE_DELIVERY_FIXTURE_ID)return respond(200,{status:"NO_EXECUTION_RECORD",targetDate:new Date(Date.parse(now)+32400000).toISOString().slice(0,10),servedAt:now,record:null});
  try {
    let calls=0;
    const limitedFetch=(...args)=>{if(++calls>8)throw new Error("LIVE_CLOUD_EXECUTION_READ_BUDGET");return fetchImpl(...args);};
    const store=createKisEodPrivateStore({repository:env.PRIVATE_LIVE_DELIVERY_REPOSITORY,token:env.PRIVATE_LIVE_DELIVERY_READ_TOKEN,fetchImpl:limitedFetch});
    return respond(200,await readTodayExecution(store,{now}));
  } catch {return respond(503,{error:"PRIVATE_LIVE_EXECUTION_UNAVAILABLE"});}
}
