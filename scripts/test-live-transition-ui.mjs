import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import * as React from "react";
import * as jsx from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import * as directional from "../lib/directional-transition.mjs";
import * as evidencePolicy from "../lib/transition-evidence-policy.mjs";

const read = (file) => readFile(new URL(`../components/${file}.tsx`, import.meta.url), "utf8");
const [detailsSource, liveSource, wrapperSource, researchSource] = await Promise.all(["LiveTransitionDetails", "LiveTransitionScreenerPanel", "TransitionScreenerPanel", "StockResearchPanel"].map(read));
const revalidationSource = await readFile(new URL("../components/useLiveTransitionRevalidation.ts", import.meta.url), "utf8");
const compile = (source, dependencies = {}) => {
  const exports = {};
  const require = (name) => {
    if (name in dependencies) return dependencies[name];
    if (name === "react/jsx-runtime") return jsx;
    throw new Error(`Unexpected UI dependency: ${name}`);
  };
  new Function("require", "exports", ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText)(require, exports);
  return exports;
};
const details = compile(detailsSource);
const harness = (states = []) => {
  let index = 0;
  const effects = [], updates = [];
  const hooks = { ...React,
    useState: (initial) => { const slot = index++; return [slot in states ? states[slot] : typeof initial === "function" ? initial() : initial, (value) => updates.push({ slot, value })]; },
    useEffect: (callback) => effects.push(callback), useCallback: (callback) => callback, useRef: (value) => ({ current: value }),
  };
  return { hooks, effects, updates };
};
const loadRevalidation = (hooks) => compile(revalidationSource, { react: hooks });
const loadLive = (hooks) => compile(liveSource, { react: hooks, "./LiveTransitionDetails": details, "./useLiveTransitionRevalidation": loadRevalidation(hooks) });
const loadResearch = (hooks) => compile(researchSource, { react: hooks, "./LiveTransitionDetails": details, "../lib/directional-transition.mjs": directional, "./useLiveTransitionRevalidation": loadRevalidation(hooks) });
const loadWrapper = (hooks) => compile(wrapperSource, { react: hooks, "./LiveTransitionDetails": details, "./LiveTransitionScreenerPanel": { __esModule: true, default: () => React.createElement("p", null, "LIVE branch") }, "./ApproachStrengthDetails": { __esModule: true, default: () => null }, "./TransitionEvidenceDetails": { __esModule: true, default: () => null }, "../lib/directional-transition.mjs": directional, "../lib/transition-evidence-policy.mjs": evidencePolicy });
const row = {
  code: "000660", name: "검증종목", market: "KOSPI", referenceDate: "2026-10-13", modelReferenceDate: "2026-10-12", qualityStatus: "PROVISIONAL", missingReasons: [],
  models: Object.fromEntries(["A", "B", "C", "D"].map((model) => [`${model}-v1`, { score: 81.25, rank: 2 }])),
  observedPrice: 100, quoteAsOfDate: "20261013", quoteAsOfTime: "143017", receivedAt: "2026-10-13T05:30:20.000Z", pair: "5-20", status: "APPROACHING",
  gapPercent: -0.01, previousGapPercent: -0.04, shortSlopePercent: 0.2, currentShort: 99.9, currentLong: 100, previousShort: 99.7, previousLong: 100,
  crossRequiredPrice: 100.1234567, requiredAdditionalRisePercent: 0.1234567,
};
const data = {
  mode: "LIVE", referenceDate: row.referenceDate, previousOfficialDate: row.modelReferenceDate, modelReferenceDate: row.modelReferenceDate, snapshotTime: "14:30:00",
  collectionStartedAt: "2026-10-13T05:30:00.000Z", collectionCompletedAt: "2026-10-13T05:34:00.000Z", ruleVersion: "live-golden-transition-v1", nearPercent: 1,
  totalUniverse: 3, indicatorCoverage: 2, quarantinedCount: 0, sourceQualityGrade: "PROVISIONAL", isPartialRanking: true, resultCount: 1, results: [row],
  exclusions: { dataMissing: 1, conditionNotMet: 1 }, reasonCounts: { MISSING_HISTORY: 1 }, source: {},
};
const filters = { pair: "5-20", nearPercent: "1", state: "candidates", market: "all" };
const renderLive = (states) => { const { hooks } = harness(states); return renderToStaticMarkup(React.createElement(loadLive(hooks).LiveTransitionResults, { filters, page: 0, onPageChange: () => {}, onSelectStock: () => {} })); };
const html = renderLive([data, null, 0]);
for (const text of ["근접 후보 · 잠정", "교차 경계가 초과", "100.1235원", "필요 추가 상승률", "0.12%", "2026-10-13 14:30:17 KST", "EOD 2026-10-12", "81.25", "부분 집계", "저장 모델 A~D는 직전 확정 일봉 점수", "원래 계산된 경계가", "데이터 부족 제외 1", "조건 미충족 1", "MISSING_HISTORY"]) {
  assert.ok(html.includes(text), `LIVE render missing ${text}`);
}
assert.ok(html.includes("hidden overflow-x-auto xl:block"));
assert.ok(html.includes("md:grid-cols-2 xl:hidden"));
assert.doesNotMatch(html, /거래량|동시간|상승 확률 [0-9]/u);
assert.match(liveSource, /type="number" required min="0" max="5"/u);
assert.ok(liveSource.includes("key={`${search.revision}:${refreshVersion}`}"), "a new search or refresh immediately replaces old results");
assert.match(wrapperSource, /new URLSearchParams\(\{ tab: "transition", mode: "EOD" \}\)/u);
assert.ok(researchSource.includes('key={`${code}:${mode}:${nearPercent}:${mode === "LIVE" ? refreshVersion : 0}`}'));
const wrapper = loadWrapper(harness().hooks).default({ onSelectStock: () => {} });
const wrapperHtml = renderToStaticMarkup(wrapper);
assert.ok(wrapperHtml.includes("LIVE branch"));
assert.match(wrapperHtml, /aria-pressed="true"[^>]*>LIVE · 14:30 저장 관측/u);
assert.match(wrapperHtml, /aria-pressed="false"[^>]*>EOD · 확정 일봉 비교/u);
for (const [initialState, initialDirection] of [["APPROACHING", "dead"], ["CONFIRMED", "golden"], ["CROSS_OCCURRED", "all"], ["all", "dead"]]) {
  const linkedWrapper = loadWrapper(harness().hooks).default({ onSelectStock: () => {}, initialState, initialDirection });
  assert.equal(linkedWrapper.props.children[0].props.children.props.mode, "EOD", "explicit homepage EOD counts keep their data mode");
  assert.equal(linkedWrapper.props.children[1].props.initialState, initialState);
  assert.equal(linkedWrapper.props.children[1].props.initialDirection, initialDirection);
}
for (const initialMode of ["LIVE", "EOD"]) {
  const explicitWrapper = loadWrapper(harness().hooks).default({ onSelectStock: () => {}, initialState: "CROSS_OCCURRED", initialDirection: "golden", initialMode });
  assert.equal(explicitWrapper.props.children[0].props.children.props.mode, initialMode, "explicit home mode overrides legacy EOD inference");
  assert.ok(explicitWrapper.props.children[1].key.startsWith(`${initialMode}:`));
}
const explicitAllEod = loadWrapper(harness().hooks).default({ onSelectStock: () => {}, initialMode: "EOD" });
assert.equal(explicitAllEod.props.children[0].props.children.props.mode, "EOD");
const stockWrapper = loadResearch(harness().hooks).default({ code: row.code });
assert.equal(stockWrapper.props.children[2].props.mode, "LIVE");
assert.equal(stockWrapper.props.children[2].key, "000660:LIVE:1:0");
const refreshedLiveHarness = harness([2, filters, { filters, revision: 1 }, 2]);
const refreshedLiveWrapper = loadLive(refreshedLiveHarness.hooks).default({ onSelectStock: () => {} });
assert.equal(refreshedLiveWrapper.props.children[1].key, "1:2");
assert.equal(refreshedLiveWrapper.props.children[1].props.page, 2, "refresh preserves pagination outside the remounted request view");
const nextRefreshedLiveWrapper = loadLive(harness([3, filters, { filters, revision: 1 }, 2]).hooks).default({ onSelectStock: () => {} });
assert.equal(nextRefreshedLiveWrapper.props.children[1].key, "1:3");
assert.equal(nextRefreshedLiveWrapper.props.children[1].props.page, 2);
const filterForm = refreshedLiveWrapper.props.children[0].props.children.find((element) => element?.type === "form");
filterForm.props.onSubmit({ preventDefault: () => {} });
assert.equal(refreshedLiveHarness.updates.find((update) => update.slot === 3).value, 0, "a new filter search resets pagination");
const refreshedStockWrapper = loadResearch(harness(["LIVE", 2, "1", "1"]).hooks).default({ code: row.code });
assert.equal(refreshedStockWrapper.props.children[2].key, "000660:LIVE:1:2");
const eodStockWrapper = loadResearch(harness(["EOD", 2, "1", "1"]).hooks).default({ code: row.code });
assert.equal(eodStockWrapper.props.children[2].key, "000660:EOD:1:0", "EOD is not periodically remounted");

const reason = "14:30 관측 스냅샷이 최신 관측일보다 오래되어 LIVE 전환 신호를 표시할 수 없습니다.";
const failureHtml = renderLive([null, reason, 0]);
assert.ok(failureHtml.includes(reason));
assert.ok(failureHtml.includes("EOD · 확정 일봉 비교"));
assert.ok(!failureHtml.includes("검증종목"));
const emptyHtml = renderLive([{ ...data, resultCount: 0, results: [] }, null, 0]);
assert.ok(emptyHtml.includes("현재 조건에 해당하는 계산 가능 종목이 없습니다."));
const rulesHtml = renderToStaticMarkup(React.createElement(details.LiveTransitionRules, { nearPercent: 1 }));
for (const text of ["직전 단기선 ≤ 장기선", "간격 축소", "양의 단기선 기울기", "1% 이하", "주문 가능한 최소 가격이 아닙니다", "스트리밍이 아닙니다", "되돌아갈 수", "경계와 정확히 같은 값"]) assert.ok(rulesHtml.includes(text), text);
assert.equal(details.liveStatusLabel("ALREADY_ABOVE"), "기존 상단 유지");
assert.equal(details.liveStatusLabel("CROSS_OCCURRED"), "골든크로스 진입 · 잠정");
assert.equal(details.liveStatusLabel("NONE"), "조건 미충족");

const pageRows = Array.from({ length: 65 }, (_, index) => ({ ...row, code: String(index).padStart(6, "0"), name: `page-row-${index}` }));
const retainedPage = loadLive(harness([{ ...data, results: pageRows, resultCount: 65 }, null]).hooks).LiveTransitionResults({ filters, page: 2, onPageChange: () => {}, onSelectStock: () => {} });
const retainedPageHtml = renderToStaticMarkup(retainedPage);
assert.ok(retainedPageHtml.includes("page-row-60"));
assert.ok(!retainedPageHtml.includes("page-row-0<"));
const shrinkHarness = harness([data, null]);
const clampedPages = [];
const shrunkPage = loadLive(shrinkHarness.hooks).LiveTransitionResults({ filters, page: 2, onPageChange: (page) => clampedPages.push(page), onSelectStock: () => {} });
assert.ok(renderToStaticMarkup(shrunkPage).includes("검증종목"), "shorter refreshed results render the last valid page immediately");
shrinkHarness.effects[1]();
assert.deepEqual(clampedPages, [0], "shorter refreshed results also clamp the stored page");

const researchResults = ["5-20", "20-60"].map((pair) => ({ pair, referenceDate: data.referenceDate, modelReferenceDate: data.modelReferenceDate, snapshotTime: data.snapshotTime, rows: [{ ...row, pair }], error: null, excluded: false }));
const researchHtml = renderToStaticMarkup(React.createElement(loadResearch(harness([{ code: row.code, mode: "LIVE", results: researchResults }]).hooks).StockResearchResults, { code: row.code, mode: "LIVE", nearPercent: "1" }));
assert.ok(researchHtml.includes("모델 기준일 2026-10-12"));
assert.ok(!researchHtml.includes("모델 기준일 2026-10-13"));
assert.ok(researchHtml.includes("관측일 이전의 확정 EOD 저장 점수"));
const staleResearchHtml = renderToStaticMarkup(React.createElement(loadResearch(harness([{ code: "005930", mode: "LIVE", results: researchResults }]).hooks).StockResearchResults, { code: row.code, mode: "LIVE", nearPercent: "1" }));
assert.ok(!staleResearchHtml.includes("81.25"), "another stock's scores must never appear");
assert.ok(staleResearchHtml.includes("조회 중"));
const researchFailureHtml = renderToStaticMarkup(React.createElement(loadResearch(harness([{ code: row.code, mode: "LIVE", results: researchResults.map((result) => ({ ...result, rows: [], error: reason, modelReferenceDate: null, referenceDate: null })) }]).hooks).StockResearchResults, { code: row.code, mode: "LIVE", nearPercent: "1" }));
assert.ok(researchFailureHtml.includes(reason));
assert.ok(!researchFailureHtml.includes("81.25"));

// Simulate a transport that ignores abort: closing a mode or changing filters must
// prevent the previous request from publishing data, even after it resolves.
const originalFetch = globalThis.fetch;
const pending = [];
const settle = () => new Promise((resolve) => setImmediate(resolve));
try {
  globalThis.fetch = (url, options) => new Promise((resolve) => pending.push({ url, signal: options.signal, resolve }));
  const old = harness();
  loadLive(old.hooks).LiveTransitionResults({ filters, page: 0, onPageChange: () => {}, onSelectStock: () => {} });
  const oldCleanup = old.effects[0]();
  assert.ok(pending[0].url.includes("mode=LIVE"));
  oldCleanup();
  assert.equal(pending[0].signal.aborted, true);
  const latest = harness();
  loadLive(latest.hooks).LiveTransitionResults({ filters: { ...filters, pair: "20-60" }, page: 0, onPageChange: () => {}, onSelectStock: () => {} });
  const latestCleanup = latest.effects[0]();
  pending[1].resolve({ ok: true, json: async () => ({ ...data, results: [{ ...row, pair: "20-60" }] }) });
  await settle();
  pending[0].resolve({ ok: true, json: async () => data });
  await settle();
  assert.equal(old.updates.length, 0);
  assert.equal(latest.updates.filter((update) => update.slot === 0).length, 1);
  assert.equal(latest.updates[0].value.results[0].pair, "20-60");
  latestCleanup();

  const failure = harness();
  loadLive(failure.hooks).LiveTransitionResults({ filters, page: 0, onPageChange: () => {}, onSelectStock: () => {} });
  failure.effects[0]();
  pending[2].resolve({ ok: false, json: async () => ({ error: { message: reason, diagnostic: "STALE" } }) });
  await settle();
  assert.deepEqual(failure.updates, [{ slot: 1, value: reason }]);
  assert.equal(pending.length, 3, "LIVE failure must not fetch an EOD fallback");

  const wrongPair = harness();
  loadLive(wrongPair.hooks).LiveTransitionResults({ filters, page: 0, onPageChange: () => {}, onSelectStock: () => {} });
  wrongPair.effects[0]();
  pending[3].resolve({ ok: true, json: async () => ({ ...data, results: [{ ...row, pair: "20-60" }] }) });
  await settle();
  assert.equal(wrongPair.updates[0].slot, 1);
  assert.ok(wrongPair.updates[0].value.includes("검증할 수 없습니다"));

  const research = harness();
  loadResearch(research.hooks).StockResearchResults({ code: row.code, mode: "LIVE", nearPercent: "1" });
  const researchCleanup = research.effects[0]();
  assert.ok(pending[4].url.includes("mode=LIVE"));
  assert.ok(pending[4].url.includes("state=all"));
  assert.ok(pending[4].url.includes("code=000660"));
  researchCleanup();
  pending[4].resolve({ ok: true, json: async () => data });
  pending[5].resolve({ ok: true, json: async () => ({ ...data, results: [{ ...row, pair: "20-60" }] }) });
  await settle();
  assert.equal(research.updates.length, 0);

  const eod = harness();
  loadResearch(eod.hooks).StockResearchResults({ code: row.code, mode: "EOD", nearPercent: "1" });
  const eodCleanup = eod.effects[0]();
  assert.ok(pending[6].url.includes("mode=EOD"));
  assert.ok(pending[6].url.includes("rules=directional-v2"));
  assert.ok(!pending[6].url.includes("nearPercent"));
  eodCleanup();
} finally { globalThis.fetch = originalFetch; }
// Revalidate on the existing TOP cadence, window/tab return, and return from
// the app's mounted-but-hidden screener. Do not update after cleanup or in EOD.
const savedGlobals = Object.fromEntries(["window", "document", "MutationObserver"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
const listeners = { window: new Map(), document: new Map() };
let intervalCallback, intervalDelay, clearedInterval, observerCallback, observerDisconnected = false, hiddenAncestor = false;
const observedNodes = [];
const parentNode = { parentElement: null };
const rootNode = { parentElement: parentNode, closest: () => hiddenAncestor ? parentNode : null };
try {
  globalThis.window = {
    setInterval: (callback, delay) => { intervalCallback = callback; intervalDelay = delay; return 7; },
    clearInterval: (id) => { clearedInterval = id; },
    addEventListener: (name, callback) => listeners.window.set(name, callback),
    removeEventListener: (name, callback) => { if (listeners.window.get(name) === callback) listeners.window.delete(name); },
  };
  globalThis.document = {
    visibilityState: "visible",
    addEventListener: (name, callback) => listeners.document.set(name, callback),
    removeEventListener: (name, callback) => { if (listeners.document.get(name) === callback) listeners.document.delete(name); },
  };
  globalThis.MutationObserver = class {
    constructor(callback) { observerCallback = callback; }
    observe(node, options) { observedNodes.push({ node, options }); }
    disconnect() { observerDisconnected = true; }
  };
  const refreshing = harness();
  const refreshHook = loadRevalidation(refreshing.hooks).useLiveTransitionRevalidation(true);
  refreshHook.rootRef.current = rootNode;
  const cleanup = refreshing.effects[0]();
  assert.equal(intervalDelay, 60_000);
  assert.equal(observedNodes.length, 2);
  assert.deepEqual(observedNodes[1].options, { attributes: true, attributeFilter: ["hidden"] });
  intervalCallback();
  assert.equal(refreshing.updates.length, 1);
  globalThis.document.visibilityState = "hidden";
  intervalCallback();
  listeners.window.get("focus")();
  assert.equal(refreshing.updates.length, 1, "hidden browser tabs do not start background reloads");
  globalThis.document.visibilityState = "visible";
  listeners.document.get("visibilitychange")();
  assert.equal(refreshing.updates.length, 2, "returning to the browser tab immediately revalidates");
  hiddenAncestor = true;
  observerCallback();
  intervalCallback();
  assert.equal(refreshing.updates.length, 2);
  hiddenAncestor = false;
  observerCallback();
  assert.equal(refreshing.updates.length, 3, "returning from stock detail revalidates the mounted screener");
  listeners.window.get("focus")();
  assert.equal(refreshing.updates.length, 4);
  assert.equal(refreshing.updates.reduce((version, update) => update.value(version), 0), 4);
  cleanup();
  assert.equal(clearedInterval, 7);
  assert.equal(observerDisconnected, true);
  assert.equal(listeners.window.size + listeners.document.size, 0);
  intervalCallback();
  observerCallback();
  assert.equal(refreshing.updates.length, 4, "queued events cannot update after unmount or mode change");
  const eodRefresh = harness();
  loadRevalidation(eodRefresh.hooks).useLiveTransitionRevalidation(false);
  assert.equal(eodRefresh.effects[0](), undefined);
  assert.equal(eodRefresh.updates.length, 0);
  assert.equal(listeners.window.size + listeners.document.size, 0);
} finally {
  for (const [key, descriptor] of Object.entries(savedGlobals)) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete globalThis[key];
  }
}
console.log("LIVE transition UI: defaults, EOD comparison, dates, boundaries, errors, responsive SSR, interrupted requests, 60-second/focus/visibility revalidation, hidden-view return, and cleanup passed");
