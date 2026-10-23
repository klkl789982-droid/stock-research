import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import ts from "typescript";
import * as jsx from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import * as dates from "../lib/home-presentation.mjs";
import { EXECUTION_PREFIX, sealExecutionRecord, validateExecutionRecord, executionStatusDto, executionRecordKey, readTodayExecution, privateLiveExecutionResponse } from "../lib/private-live-execution-status.mjs";

const now="2026-10-20T10:00:00.000Z",date="2026-10-20";
const fixture=()=>({schemaVersion:1,namespace:EXECUTION_PREFIX,source:"CLOUDFLARE_DURABLE_STATE",signalDate:date,runId:`live-${date}`,recordedAt:now,event:"RECONCILE",workflowState:"ERRORED",
 error:{code:"LIVE_CLOUD_SQL_BUDGET",stage:"FINALIZE"},input:{initialReady:true,finalReady:true,seedReferenceDate:"2026-10-19",checkedAt:`${date}T04:59:01.000Z`,initialReadyAt:`${date}T04:40:01.000Z`,finalReadyAt:`${date}T04:59:02.000Z`},
 collection:{expected:553,eligible:508,available:1,excluded:0,failed:0,missing:552,requiredMissing:507,activeLeases:0,firstRequestedAt:`${date}T05:00:01.000Z`,lastReceivedAt:`${date}T05:00:01.500Z`},
 validation:{outboxFrozen:false,deliveryHash:null,frozenAt:null},delivery:{verified:false,deliveryHash:null}});
const record=()=>sealExecutionRecord(fixture());
test("today failure stays separate from previous good result and blocks validation/delivery",()=>{
 const dto=executionStatusDto(record(),now);assert.equal(dto.status,"FAILED");
 assert.deepEqual(dto.stages,{preparation:"SUCCEEDED",collection:"FAILED",validation:"BLOCKED",delivery:"BLOCKED"});
 assert.equal(dto.collection.available,1);assert.equal(dto.collection.missing,552);assert.equal(dto.sourcePricesIncluded,false);
});
test("hash, schema, dates, count, raw fields, partial-success and future metadata fail closed",()=>{
 for(const change of [v=>{v.input.token="not-allowed";},v=>{v.collection.price=1;},v=>{v.collection.missing=551;},v=>{v.signalDate="2026-02-30";},v=>{v.input.seedReferenceDate=date;},v=>{v.validation.outboxFrozen=true;},v=>{v.delivery.verified=true;},v=>{v.input.checkedAt="2026-10-21T00:00:00.000Z";},v=>{v.event="arbitrary";}]){
  const v=fixture();change(v);assert.throws(()=>sealExecutionRecord(v),/STATUS_INVALID/);
 }
 const altered=record();altered.collection.available=2;assert.throws(()=>validateExecutionRecord(altered,now));
 assert.throws(()=>validateExecutionRecord(record(),`${date}T09:59:59.000Z`));
});
test("preparation, missing final EOD, stale progress, frozen result and verified delivery have distinct states",()=>{
 const early=fixture();early.recordedAt=`${date}T04:40:02.000Z`;early.event="PREPARATION";early.workflowState="RUNNING";early.error=null;
 early.input.finalReady=false;early.input.finalReadyAt=null;early.input.checkedAt=null;early.collection={...early.collection,available:0,missing:553,eligible:null,requiredMissing:null,firstRequestedAt:null,lastReceivedAt:null};
 assert.equal(executionStatusDto(sealExecutionRecord(early),early.recordedAt).status,"IN_PROGRESS");
 assert.equal(executionStatusDto(sealExecutionRecord(early),now).status,"STALE","no later confirmation is not proof the run failed");
 early.recordedAt=now;early.event="FAILURE_DAY";assert.equal(executionStatusDto(sealExecutionRecord(early),now).status,"BLOCKED");
 const full=fixture();full.workflowState="RUNNING";full.error=null;full.collection={...full.collection,available:508,excluded:45,missing:0,requiredMissing:0};
 assert.equal(executionStatusDto(sealExecutionRecord(full),now).stages.validation,"UNKNOWN");
 full.validation={outboxFrozen:true,deliveryHash:"a".repeat(64),frozenAt:`${date}T05:05:01.000Z`};
 assert.equal(executionStatusDto(sealExecutionRecord(full),now).status,"STALE");
 full.delivery={verified:true,deliveryHash:"a".repeat(64)};const done=executionStatusDto(sealExecutionRecord(full),now);
 assert.equal(done.status,"SUCCEEDED");assert.ok(Object.values(done.stages).every(x=>x==="SUCCEEDED"));
});
test("only current KST date is inventoried, immutable filename/hash match, no yesterday fallback",async()=>{
 const r=record(),key=executionRecordKey(r),name=key.split("/").at(-1);const paths=[];
 const store={async verifyPrivateRepository(){},async listKeys(p){paths.push(p);return[{name,type:"file"}];},async read(k){assert.equal(k,key);return{value:r};}};
 const result=await readTodayExecution(store,{now});assert.equal(result.record.status,"FAILED");assert.deepEqual(paths,[`${EXECUTION_PREFIX}/${date}`]);
 assert.equal((await readTodayExecution({...store,listKeys:async()=>[]},{now})).status,"NO_EXECUTION_RECORD");
 await assert.rejects(readTodayExecution({...store,listKeys:async()=>[{name:name.replace(r.recordHash,"b".repeat(64)),type:"file"}]},{now}));
 await assert.rejects(readTodayExecution({...store,listKeys:async()=>Array(11).fill({name,type:"file"})},{now}));
});
test("read-only API fixed path, private repository, sanitized errors and fixture separation",async()=>{
 const r=record(),key=executionRecordKey(r),calls=[];const bytes=JSON.stringify(r);
 const env={PRIVATE_LIVE_DELIVERY_READ_ENABLED:"true",PRIVATE_LIVE_DELIVERY_REPOSITORY:"klkl789982-droid/tight-budget-private-data",PRIVATE_LIVE_DELIVERY_READ_TOKEN:"fixture-read-only"};
 const fetchImpl=async(url,init)=>{calls.push({url,method:init.method});assert.equal(init.method,"GET");
  return Response.json(url.endsWith("tight-budget-private-data")?{private:true,full_name:env.PRIVATE_LIVE_DELIVERY_REPOSITORY}:url.includes(encodeURIComponent(key.split("/").at(-1)))?{type:"file",encoding:"base64",size:Buffer.byteLength(bytes),content:Buffer.from(bytes).toString("base64") }:[{name:key.split("/").at(-1),type:"file"}]);};
 const req=new Request("https://site/api/private-live-execution");const res=await privateLiveExecutionResponse(req,{env,fetchImpl,now});
 assert.equal(res.status,200);assert.equal((await res.json()).record.recordHash,r.recordHash);assert.equal(calls.length,3);assert.equal(res.headers.get("cache-control"),"private, no-store");
 assert.equal((await privateLiveExecutionResponse(new Request(req.url+"?date=2026-10-19"),{env,fetchImpl,now})).status,400);
 assert.equal((await privateLiveExecutionResponse(req,{env:{},fetchImpl,now})).status,404);
 const failed=await privateLiveExecutionResponse(req,{env,now,fetchImpl:async()=>Response.json({private:false,full_name:env.PRIVATE_LIVE_DELIVERY_REPOSITORY})});assert.equal(failed.status,503);assert.deepEqual(await failed.json(),{error:"PRIVATE_LIVE_EXECUTION_UNAVAILABLE"});
 const preview=await privateLiveExecutionResponse(req,{env:{...env,PRIVATE_LIVE_DELIVERY_FIXTURE_ID:"test"},now,fetchImpl:()=>assert.fail("fixture must not be production status")});assert.equal((await preview.json()).status,"NO_EXECUTION_RECORD");
});

test("late progress never hides a terminal regular-run failure retained in the same directory",async()=>{
 const terminal=record();const progress=fixture();progress.recordedAt="2026-10-20T10:01:00.000Z";progress.event="COLLECTION";progress.workflowState="RUNNING";progress.error=null;
 const later=sealExecutionRecord(progress),values=new Map([terminal,later].map(v=>[executionRecordKey(v),v]));
 const result=await readTodayExecution({verifyPrivateRepository:async()=>{},listKeys:async()=>[...values.keys()].map(key=>({name:key.split("/").at(-1),type:"file"})),read:async key=>({value:values.get(key)})},{now:"2026-10-20T10:02:00.000Z"});
 assert.equal(result.record.event,"RECONCILE");assert.equal(result.record.error.code,"LIVE_CLOUD_SQL_BUDGET");
 assert.equal(result.record.recordHash,terminal.recordHash,"select existing evidence, never rewrite an immutable record");
});
test("actual component renders failure, no-record, unavailable and complete without claiming liveness",async()=>{
 const exports={};new Function("require","exports",ts.transpileModule(await fs.readFile(new URL("../components/HomeCloudExecutionStatus.tsx",import.meta.url),"utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText)(n=>n==="react/jsx-runtime"?jsx:dates,exports);
 const dto=executionStatusDto(record(),now),state={data:{targetDate:date,servedAt:now,record:dto},error:false};
 const html=renderToStaticMarkup(exports.default({state,lastDeliveryHash:"a".repeat(64)}));
 for(const word of ["저장 처리 예산 초과","1/553","누락 552","준비 · 완료","수집 · 실패","검증·계산 · 차단","비공개 전달 · 차단","실시간 진행률 아님"])assert.ok(html.includes(word),word);
 assert.ok(exports.cloudExecutionWarning(state));assert.match(exports.cloudExecutionLabel({data:null,error:true}),/조회 실패/);
 assert.match(exports.cloudExecutionLabel({data:{record:null,targetDate:date},error:false}),/실행 여부 미확인/);
 const source=await fs.readFile(new URL("../app/api/private-live-execution/route.ts",import.meta.url),"utf8");assert.match(source,/withAdminAccess/);assert.doesNotMatch(source,/isAutomationRequest|Bearer/);
});
