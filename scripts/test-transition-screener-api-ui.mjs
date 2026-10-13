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
import * as evidence from "../lib/transition-evidence.mjs";
import * as evidencePolicy from "../lib/transition-evidence-policy.mjs";
import * as liveTransition from "../lib/live-transition-screener.mjs";

const row = { code: "000660", name: "검증종목", market: "KOSPI", referenceDate: "2026-10-07", qualityStatus: "PARTIAL_VALIDATED", missingReasons: [], models: Object.fromEntries(["A", "B", "C", "D"].map((m) => [`${m}-v1`, { score: 80, rank: 1 }])), indicators: { rsi: 55, volumeMultiple: 2, macdState: "rising", dailyChangePercent: 1.5 }, transitions: { "5-20": { status: "CROSS_OCCURRED", gapPercent: 0.5, crossDate: "2026-10-07", aboveTradingDays: 1, aboveDaysLowerBound: false }, "20-60": { status: "NONE", gapPercent: -1, crossDate: null, aboveTradingDays: 0, aboveDaysLowerBound: false } } };
const store = { rows: [row], referenceDate: row.referenceDate, sourceQualityGrade: "REJECTED", isPartialRanking: true, quarantinedCount: 30 };
row.upwardEvidence = { "5-20": evidence.evaluateTransitionEvidence({ pair: "5-20", points: [90, 92, 95, 99].map(ma5 => ({ ma5, ma20: 100, ma60: 110 })), current: { rsi: 45, rsiChange: 2, macd: -2, signal: -1, histogram: -1, previousHistogram: -2, volumeRatio: 150 }, bars: [{ clpr: 105, trqu: 200 }, { clpr: 100, trqu: 100 }] }) };
const source = await readFile(new URL("../app/api/screener/route.ts", import.meta.url), "utf8");
const compile = (source, isJsx = false) => ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true, ...(isJsx ? { jsx: ts.JsxEmit.ReactJSX } : {}) } }).outputText;
let storeCalls = 0, liveStoreCalls = 0;
let liveFailure = null;
const liveStore = { mode: "LIVE", referenceDate: "2026-10-08", modelReferenceDate: row.referenceDate, previousOfficialDate: row.referenceDate,
  ruleVersion: liveTransition.LIVE_TRANSITION_RULE_VERSION, rows: [{ ...row, referenceDate: "2026-10-08", modelReferenceDate: row.referenceDate,
    qualityStatus: "PROVISIONAL", observedPrice: 102, quoteAsOfDate: "2026-10-08", quoteAsOfTime: "14:30:01", receivedAt: "2026-10-08T05:30:02Z",
    closedRows: Array.from({ length: 60 }, () => ["20261007", 100, 100, 100, 100, 1]) }] };
const exports = {};
const loadError = { message: "credential-or-private-url-must-not-leak" };
let fail = false;
const require = (name) => {
  if (name === "@/lib/admin-access") return { withAdminAccess: handler => handler }; // Authorized data-contract fixture; auth independently tested.
  if (name === "next/server") return { NextResponse: { json: (body, init) => ({ body, status: init?.status ?? 200, headers: init?.headers }) } };
  if (name === "node:fs/promises") return { readdir: async () => ["2026-10-07.json"], readFile: async () => JSON.stringify({ asOfDate: row.referenceDate, records: [] }) };
  if (name === "node:path") return path;
  if (name === "@/lib/transition-screener.mjs") return transition;
  if (name === "@/lib/live-transition-screener.mjs") return liveTransition;
  if (name === "@/lib/live-transition-store.mjs") return { getLiveTransitionData: async () => { liveStoreCalls++; if (liveFailure) throw new Error(liveFailure); return liveStore; } };
  if (name === "@/lib/stock-screener.mjs") return screener;
  if (name === "@/lib/directional-transition.mjs") return directional;
  if (name === "@/lib/transition-evidence.mjs") return evidence;
  if (name === "@/lib/transition-evidence-policy.mjs") return evidencePolicy;
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
assert.equal(valid.body.evidencePolicy.version, "transition-evidence-research-v1");
assert.equal(valid.body.evidenceConfigHash, evidence.evidenceConfigHash);
assert.equal(valid.body.results[0].evidence.fulfilledCount, 4);
assert.equal((await exports.GET(request("tab=transition&momentumEvidence=improving&volumeEvidence=met&evidenceMin=4"))).body.resultCount, 1);
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
for (const query of ["tab=transition&state=INVALID", "tab=transition&pair=toString", "tab=transition&rsiMin=100&rsiMax=20", "tab=transition&volumeMin=-1", "tab=transition&scoreD=Infinity", "tab=transition&evidenceMin=5", "tab=transition&momentumEvidence=INVALID", "tab=unknown"]) {
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

const beforeLiveEodCalls = storeCalls;
const liveResponse = await exports.GET(request("tab=transition&mode=LIVE&state=candidates&nearPercent=1&pair=5-20"));
assert.equal(liveResponse.status, 200);
assert.equal(liveResponse.body.mode, "LIVE");
assert.equal(liveResponse.body.resultCount, 1);
assert.equal(liveResponse.body.results[0].status, "CROSS_OCCURRED");
assert.equal(liveResponse.body.results[0].closedRows, undefined);
assert.equal(liveResponse.body.modelReferenceDate, "2026-10-07");
assert.equal(liveResponse.body.referenceDate, "2026-10-08");
assert.equal(liveResponse.body.rows, undefined);
assert.equal(liveResponse.headers["Cache-Control"], "no-store");
assert.equal(storeCalls, beforeLiveEodCalls, "LIVE never loads latest EOD");
for (const query of ["mode=INVALID", "mode=LIVE&nearPercent=NaN", "mode=LIVE&nearPercent=5.1", "mode=LIVE&pair=toString", "mode=LIVE&state=CONFIRMED"]) {
  const before = liveStoreCalls;
  assert.equal((await exports.GET(request(`tab=transition&${query}`))).status, 400);
  assert.equal(liveStoreCalls, before);
}
for (const reason of Object.keys(liveTransition.LIVE_TRANSITION_ERRORS)) {
  liveFailure = reason;
  const unavailable = await exports.GET(request("tab=transition&mode=LIVE"));
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.body.error.diagnostic, reason);
  assert.equal(unavailable.body.error.message, liveTransition.LIVE_TRANSITION_ERRORS[reason]);
  assert.equal(unavailable.headers["Cache-Control"], "no-store");
}
liveFailure = "credential-or-private-url-must-not-leak";
assert.doesNotMatch(JSON.stringify(await exports.GET(request("tab=transition&mode=LIVE"))), /credential-or-private-url/);
liveFailure = null;
const explicitEod = await exports.GET(request("tab=transition&mode=EOD"));
const defaultEod = await exports.GET(request("tab=transition"));
assert.deepEqual(explicitEod, defaultEod, "explicit EOD preserves the existing API response");

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
const detailExports = {};
new Function("require", "exports", compile(await readFile(new URL("../components/TransitionEvidenceDetails.tsx", import.meta.url), "utf8"), true))((name) => {
  if (name === "react/jsx-runtime") return jsx;
  if (name === "../lib/transition-evidence-policy.mjs") return evidencePolicy;
  throw new Error(`Unexpected detail dependency: ${name}`);
}, detailExports);
const uiRequire = (name) => {
  if (name === "react/jsx-runtime") return jsx;
  if (name === "react") return { ...React, useState: () => [states[stateIndex++], () => {}], useRef: () => ({ current: null }), useEffect: () => {}, useCallback: (value) => value };
  if (name === "../lib/directional-transition.mjs") return directional;
  if (name === "../lib/transition-evidence-policy.mjs") return evidencePolicy;
  if (name === "./TransitionEvidenceDetails") return { __esModule: true, ...detailExports };
  if (name === "./ApproachStrengthDetails") return { __esModule: true, default: () => null };
  if (name === "./LiveTransitionScreenerPanel") return { __esModule: true, default: () => null };
  if (name === "./LiveTransitionDetails") return { TransitionModeSelector: () => null };
  throw new Error(`Unexpected UI dependency: ${name}`);
};
new Function("require", "exports", compile(panel, true))(uiRequire, uiExports);
const html = renderToStaticMarkup(React.createElement(uiExports.EodTransitionScreenerPanel, { onSelectStock: () => {} }));
for (const text of ["교차 발생", "접근 중 · 연구용", "교차 후 확인 · 연구용", "데드크로스 접근", "75.00", "검증종목", "000660", "2026-10-07", "2.00x", "55.00", "80.00", "필터 입력 결측 제외", "매수 추천·상승 확률이 아닙니다", "REJECTED"]) assert.ok(html.includes(text), `UI 렌더 누락: ${text}`);
assert.ok(html.includes("지표 상세 펼치기"));
for (const text of ["상승 전환 초기 후보", "상승 전환 확인 후보", "강한 상승 초기 후보", "4/4 충족", "4/4 평가 가능", "RSI 변화", "히스토그램 변화", "이평선 간격 개선", "단기 추세 개선", "상승 거래량 동반", evidence.evidenceConfigHash]) assert.ok(html.includes(text), text);
const unavailable = renderToStaticMarkup(React.createElement(detailExports.default, { evidence: null })); assert.ok(unavailable.includes("확인 불가"));
const missing = structuredClone(row.upwardEvidence["5-20"]); missing.categories.momentum.status = "DATA_MISSING"; missing.categories.momentum.metrics.rsiChange = null; missing.evaluableCount = 3; missing.fulfilledCount = 3;
const missingHtml = renderToStaticMarkup(React.createElement(detailExports.default, { evidence: missing })); assert.ok(missingHtml.includes("3/4 평가 가능")); assert.ok(missingHtml.includes("데이터 부족"));
assert.match(panel, /<details className="relative mt-2/u);
assert.doesNotMatch(panel, /<article[^>]+onClick/u, "details에서 버블링으로 종목 이동이 발생하지 않습니다.");
console.log("transition screener route validation/legacy isolation/secret-safe errors/mobile SSR/stale guard UI tests passed");
