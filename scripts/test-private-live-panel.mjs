import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import * as React from "react";
import * as jsx from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import { createDeliveryFixture } from "../lib/private-live-delivery-fixture.mjs";
import * as homePresentation from "../lib/home-presentation.mjs";
const panelExports = {};
const source = await readFile(new URL("../components/PrivateLiveDeliveryPanel.tsx", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
new Function("require", "exports", compiled)(name => { if (name === "react") return React; if (name === "react/jsx-runtime") return jsx; if (name === "../lib/home-presentation.mjs") return homePresentation; throw new Error(name); }, panelExports);
const render = props => renderToStaticMarkup(React.createElement(panelExports.PrivateLiveDeliveryView, props));
assert.equal(render({ data: null, disabled: true }), "");
assert.match(render({ data: null, failed: true }), /비공개 결과 조회 실패/);
assert.match(render({ data: { status: "UNAVAILABLE", source: "privateLiveRelay", delivery: null } }), /아직 전달된 14:00 관측 결과가 없습니다/);
const fixture = createDeliveryFixture("aeb04979-d2a5-449e-a588-715b86a6d19b");
const synthetic = render({ data: { source: "privateRelayFixture", delivery: fixture } });
assert.equal((synthetic.match(/합성 연결검증/g) ?? []).length, 20);
assert.match(synthetic, /실제 시세·모델 순위·14:00 관측이 아닙니다/);
const historical = render({ data: { source: "privateLiveRelay", status: "AVAILABLE", freshnessStatus: "HISTORICAL", servedAt: "2026-10-17T01:00:00Z", delivery: { signalDate: "2026-10-16", exportedAt: "2026-10-16T05:04:00Z", models: fixture.models.map(m => ({ ...m, collectionStartedAt: "2026-10-16T05:00:01Z", collectionCompletedAt: "2026-10-16T05:03:01Z" })) } } });
assert.match(historical, /이전 날짜 저장 기록/); assert.match(historical, /2026-10-16 14:00 KST/);
assert.match(historical, /실제 관측 구간/); assert.match(historical, /전달 파일 생성/); assert.match(historical, /사이트 조회/);
assert.doesNotMatch(historical, /읽기 전용 권한 검증|오늘.*정상|기대수익|상승 확률/);
console.log("private relay panel: unavailable, failure, synthetic separation, historical timestamps and score-only TOP5 passed");
const waiting = { data: { status: "UNAVAILABLE", delivery: null }, failed: false, disabled: false };
assert.match(panelExports.privateRelaySummary(waiting), /관측 대기/);
assert.match(panelExports.privateRelaySummary({ ...waiting, failed: true }), /조회 실패/);
assert.match(panelExports.privateRelaySummary({ ...waiting, data: { source: "privateRelayFixture", delivery: fixture } }), /합성.*실제 관측 아님/);
assert.match(panelExports.privateRelaySummary({ ...waiting, data: { source: "privateLiveRelay", freshnessStatus: "HISTORICAL", delivery: { signalDate: "2026-10-16" } } }), /2026-10-16.*이전 날짜/);
const revised=render({data:{source:"privateLiveRelay",status:"AVAILABLE",servedAt:"2026-11-03T07:30:00Z",publicationTimes:{firstPublishedAt:"2026-11-03T06:05:00Z",publishedAt:"2026-11-03T07:29:00Z"},delivery:{
 signalDate:"2026-11-03",exportedAt:"2026-11-03T07:00:00Z",models:fixture.models,deliveryHash:"b".repeat(64),sourceHash:"c".repeat(64),
 publication:{status:"PARTIAL",revision:2,firstIssuedAt:"2026-11-03T05:10:00Z",previousDeliveryHash:"a".repeat(64),
 targetCount:508,validCount:507,universeHash:"d".repeat(64),missing:[{ticker:"009450",reason:"LIVE_CLOUD_RATE_EVIDENCE_INVALID"}]}}}});
for(const label of ["잠정 순위","정상 507 · 대상 508 · 미반영 1","009450 · 요청·응답 시각 검증 실패","발행 버전 r2","수정 게시 2026.11.03 16:29:00 KST","직전 발행 해시"])assert.ok(revised.includes(label),label);
assert.doesNotMatch(revised,/LIVE_CLOUD_RATE_EVIDENCE_INVALID|잠정 순위 · PARTIAL/);
const completeCoverage=renderToStaticMarkup(React.createElement(panelExports.LiveCoverageSummary,{coverage:{status:"COMPLETE",validCount:508,targetCount:508,missing:[],universeHash:"a".repeat(64)}}));
assert.match(completeCoverage,/확정 순위/); assert.doesNotMatch(completeCoverage,/COMPLETE/);
const integrity=render({data:{source:"privateLiveRelay",delivery:{deliveryHash:"b".repeat(64)}},integrityOnly:true});
assert.match(integrity,/<details[^>]*\bopen=""/);assert.ok(integrity.includes("SHA256 "+"b".repeat(64)));

const fixtureApi = {}, listeners = new Set(), requests = [];
let effect, interval, elapsed = 0;
new Function("require","exports",compiled)(name => name === "react" ? {...React, useState: () => [null, () => {}], useEffect: fn => { effect = fn; }} : name === "react/jsx-runtime" ? jsx : homePresentation, fixtureApi);
const originals = { document: globalThis.document, fetch: globalThis.fetch, setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval, now: Date.now };
try {
  globalThis.document = {hidden: true, addEventListener: (_,fn) => listeners.add(fn), removeEventListener: (_,fn) => listeners.delete(fn)};
  globalThis.fetch = async (url,options) => {requests.push([url,options.signal]);return {ok:true,json:async()=>({})};};
  globalThis.setInterval = (fn,ms) => {assert.equal(ms,60_000);interval=fn;return 1;};
  globalThis.clearInterval = () => {interval=null;};
  Date.now=()=>elapsed;
  fixtureApi.usePrivateLiveDelivery(); const cleanup=effect();
  await interval(); assert.equal(requests.length,0);
  document.hidden=false; for (const fn of listeners) await fn();
  assert.equal(requests.length,1); await interval(); assert.equal(requests.length,1);
  elapsed+=60_000; await interval(); assert.equal(requests.length,2);
  document.hidden=true; elapsed+=60_000; await interval(); assert.equal(requests.length,2);
  cleanup(); assert.equal(listeners.size,0); assert.equal(interval,null); assert.ok(requests.every(([,signal])=>signal.aborted));
} finally {
  if (originals.document===undefined) delete globalThis.document; else globalThis.document=originals.document;
  globalThis.fetch=originals.fetch; globalThis.setInterval=originals.setInterval; globalThis.clearInterval=originals.clearInterval; Date.now=originals.now;
}
