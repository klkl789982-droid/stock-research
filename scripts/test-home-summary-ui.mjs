import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import * as React from "react";
import * as jsx from "react/jsx-runtime";
import { renderToStaticMarkup as html } from "react-dom/server";
import * as dates from "../lib/home-presentation.mjs";
import * as helpers from "../lib/home-dashboard.mjs";

const read = file => readFile(new URL(`../${file}`, import.meta.url), "utf8");
function compile(source, dependencies) {
  const out = {};
  new Function("require", "exports", ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText)(name => {
    if (name === "react/jsx-runtime") return jsx;
    if (name.endsWith(".module.css")) return {};
    if (name === "./WatchlistStar") return () => null;
    if (Object.hasOwn(dependencies, name)) return dependencies[name];
    throw Error(name);
  }, out);
  return out;
}
const children = node => node?.props ? React.Children.toArray(node.props.children) : [];
const find = (node, predicate) => [...(node?.props && predicate(node) ? [node] : []), ...children(node).flatMap(child => find(child, predicate))];
assert.equal(dates.homeDate("2026-10-19"), "2026.10.19");
for (const invalid of [null, "", "2026-02-30", "2026-10-19T00:00:00Z", "today"]) assert.equal(dates.homeDate(invalid), "확인 불가");
assert.equal(dates.homeTime("2026-10-18T15:00:02Z"), "2026.10.19 00:00:02 KST");
assert.equal(dates.homeTime("invalid"), "확인 불가");
for (const [state, reason, label] of [
  ["DEPLOYING", "VERCEL_DEPLOYMENT_PENDING", "배포 진행 중"],
  ["DEPLOYING", "SITE_COMMIT_DIFFERS_REPOSITORY", "현재 화면 버전 미확인"],
  ["DEPLOYING", "SITE_SNAPSHOT_DIFFERS_REPOSITORY", "데이터 반영 미확인"],
  ["DEPLOYING", null, "데이터 반영 미확인"],
  ["UNVERIFIED", "GITHUB_EVIDENCE_EXPIRED", "사이트 확인 기록 오래됨"],
  ["VERIFICATION_FAILED", "HTTP_401", "사이트 확인 실패"],
  ["DEPLOYMENT_FAILED", "VERCEL_DEPLOYMENT_FAILED", "배포 실패"],
  ["VERIFIED", null, "실제 사이트 확인 완료"],
]) assert.equal(dates.homeDeploymentLabel({ state, reason }), label);
assert.equal(dates.homeDeploymentLabel(null), "사이트 확인 불가");
const chart = compile(await read("components/DailyCandles.tsx"), {react:React}).default;
const bars=[{date:"2026-10-15",open:100,high:104,low:99,close:101},{date:"2026-10-16",open:101,high:101,low:101,close:101}];
const chartProps={title:"KOSPI",unit:"pt",source:"fixture",retry:()=>{},data:{bars,missing:[],unknown:[],invalid:[],failedPages:0}};
const chartHtml=html(React.createElement(chart,chartProps));
for(const label of ["2거래일","2026-10-16","101.00pt",'data-session="2026-10-15"',"var(--tb-positive)","<rect","가격축 pt"]) assert.ok(chartHtml.includes(label),label);
assert.ok(!html(React.createElement(chart,{...chartProps,data:null})).includes("<svg"));
assert.ok(!chartHtml.includes("NaN"));
const ranking = compile(await read("components/HomeModelRankings.tsx"), { "../lib/home-presentation.mjs": dates }).default;
const execution = compile(await read("components/HomeCloudExecutionStatus.tsx"), { "../lib/home-presentation.mjs": dates });
// Synthetic rendering fixtures only, never passed to an application store/API.
const models = ["A", "B", "C", "D"].map(model => ({ modelVersion: model + "-v1", comparisonStatus: "AVAILABLE", previousDate: "2026-10-16", top: Array.from({ length: 5 }, (_, i) => ({ code: String(i).padStart(6, "0"), name: "매우 긴 합성 종목명 " + i, rank: i + 1, score: i === 0 ? 0 : 81.234 + i, previousRank: i + 3, rankChange: 2 })) }));
const stockOpens = [], modelOpens = [];
const props = { models, limit: 5, source: "LIVE", onSelectStock: stock => stockOpens.push(stock), onOpenModel: model => modelOpens.push(model) };
for (const selectedModel of ["A","B","C","D"]) {
  const liveTree = ranking({ ...props, selectedModel }), live = html(liveTree);
  assert.equal((live.match(/data-stock-code=/g) ?? []).length, 5);
  assert.equal((live.match(/data-stock-code="000000"/g) ?? []).length, 1);
  assert.ok(live.includes(selectedModel + "-v1"));
  assert.ok(live.includes("0.00")); assert.ok(!live.includes("↑2"), "LIVE has no verified previous ranking");
  for (const button of find(liveTree, node => node.type === "button")) button.props.onClick();
  const eod = html(ranking({ ...props, selectedModel, limit: 3, source: "EOD" }));
  assert.equal((eod.match(/data-stock-code=/g) ?? []).length, 3); assert.equal((eod.match(/↑2/g) ?? []).length, 3);
  assert.ok(!html(ranking({ ...props, selectedModel, source: "EOD", models: models.map(m => ({ ...m, comparisonStatus: "UNAVAILABLE" })) })).includes("↑2"));
}
assert.equal(stockOpens.length, 20); assert.equal(stockOpens[0].code, "000000");
const source = await read("components/HomeDashboard.tsx");
let slot = 0; const updates = [];
const resources = [
  { url: "/api/home-dashboard?topN=5", version: "", data: { referenceDate: "2026-10-16", models: { referenceDate: "2026-10-16", models } }, error: false },
  { url: "/api/model-performance?view=home", version: JSON.stringify(["2026-10-16",null,null]), data: null, error: false },
  { url: "/api/daily-production-status", version: "", data: null, error: true },
  { url: "/api/private-live-execution", version: "", data: null, error: true },
];
const state = { ...React, useEffect: () => {}, useRef: value => ({ current: value }), useState: initial => { const id = slot++; return [id < resources.length ? resources[id] : initial, value => updates.push({ id, value })]; } };
const homeDependencies = { react: state, "../lib/home-dashboard.mjs": helpers, "../lib/home-presentation.mjs": dates,
  "./HomeMarketFlow": () => null, "./HomeModelRankings": { __esModule: true, default: ranking }, "./HomeTransitionCard": { __esModule: true, default: () => React.createElement("h2",null,"전환 신호") },
  "./HomeCloudExecutionStatus": { __esModule: true, ...execution },
  "./PrivateLiveDeliveryPanel": { usePrivateLiveDelivery: () => ({ data: { delivery: null }, failed: true, disabled: false }), PrivateLiveDeliveryView: () => null },
};
const dashboard = compile(source, homeDependencies).default;
const tree = dashboard({ ...props, onOpenPerformance: () => {}, onOpenTransition: () => {} });
const tabs = find(tree, node => node.props.role === "tab");
assert.equal(tabs[0].props["aria-selected"], true); assert.equal(tabs[1].props["aria-selected"], false);
const panels = find(tree, node => node.props.role === "tabpanel");
assert.equal(panels[0].props.hidden, false); assert.equal(panels[1].props.hidden, true);
const markup = html(tree);
assert.match(markup, /LIVE 결과 조회 실패/u); assert.match(markup, /Daily EOD로 자동 대체하지 않습니다/u);
assert.match(markup, /저장된 LIVE 결과/u); assert.match(markup, /현재 자동 수집 상태/u);
assert.match(markup, /실행 기록 조회 실패 · 마지막 정상 결과와 별도/u); assert.match(markup, /운영 상태 조회 실패/u);
assert.equal(find(tree, node => node.props.id === "home-operations-details")[0].props.hidden, true);
const savedDocument = globalThis.document; const focused = [];
try {
  globalThis.document = { getElementById: id => ({ focus: () => focused.push(id) }) };
  find(tree, node => node.props.role === "tablist")[0].props.onKeyDown({ key: "ArrowRight", preventDefault() {} });
  assert.deepEqual(updates.at(-1), { id: resources.length, value: "EOD" }); assert.deepEqual(focused, ["home-source-EOD"]);
} finally { if (savedDocument === undefined) delete globalThis.document; else globalThis.document = savedDocument; }
const modelSelectors = find(tree, node => node.props["aria-label"] === "모델 선택")[0];
const modelButtons = React.Children.toArray(modelSelectors.props.children);
assert.equal(modelButtons.length, 4); assert.equal(modelButtons[0].props["aria-pressed"], true);
for (const [i, letter] of ["A", "B", "C", "D"].entries()) {
  modelButtons[i].props.onClick();
  assert.equal(updates.at(-1).value, letter);
}
find(tree, node => node.type === "button" && node.props.children === "전체 순위 보기 →")[0].props.onClick();
assert.equal(modelOpens.at(-1), "A-v1");
assert.match(markup, /전환 신호/);
assert.ok(!source.includes("setArchiveOpen"), "the transition action is present without expanding history");
// Exercise the real transport effect without a browser or live endpoint.
const originalFetch = globalThis.fetch, originalWindow = globalThis.window, originalNow = Date.now;
const requests = [], timers = new Set(), visibility = new Set(), effects = [];
let clock = 0;
try {
  globalThis.document = { hidden: true, addEventListener: (_,fn) => visibility.add(fn), removeEventListener: (_,fn) => visibility.delete(fn) };
  globalThis.window = { setInterval: fn => { timers.add(fn); return fn; }, clearInterval: fn => timers.delete(fn) };
  Date.now = () => clock;
  globalThis.fetch = async (url, options) => { requests.push([url,options.signal]); return { ok:true, json: async () => ({}) }; };
  const renderRequest = compile(source + "\nexport {useResource};", { ...homeDependencies, react: {
    ...state, useEffect: fn => effects.push(fn), useState: () => [null, () => {}],
  }}).useResource;
  const mount = (url, interval, version) => { renderRequest(url, interval, version); return effects.pop()(); };
  const visible = () => { document.hidden = false; for (const listener of visibility) listener(); };
  const settle = () => new Promise(resolve => setImmediate(resolve));
  assert.equal(mount("/archive",0,null), undefined, "collapsed archive has no fetch or timer");
  const staticCleanup = mount("/performance",0,"snapshot-date-hash-commit");
  const liveCleanup = mount("/live",60_000,"");
  assert.equal(requests.length,0, "first paint in a hidden tab is idle");
  visible(); await settle();
  visible(); await settle();
  for (let i=0; i<60; i++) { clock += 60_000; for (const fn of timers) fn(); await settle(); }
  assert.equal(requests.filter(([url])=>url==="/performance").length,1, "unchanged input has one read per home visit");
  assert.equal(requests.filter(([url])=>url==="/live").length,61, "initial head plus one per visible minute");
  document.hidden=true; clock+=60_000; for (const fn of timers) fn(); await settle();
  assert.equal(requests.length,62);
  visible(); await settle(); assert.equal(requests.length,63, "foreground after a missed heartbeat refreshes the live head");
  staticCleanup(); assert.equal(requests[0][1].aborted,true);
  const revisedCleanup = mount("/performance",0,"next-deployment");
  await settle(); assert.equal(requests.filter(([url])=>url==="/performance").length,2);
  revisedCleanup(); liveCleanup(); assert.equal(timers.size,0); assert.equal(visibility.size,0);
} finally {
  globalThis.fetch=originalFetch; Date.now=originalNow;
  if (savedDocument === undefined) delete globalThis.document; else globalThis.document=savedDocument;
  if (originalWindow === undefined) delete globalThis.window; else globalThis.window=originalWindow;
}
console.log("Home summary: all four selectable stored models, Live5 / EOD3, verified rank changes, navigation, freshness guard and primary transition action passed");
