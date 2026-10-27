import {assertProduction,bounds,kst} from "./production-core.mjs";
import {safeCode} from "./core.mjs";
import {readLatestPrivateLive} from "../../lib/private-live-delivery.mjs";
import {canonicalContentHash as hash} from "../../lib/canonical-content-hash.mjs";

export const WATCH_PREFIX="cloud-live-watchdog-v1";
export const WATCH_SLOTS=Object.freeze(["1340","1345","1359","1400","1405","1415","1430","1445","1500","1515","1525","1535"]);
export function watchSlot(time){return time.slice(0,5).replace(":","");}
const missing=e=>Number(e?.code)===10400||/instance.*(?:not found|does not exist)/iu.test(String(e?.message??""));
const recordKey=r=>`${WATCH_PREFIX}/${r.date}/${r.slot}-${r.recordHash}.json`;

// No collection endpoint, token refresh, arbitrary URL, new observation ID or
// code deployment is exposed here. This is a finite rule-based supervisor.
export async function runCloudWatchdog({state,workflow,remote,fetchImpl,date,slot,scheduledAt,now=Date.now(),publishExecution=async()=>{}}){
  assertProduction(state.env);
  const at=Date.parse(`${date}T${slot?.slice(0,2)}:${slot?.slice(2)}:00+09:00`),b=bounds(date);
  if(!WATCH_SLOTS.includes(slot)||!Number.isFinite(at)||scheduledAt!==at||kst(now).date!==date||now<at||now>at+120000||[0,6].includes(new Date(`${date}T00:00:00Z`).getUTCDay()))return{status:"WATCH_SKIPPED_TIME",collectionStarted:false};
  state.check(date);
  const frozen=state.read(`watch-snapshot:${slot}`);
  if(frozen){if(!state.read(`watch-published:${slot}`)){await remote.writeImmutable(recordKey(frozen),frozen);state.write(`watch-published:${slot}`,{recordHash:frozen.recordHash});}return frozen;}
  if(state.read(`watch-claimed:${slot}`))return{status:"WATCH_ALREADY_CLAIMED",collectionStarted:false};
  state.write(`watch-claimed:${slot}`,{at:new Date(now).toISOString()});
  const actions=[],problems=[];
  const attempt=async(stage,fn,fallback=null)=>{try{return await fn();}catch(e){problems.push({stage,code:safeCode(e)});return fallback;}};
  // Retry at most one already frozen pending diagnostic, not a growing scan.
  const last=state.read("watch-latest");
  if(last&&!state.read(`watch-published:${last.slot}`))await attempt("PREVIOUS_AUDIT_DELIVERY",async()=>{const r=state.read(`watch-snapshot:${last.slot}`);if(r){await remote.writeImmutable(recordKey(r),r);state.write(`watch-published:${last.slot}`,{recordHash:r.recordHash});}});
  let workflowState=await attempt("WORKFLOW_LOOKUP",async()=>{
    try{return String((await(await workflow.get(`live-${date}`)).status()).status??"UNKNOWN").toUpperCase();}
    catch(e){if(missing(e))return"MISSING";throw e;}
  },"UNKNOWN");
  // Existing13:40/13:50 triggers are preserved. A missed13:40 trigger may be
  // repaired once at13:45 with the SAME canonical ID, still before final input.
  if(workflowState==="MISSING"&&slot==="1345"&&!state.read("watch-bootstrap"))await attempt("BOOTSTRAP",async()=>{
    state.write("watch-bootstrap",{runId:`live-${date}`,at:new Date(now).toISOString()});
    try{await workflow.create({id:`live-${date}`,params:{mode:"day",date}});}catch(e){if(Number(e?.code)!==10405&&!/already exists/iu.test(String(e?.message??"")))throw e;}
    actions.push("ENSURE_CANONICAL_DAY_ONLY");workflowState="QUEUED";
  });
  let status=state.status();
  if(status.finalInputReady&&!status.outbox&&now>=b.start)await attempt("FINALIZE_EXISTING_OBSERVATIONS",async()=>{
    const journal=state.reconcileJournal(date,`live-${date}`,now>b.end);
    if(journal.ready&&!journal.firstFailure){state.finish(date);actions.push("FREEZE_ALREADY_VALID_COMPLETE_RESULT");}
  });
  status=state.status();
  // Two extra score-only recovery slots, not another market run. Counts are
  // prepaid durably and independent of the early/closing scheduled counters.
  if(status.outbox&&!status.receipt&&["1415","1515"].includes(slot))await attempt("FROZEN_RELAY",async()=>{await state.relay(date,remote,{watchdog:true,watchSlot:slot});actions.push("RETRY_SAME_FROZEN_DELIVERY");});
  status=state.status();
  let privateReadback={status:"NO_VERIFIED_DELIVERY",date:null,deliveryHash:null,topRows:0};
  if(status.outbox&&status.receipt)await attempt("PRIVATE_READBACK",async()=>{
    const value=await readLatestPrivateLive(remote,{now:new Date(now).toISOString()}),f=state.read("outbox");
    const topRows=value?.models.reduce((n,m)=>n+m.records.length,0)??0;
    const ok=value?.signalDate===date&&value.deliveryHash===f.delivery.deliveryHash&&status.receipt.status==="PRIVATE_RELAY_VERIFIED"&&status.receipt.deliveryHash===value.deliveryHash&&topRows===20;
    privateReadback={status:ok?"VERIFIED":"STALE_OR_HASH_MISMATCH",date:value?.signalDate??null,deliveryHash:value?.deliveryHash??null,topRows};
  });
  const site={loginHttp:null,anonymousApiHttp:null,authenticatedUi:"NOT_CHECKED_NO_ADMIN_SESSION"};
  if(["1400","1415","1525","1535"].includes(slot))await attempt("SITE_ACCESS_BOUNDARY",async()=>{
    // No admin cookie/token is copied into the Worker. These are deliberately
    // anonymous probes, NEVER proof of authenticated rendering or API content.
    const login=await fetchImpl("https://stock-research-chi.vercel.app/login",{method:"GET",redirect:"manual",signal:AbortSignal.timeout(10000)});site.loginHttp=login.status;await login.body?.cancel();
    const api=await fetchImpl("https://stock-research-chi.vercel.app/api/private-live-delivery",{method:"GET",redirect:"manual",signal:AbortSignal.timeout(10000)});site.anonymousApiHttp=api.status;await api.body?.cancel();
    if(login.status!==200||api.status!==401)problems.push({stage:"SITE_ACCESS_BOUNDARY",code:"LIVE_CLOUD_WATCH_SITE_UNVERIFIED"});
  });
  if(["1525","1535"].includes(slot))await attempt("EXECUTION_METADATA",()=>publishExecution(date,"RECONCILE",["RUNNING","COMPLETE","ERRORED","TERMINATED"].includes(workflowState)?workflowState:"UNKNOWN",
    workflowState==="MISSING"?{code:"LIVE_CLOUD_REGULAR_WORKFLOW_MISSING",stage:"PREPARE"}:undefined));
  const inventory=state.incidentStatus();
  if(privateReadback.status==="VERIFIED"&&(!status.finalInputReady||inventory.universe!==553||inventory.completed!==553||inventory.failed.length||inventory.missing.length)){
    privateReadback.status="LOCAL_INVENTORY_UNVERIFIED";problems.push({stage:"LOCAL_INVENTORY",code:"LIVE_CLOUD_INCOMPLETE"});
  }
  const body={schemaVersion:1,kind:"CLOUD_RULE_BASED_WATCHDOG",date,slot,scheduledAt:new Date(at).toISOString(),startedAt:new Date(now).toISOString(),checkedAt:new Date(state.now()).toISOString(),workflowState,
    status:privateReadback.status==="VERIFIED"?(problems.length?"DELIVERY_VERIFIED_WITH_WARNINGS":"DELIVERY_VERIFIED"):["ERRORED","TERMINATED"].includes(workflowState)||workflowState==="MISSING"&&now>=b.start||inventory.lastFailure||problems.some(p=>p.stage==="FINALIZE_EXISTING_OBSERVATIONS")?"BLOCKED":problems.length?"UNVERIFIED":"WAITING",
    preparation:{initial:status.prepared,final:status.finalInputReady,seedReferenceDate:inventory.seedReferenceDate},
    collection:{expected:553,eligible:inventory.eligible,completed:inventory.completed,failed:inventory.failed.length,missing:inventory.universe===553?inventory.missing.length:null},
    result:{frozen:status.outbox,deliveryVerified:status.receipt?.status==="PRIVATE_RELAY_VERIFIED"},privateReadback,site,actions:[...actions],problems:problems.map(p=>({...p})),sourcePricesIncluded:false,collectionStarted:false};
  const record={...body,recordHash:hash(body)};
  state.write(`watch-snapshot:${slot}`,record);state.write("watch-latest",{slot,recordHash:record.recordHash},true);
  try{await remote.writeImmutable(recordKey(record),record);state.write(`watch-published:${slot}`,{recordHash:record.recordHash});}
  catch(e){state.write(`watch-publish-error:${slot}`,{code:safeCode(e)});}
  return record;
}
