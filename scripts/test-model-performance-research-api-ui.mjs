import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import ts from "typescript";
import * as React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import { loadModelPerformanceResearch } from "../lib/model-performance-research-store.mjs";
import * as researchEngine from "../lib/model-performance-research.mjs";

const routeSource = await readFile(new URL("../app/api/model-performance/research/route.ts", import.meta.url), "utf8");
const panelSource = await readFile(new URL("../components/ModelPerformanceResearchPanel.tsx", import.meta.url), "utf8");
const existingPanel = await readFile(new URL("../components/ModelTopPerformancePanel.tsx", import.meta.url), "utf8");
const compiled = (source) => ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
function makeRoute(loader) {
  const exports = {};
  new Function("require", "exports", compiled(routeSource))((name) => {
    if (name === "@/lib/admin-access") return { withAdminAccess: handler => handler }; // Authorized data-contract fixture; auth independently tested.
    if (name === "@/data/model-validation/frozen-strategy-summary-20261103.json") return { default: { candidates: [] } };
    if (name === "@/data/model-validation/sell-tax-comparison-20261103.json") return { default: { comparisons: [] } };
    if (name === "@/data/model-validation/top-cross-comparison-v1.json") return {default:{summary:[],inventory:[]}};
    if (name === "@/lib/top-cross-benchmark.mjs") return {compareOfficialMarkets:async()=>[]};
    if (name === "next/server") return { NextResponse: { json: (body, options) => ({ body, options }) } };
    if (name === "@/lib/model-performance-research.mjs") return researchEngine;
    if (name === "@/lib/kis-token-manager") return { kisRequest: () => { throw new Error("Network disabled in fixture"); } };
    if (name === "@/lib/daily-publication-status.mjs") return { loadPublicationEvidence: async () => ({ evidence: [] }) };
    if (name === "@/lib/research-index-benchmarks.mjs") return { loadPrivateBenchmarkLegs: async () => [] };
    if (name === "@/lib/research-publication-receipts.mjs") return { readResearchPublicationReceipts: async () => [] };
    if (name === "@/lib/model-performance-research-store.mjs") return { loadModelPerformanceResearch: loader };
    throw new Error(`Unexpected dependency ${name}`);
  }, exports);
  return exports.GET;
}
test("actual research route validates filters and preserves no-store / derived-only contract", async () => {
  let called = 0;
  const GET = makeRoute(async ({ options }) => { called++; return { filter: options, cohorts: [{ rows: [{ ticker: "000001", referencePrice: 12345, grossReturn: 0 }] }] }; });
  const result = await GET(new Request("http://fixture/api/model-performance/research?models=A-v2,B-v1&topN=20&horizon=H20&market=KOSDAQ"));
  assert.equal(result.options.headers["Cache-Control"], "no-store"); assert.equal(result.body.filter.topN, 20); assert.deepEqual(result.body.filter.models, ["A-v2", "B-v1"]);
  assert.equal(result.body.cohorts[0].rows[0].referencePrice, undefined); assert.equal(result.body.cohorts[0].rows[0].grossReturn, 0);
  for (const query of ["models=", "models=E-v1", "topN=999", "from=2026-99-01", "from=2026-02-30", "horizon=H60", "classification=LIVE", "costMode=USER_INPUT", "costMode=USER_INPUT&buyFeeBps=-1", "from=2026-10-08&to=2026-10-01", "costMode=USER_INPUT&buyFeeBps=&sellFeeBps=0&sellTaxBps=0&buySlippageBps=0&sellSlippageBps=0&basisDate=2026-01-02&basis=fixture"]) {
    const result = await GET(new Request(`http://fixture/api/model-performance/research?${query}`)); assert.equal(result.options.status, 400, query);
  }
  assert.equal(called, 1, "invalid inputs must not touch data files");
  const unavailable = await makeRoute(async () => { throw new Error("sensitive-internal-path"); })(new Request("http://fixture/"));
  assert.equal(unavailable.options.status, 503); assert.doesNotMatch(JSON.stringify(unavailable.body), /sensitive-internal-path/);
});
test("render real research panel with repository diagnostics; no fake zero / no layer leakage", async () => {
  const data = await loadModelPerformanceResearch({ asOf: "2026-10-11T00:00:00Z" });
  const exports = {}, states = ["", 0, data, null, false, "GROSS_ONLY"]; let i = 0;
  new Function("require", "exports", compiled(panelSource))((name) => {
    if (name === "react/jsx-runtime") return jsxRuntime;
    if (name === "react") return { ...React, useState: () => [states[i++], () => {}], useEffect: () => {} };
    throw new Error(`Unexpected dependency ${name}`);
  }, exports);
  const html = renderToStaticMarkup(React.createElement(exports.default));
  for (const text of ["실행 수익률 연구", "1D", "5D", "20D", "A-v2", "TOP20", "RETROSPECTIVE", `발행 근거 확인 ${data.coverage.selectedSignalCount}일`, "통계 산출 보류", "기존 백테스트 품질 인증 부적격", "서로 다른 종목", "비용 근거", "공식 지수 일봉", "독립 표본", data.coverage.latestStoredSignalDate]) assert.ok(html.includes(text), text);
  if (data.cohorts.every((c) => c.stockMetrics.observationCount === 0)) assert.doesNotMatch(html, /0\.00%/, "excluded observations are not 0% performance");
  assert.match(existingPanel, /performanceLayer === "RESEARCH" \? <ModelPerformanceResearchPanel/);
  assert.match(panelSource, /AbortController/); assert.match(panelSource, /controller\.signal\.aborted/);
  assert.doesNotMatch(panelSource, /setInterval/);
  assert.match(panelSource, /setQuery\(parameters\.toString\(\)\); setRevision\(/, "resubmitting the same conditions still refreshes the research report");
  assert.match(panelSource, /grid-cols-2/); assert.match(panelSource, /sm:grid-cols-3/); assert.match(panelSource, /lg:grid-cols-6/);
  assert.doesNotMatch(routeSource, /GITHUB_TOKEN|KIS_OBSERVATION_STORE_TOKEN|kis-eod-private|intraday-signals/);
});

test("backtest catalog is fixed to official posted rows, caches only its immutable projection, and rejects mixed layers", async () => {
  let calls = 0;
  const choices = [{ date: "2026-10-19", model: "D-v1", horizon: "H1", topN: 5, selected: 5, mature: 5, missing: 0, pending: 0 }];
  const run = makeRoute(async ({ options, includeChoices }) => {
    calls++;
    assert.equal(includeChoices, true); assert.equal(options.topN, 20); assert.equal(options.benchmark, "NONE");
    assert.equal(options.classification, "PUBLISHED_PRICE_OBSERVATION");
    return { choices, asOf: "2026-11-03T00:00:00Z", verifiedPublicationDates: [], cohorts: [{ rows: [{ referencePrice: 999 }] }] };
  });
  for (let i = 0; i < 2; i++) {
    const response = await run(new Request("http://fixture/api/model-performance/research?view=backtest-options"));
    assert.deepEqual(response.body.choices, choices);
    assert.equal(response.body.cohorts, undefined);
  }
  for (const query of ["view=backtest-options&models=B-v1","view=backtest&models=D-v3-research", "view=backtest&classification=RETROSPECTIVE&models=D-v1"])
    assert.equal((await run(new Request("http://fixture/?"+query))).options.status, 400);
  assert.equal(calls,1);
});

test("backtest reports count mature, pending and missing by actual ranks and horizon, preserve receipt and research boundaries", async () => {
  const options = { models: ["D-v1"], classification: "PUBLISHED_PRICE_OBSERVATION", topN: 20, benchmark: "NONE", from: "2026-10-14", to: "2026-10-15" };
  const report = await loadModelPerformanceResearch({ asOf:"2026-11-03T06:00:00Z", options, includeChoices: true });
  const row = (h, n) => report.choices.find(c=>c.date==="2026-10-14" && c.topN===n && c.horizon===h);
  assert.equal(row("H1",5).mature,5); assert.equal(row("H5",10).mature,10);
  assert.equal(row("H20",20).pending,20);
  for (const choice of report.choices) assert.equal(choice.mature+choice.pending+choice.missing,choice.selected);
  const timing = report.verifiedPublicationDates.find(s=>s.signalDate==="2026-10-14");
  assert.equal(timing.confirmedBy,"2026-10-15T04:21:13Z");
  assert.equal(timing.plannedEntryDate,"2026-10-16"); assert.equal(timing.firstKnownRegularOpen,timing.plannedEntryDate);

  const view = await readFile(new URL("../components/BacktestPanel.tsx",import.meta.url),"utf8");
  const study = JSON.parse(await readFile(new URL("../data/model-validation/frozen-strategy-summary-20261103.json",import.meta.url),"utf8"));
  function render(tab, opts, error=false) {
    let index = 0; const states = [tab,opts,0,error,"D-v1",10,1,"","",false,null,null,false], exports={};
    new Function("require","exports",compiled(view))((name)=>{
      if(name==="./TopCrossStudy") return {default:()=>React.createElement("section",null,"세 방식 비교")};
      if(name==="./DualTargetStudy") return {default:()=>React.createElement("section",null,"두 목적 순위")};
      if(name==="react/jsx-runtime") return jsxRuntime;
      if(name==="react") return {...React,useState:()=>[states[index++],()=>{}],useEffect:()=>{}};
      throw new Error(name);
    },exports);
    return renderToStaticMarkup(React.createElement(exports.default));
  }
  const tax = JSON.parse(await readFile(new URL("../data/model-validation/sell-tax-comparison-20261103.json",import.meta.url),"utf8"));
  assert.equal(tax.sourceStudyHash,study.sourceStudyHash);
  assert.equal(tax.protocolHash,study.protocolHash);
  const inv = { choices: report.choices, study: {...study,sellTax:tax.comparisons}, confirmedDates: report.verifiedPublicationDates };
  const standard=render("published",inv), research=render("study",inv);
  assert.match(standard,/<option(?=[^>]*disabled="")(?=[^>]*value="20")[^>]*>20거래일 · 보유기간 미성숙/);
  assert.match(standard,/성숙 20건/); assert.doesNotMatch(standard,/D-v3-research/);
  assert.match(render("published",{...inv,choices:[]}),/조건을 충족한 게시 신호가 없습니다/);
  assert.match(render("published",null,true),/평가 가능 범위를 조회하지 못했습니다/);
  assert.match(research,/D-v3-research/); assert.match(research,/매도 세금은 제외/);
  assert.match(research,/서로 다른 신규 신호일 60개/); assert.match(research,/미성숙 결과는 집계에서 제외/);
  assert.match(research,/\+1\.40%/); assert.match(research,/세율 미확인 5건이 있는 5일/);
  assert.equal(study.candidates.find(c=>c.version==="D-v3-research").pairedDates,5);
});
