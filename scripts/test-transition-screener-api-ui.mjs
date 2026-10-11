import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import * as React from "react";
import * as jsx from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import * as transition from "../lib/transition-screener.mjs";
import * as screener from "../lib/stock-screener.mjs";
import * as directional from "../lib/directional-transition.mjs";

const row = { code: "000660", name: "검증종목", market: "KOSPI", referenceDate: "2026-10-07", qualityStatus: "PARTIAL_VALIDATED", missingReasons: [], models: Object.fromEntries(["A", "B", "C", "D"].map((m) => [`${m}-v1`, { score: 80, rank: 1 }])), indicators: { rsi: 55, volumeMultiple: 2, macdState: "rising", dailyChangePercent: 1.5 }, transitions: { "5-20": { status: "CROSS_OCCURRED", gapPercent: 0.5, crossDate: "2026-10-07", aboveTradingDays: 1, aboveDaysLowerBound: false }, "20-60": { status: "NONE", gapPercent: -1, crossDate: null, aboveTradingDays: 0, aboveDaysLowerBound: false } } };
const store = { rows: [row], referenceDate: row.referenceDate, sourceQualityGrade: "REJECTED", isPartialRanking: true, quarantinedCount: 30 };
const source = await readFile(new URL("../app/api/screener/route.ts", import.meta.url), "utf8");
const compile = (source, isJsx = false) => ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true, ...(isJsx ? { jsx: ts.JsxEmit.ReactJSX } : {}) } }).outputText;
let storeCalls = 0;
const exports = {};
const loadError = { message: "credential-or-private-url-must-not-leak" };
let fail = false;
const require = (name) => {
  if (name === "@/lib/admin-access") return { withAdminAccess: handler => handler }; // Authorized data-contract fixture; auth independently tested.
  if (name === "next/server") return { NextResponse: { json: (body, init) => ({ body, status: init?.status ?? 200, headers: init?.headers }) } };
  if (name === "node:fs/promises") return { readdir: async () => ["2026-10-07.json"], readFile: async () => JSON.stringify({ asOfDate: row.referenceDate, records: [] }) };
  if (name === "node:path") return path;
  if (name === "@/lib/transition-screener.mjs") return transition;
  if (name === "@/lib/stock-screener.mjs") return screener;
  if (name === "@/lib/directional-transition.mjs") return directional;
  if (name === "@/lib/transition-screener-store.mjs") return { getTransitionData: async () => { storeCalls += 1; if (fail) throw loadError; return store; } };
  throw new Error(`Unexpected dependency: ${name}`);
};
new Function("require", "exports", compile(source))(require, exports);
const request = (query) => ({ nextUrl: new URL(`http://fixture/api/screener?${query}`) });
const valid = await exports.GET(request("tab=transition&state=CROSS_OCCURRED&rsiMin=50&volumeMin=1&scoreB=70"));
assert.equal(valid.status, 200);
assert.equal(valid.body.resultCount, 1);
assert.equal(valid.body.results[0].name, "검증종목");
assert.equal(valid.body.rows, undefined, "반환 결과와 원본 배열을 중복 전송하지 않습니다.");
assert.equal(valid.body.ruleVersion, transition.TRANSITION_RULE_VERSION);
assert.equal(valid.body.researchProposal.approved, true);
assert.equal(valid.body.researchProposal.researchOnly, true);
assert.equal(valid.headers["Cache-Control"], "no-store");
assert.equal((await exports.GET(request("tab=transition&state=NONE"))).body.resultCount, 0);
for (const state of ["APPROACHING", "CONFIRMED"]) {
  row.transitions["5-20"].status = state;
  assert.equal((await exports.GET(request(`tab=transition&state=${state}`))).body.resultCount, 1);
}
row.transitions["5-20"].status = "CROSS_OCCURRED";
row.directionalTransitions = { "5-20": {
  golden: { ...row.transitions["5-20"], direction: "golden", approachStrength: null },
  dead: { status: "APPROACHING", direction: "dead", gapPercent: .5, approachStrength: 75 },
} };
const v2 = await exports.GET(request("tab=transition&rules=directional-v2&crossDirection=dead&state=APPROACHING&strengthMin=50&sort=strength&direction=desc&code=000660"));
assert.equal(v2.status, 200); assert.equal(v2.body.ruleVersion, directional.DIRECTIONAL_RULE_VERSION);
assert.equal(v2.body.results[0].crossDirection, "dead"); assert.equal(v2.body.results[0].approachStrength, 75);
assert.equal(v2.body.approachPolicy.approvedForTrading, false);
const both = await exports.GET(request("tab=transition&rules=directional-v2"));
assert.equal(both.body.resultCount, 2); assert.equal(both.body.uniqueStockCount, 1);
assert.equal((await exports.GET(request("tab=transition&rules=directional-v2&code=000999"))).body.resultCount, 0);
for (const query of ["tab=transition&state=INVALID", "tab=transition&pair=toString", "tab=transition&rsiMin=100&rsiMax=20", "tab=transition&volumeMin=-1", "tab=transition&scoreD=Infinity", "tab=unknown"]) {
  const before = storeCalls;
  assert.equal((await exports.GET(request(query))).status, 400);
  assert.equal(storeCalls, before, "잘못된 입력에서는 데이터 로딩을 하지 않습니다.");
}
fail = true;
const failure = await exports.GET(request("tab=transition"));
assert.equal(failure.status, 503);
assert.doesNotMatch(JSON.stringify(failure), /credential-or-private-url/);
fail = false;
assert.equal((await exports.GET(request("model=A-v1"))).status, 200, "기존 모델/기업 검색 경로를 유지합니다.");

const panel = await readFile(new URL("../components/TransitionScreenerPanel.tsx", import.meta.url), "utf8");
const parent = await readFile(new URL("../components/StockScreenerPanel.tsx", import.meta.url), "utf8");
assert.match(parent, /<TransitionScreenerPanel onSelectStock=\{onSelectStock\}/);
assert.match(panel, /AbortController/);
assert.match(panel, /request === sequence\.current/);
assert.match(panel, /controller\.current\?\.abort\(\)/);
assert.match(panel, /onSelectStock\(\{ code: row\.code, name: row\.name, market: row\.market \}\)/);
assert.match(panel, /PAGE_SIZE = 30/);
assert.match(panel, /md:grid-cols-2 xl:hidden/);
assert.match(panel, /hidden overflow-x-auto xl:block/);
assert.doesNotMatch(source, /fetch\(|calculateTechnical|calculateTrend|KIS/);
const filters = { pair: "5-20", state: "all", market: "all", macd: "all", model: "A-v1", sort: "state", direction: "asc" };
const states = [filters, v2.body, false, null, 0];
let stateIndex = 0;
const uiExports = {};
const uiRequire = (name) => {
  if (name === "react/jsx-runtime") return jsx;
  if (name === "react") return { ...React, useState: () => [states[stateIndex++], () => {}], useRef: () => ({ current: null }), useEffect: () => {}, useCallback: (value) => value };
  if (name === "../lib/directional-transition.mjs") return directional;
  if (name === "./ApproachStrengthDetails") return { __esModule: true, default: () => null };
  throw new Error(`Unexpected UI dependency: ${name}`);
};
new Function("require", "exports", compile(panel, true))(uiRequire, uiExports);
const html = renderToStaticMarkup(React.createElement(uiExports.default, { onSelectStock: () => {} }));
for (const text of ["교차 발생", "접근 중 · 연구용", "교차 후 확인 · 연구용", "데드크로스 접근", "75.00", "검증종목", "000660", "2026-10-07", "2.00x", "55.00", "80.00", "필터 입력 결측 제외", "매수 추천·상승 확률이 아닙니다", "REJECTED"]) assert.ok(html.includes(text), `UI 렌더 누락: ${text}`);
assert.ok(html.includes("지표 상세 펼치기"));
assert.match(panel, /<details className="relative mt-2/u);
assert.doesNotMatch(panel, /<article[^>]+onClick/u, "details에서 버블링으로 종목 이동이 발생하지 않습니다.");
console.log("transition screener route validation/legacy isolation/secret-safe errors/mobile SSR/stale guard UI tests passed");
