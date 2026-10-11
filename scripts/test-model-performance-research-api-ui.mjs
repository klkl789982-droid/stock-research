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
    if (name === "next/server") return { NextResponse: { json: (body, options) => ({ body, options }) } };
    if (name === "@/lib/model-performance-research.mjs") return researchEngine;
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
  for (const text of ["실행 수익률 연구", "1D", "5D", "20D", "A-v2", "TOP20", "RETROSPECTIVE", `발행 근거 확인 ${data.coverage.selectedSignalCount}일`, "통계 산출 보류", "기존 백테스트 품질 인증 부적격", "서로 다른 종목", "비용 근거", "공식 지수 데이터 미연결", "독립 표본", data.coverage.latestStoredSignalDate]) assert.ok(html.includes(text), text);
  if (data.cohorts.every((c) => c.stockMetrics.observationCount === 0)) assert.doesNotMatch(html, /0\.00%/, "excluded observations are not 0% performance");
  assert.match(existingPanel, /performanceLayer === "RESEARCH" \? <ModelPerformanceResearchPanel/);
  assert.match(panelSource, /AbortController/); assert.match(panelSource, /controller\.signal\.aborted/);
  assert.match(panelSource, /grid-cols-2/); assert.match(panelSource, /sm:grid-cols-3/); assert.match(panelSource, /lg:grid-cols-6/);
  assert.doesNotMatch(routeSource, /GITHUB_TOKEN|KIS_OBSERVATION_STORE_TOKEN|kis-eod-private|intraday-signals/);
});
