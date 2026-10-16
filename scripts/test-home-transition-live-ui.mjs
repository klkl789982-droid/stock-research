import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, copyFile, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import * as React from "react";
import * as jsx from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import * as directional from "../lib/directional-transition.mjs";
import * as evidencePolicy from "../lib/transition-evidence-policy.mjs";
import * as homeHelpers from "../lib/home-dashboard.mjs";
import * as liveTiming from "../lib/intraday-model-top-time-policy.mjs";
import { createLiveTransitionStore } from "../lib/live-transition-store.mjs";
import { assertLiveFixtureArchive } from "./fixtures/live-transition/integrity.mjs";

const read = (file) => readFile(new URL(`../${file}`, import.meta.url), "utf8");
const [cardSource, detailsSource, dashboardSource, pageSource, stockSource, transitionSource] = await Promise.all([
  "components/HomeTransitionCard.tsx", "components/LiveTransitionDetails.tsx", "components/HomeDashboard.tsx", "app/page.tsx", "components/StockScreenerPanel.tsx", "components/TransitionScreenerPanel.tsx",
].map(read));
const compile = (source, dependencies) => {
  const exports = {};
  const require = (name) => {
    if (name === "react/jsx-runtime") return jsx;
    if (Object.hasOwn(dependencies, name)) return dependencies[name];
    throw new Error(`Unexpected Home UI dependency: ${name}`);
  };
  new Function("require", "exports", ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText)(require, exports);
  return exports;
};
const harness = (overrides = []) => {
  let index = 0;
  const states = [], effects = [], updates = [];
  const hooks = { ...React,
    useState: (initial) => { const slot = index++; const value = slot in overrides ? overrides[slot] : typeof initial === "function" ? initial() : initial; states.push(value); return [value, (next) => updates.push({ slot, value: next })]; },
    useEffect: (callback) => effects.push(callback), useRef: (value) => ({ current: value }), useCallback: (fn) => fn, useMemo: (fn) => fn(),
  };
  return { hooks, states, effects, updates };
};
const details = compile(detailsSource, {});
const refreshCalls = [];
const refresh = { useLiveTransitionRevalidation: (enabled) => { refreshCalls.push(enabled); return { rootRef: { current: null }, refreshVersion: 0 }; } };
const loadCard = (hooks = harness().hooks) => compile(cardSource, { "../lib/intraday-model-top-time-policy.mjs": liveTiming, react: hooks, "./LiveTransitionDetails": details, "../lib/directional-transition.mjs": directional, "./useLiveTransitionRevalidation": refresh });
const card = loadCard();
const children = (node) => node && typeof node === "object" && node.props ? React.Children.toArray(node.props.children) : [];
const find = (node, predicate) => [ ...(node && typeof node === "object" && node.props && predicate(node) ? [node] : []), ...children(node).flatMap((child) => find(child, predicate)) ];
const html = (element) => renderToStaticMarkup(element);
const noOp = () => {};
const callbacks = { onSelectStock: noOp, onOpenTransition: noOp };
// Preserve the frozen 14:30 archive, and prove it cannot feed current Home.
// Current UI fixtures below are synthetic, never rewritten production artifacts.
const snapshot = JSON.parse(await read("scripts/fixtures/live-transition/2026-10-13.json"));
const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "tb-home-live-test-"));
try {
  for (const [key, archive] of Object.entries(snapshot.archives)) {
    const relative = archive.path;
    assertLiveFixtureArchive(key, await readFile(new URL(`../${relative}`, import.meta.url)), archive);
    const target = path.join(fixtureRoot, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(fileURLToPath(new URL(`../${relative}`, import.meta.url)), target);
  }
  for (const [relative, value] of [["data/intraday-signals/model-top/latest.json", snapshot.latest], ["data/trading-calendar/status.json", snapshot.calendar]]) {
    const target = path.join(fixtureRoot, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, JSON.stringify(value));
  }
  await assert.rejects(createLiveTransitionStore({ root: fixtureRoot, now: () => new Date(snapshot.now) }), undefined, "archived 14:30 cannot masquerade as current LIVE");
} finally { await rm(fixtureRoot, { recursive: true, force: true }); }
const responses = ["5-20", "20-60"].map((pair) => ({
  mode: "LIVE", signalVersion: "intraday-model-top-official-signal-v2", observationPolicyId: "intraday-1400-v1",
  referenceDate: "2026-10-13", previousOfficialDate: "2026-10-12", modelReferenceDate: "2026-10-12", snapshotTime: "14:00:00",
  collectionStartedAt: "2026-10-13T05:00:00.000Z", collectionCompletedAt: "2026-10-13T05:02:00.000Z", ruleVersion: "synthetic-ui-only",
  pair, nearPercent: 1, totalUniverse: 4, indicatorCoverage: 4, resultCount: 4, sourceQualityGrade: "SYNTHETIC", isPartialRanking: false, quarantinedCount: 0,
  source: { signalContentHash: "synthetic-signal", seedContentHash: "synthetic-seed", normalizedInputHash: "synthetic-input", isRealtime: false },
  exclusions: { dataMissing: 0, conditionNotMet: 0 }, reasonCounts: {},
  results: ["CROSS_OCCURRED", "APPROACHING", "ALREADY_ABOVE", "NONE"].map((status, index) => ({
    code: String(index + 1).padStart(6, "0"), name: "합성 검증종목", market: "KOSPI", pair, status, qualityStatus: "PROVISIONAL", missingReasons: [],
    referenceDate: "2026-10-13", modelReferenceDate: "2026-10-12", observedPrice: 100, crossRequiredPrice: 100.2, requiredAdditionalRisePercent: .2,
    quoteAsOfDate: "2026-10-13", quoteAsOfTime: "14:00:10", receivedAt: "2026-10-13T05:00:11.000Z", models: {},
    gapPercent: .1, previousGapPercent: -.1, shortSlopePercent: .1, currentShort: 100, currentLong: 99.9, previousShort: 99, previousLong: 99.1,
  })),
}));
const eod = { referenceDate: "2026-10-12", indicatorCoverage: 508, totalUniverse: 553, sourceQualityGrade: "REJECTED", pairs: ["5-20", "20-60"].map((pair) => ({ pair, states: [], directionalStates: [
  { direction: "golden", state: "APPROACHING", count: 11, examples: [{ code: "005830", name: "EOD 대표", market: "KOSPI" }] },
  { direction: "dead", state: "CONFIRMED", count: 93, examples: [] },
] })) };
assert.deepEqual(card.validateHomeLiveTransitionResponses(responses), responses);
for (const [name, mutate] of [
  ["archived time", (r) => { r[0].snapshotTime = "14:30:00"; r[1].snapshotTime = "14:30:00"; }],
  ["archived version", (r) => { r[0].signalVersion = "intraday-model-top-official-signal-v1"; }],
  ["wrong policy", (r) => { r[1].observationPolicyId = "intraday-1430-v1"; }],
  ["signal hash", (r) => { r[1].source.signalContentHash = "different"; }],
  ["missing signal hash", (r) => { delete r[0].source.signalContentHash; delete r[1].source.signalContentHash; }],
  ["seed hash", (r) => { r[1].source.seedContentHash = "different"; }],
  ["source hash", (r) => { r[1].source.normalizedInputHash = "different"; }],
  ["model date", (r) => { r[1].modelReferenceDate = "2026-10-13"; }],
  ["observation date", (r) => { r[1].referenceDate = "2026-10-14"; }],
  ["pair duplication", (r) => { r[1].pair = "5-20"; }],
  ["EOD response", (r) => { r[1].mode = "EOD"; }],
  ["wrong near threshold", (r) => { r[1].nearPercent = 2; }],
  ["row pair", (r) => { r[0].results[0].pair = "20-60"; }],
  ["row quality", (r) => { r[0].results[0].qualityStatus = "UNAVAILABLE"; }],
  ["row date", (r) => { r[0].results[0].referenceDate = "2026-10-12"; }],
  ["row model date", (r) => { r[0].results[0].modelReferenceDate = "2026-10-13"; }],
]) {
  const changed = structuredClone(responses); mutate(changed);
  assert.throws(() => card.validateHomeLiveTransitionResponses(changed), undefined, name);
}
const liveHtml = html(React.createElement(card.HomeLiveTransitionSummary, { responses, ...callbacks }));
for (const text of ["2026-10-13", "2026-10-12", "5/20", "20/60", "골든크로스 진입 · 잠정", "근접 후보 · 잠정", "기존 상단 유지", "조건 미충족", "교차 경계", "필요 추가 상승률", "KST", "합성 검증종목"]) assert.ok(liveHtml.includes(text), text);
assert.ok(!liveHtml.includes("데드크로스"), "LIVE must not reuse EOD directional categories");
assert.ok(!liveHtml.includes("골든크로스 확인"), "provisional LIVE cannot show EOD confirmation");
assert.ok(!liveHtml.includes("11종목"), "the user's old EOD count must not masquerade as LIVE");
const opens = [], selects = [];
const liveTree = card.HomeLiveTransitionSummary({ responses, onOpenTransition: (...args) => opens.push(args), onSelectStock: (stock) => selects.push(stock) });
for (const button of find(liveTree, (node) => node.type === "button")) button.props.onClick?.();
for (const pair of ["5-20", "20-60"]) for (const state of ["CROSS_OCCURRED", "APPROACHING", "ALREADY_ABOVE", "NONE"]) assert.ok(opens.some((args) => args[0] === pair && args[1] === state && args[3] === "LIVE"), `${pair}:${state} must open LIVE`);
assert.ok(opens.every((args) => args[3] === "LIVE"));
for (const stockButton of find(liveTree, (node) => typeof node.type === "function" && node.props.stock)) { const button = stockButton.type(stockButton.props); button.props.onClick(); }
assert.ok(selects.some((stock) => stock.code === "000001"));
const eodTree = card.HomeEodTransitionSummary({ transitions: eod, ...callbacks, onOpenTransition: (...args) => opens.push(args) });
const eodHtml = html(eodTree);
assert.ok(eodHtml.includes("11종목") && eodHtml.includes("93종목") && eodHtml.includes("데드크로스 확인"));
for (const button of find(eodTree, (node) => node.type === "button")) button.props.onClick?.();
assert.ok(opens.some((args) => args[1] === "CONFIRMED" && args[2] === "dead" && args[3] === "EOD"));

// Render the actual HomeDashboard with its actual new card, rather than only
// testing the stock-detail card that missed the user's screenshot previously.
const resources = [
  { url: "/api/home-dashboard?topN=5", data: { referenceDate: "2026-10-12", models: null, transitions: eod, calendar: null, liveStatus: null }, error: false },
  { url: "/api/model-performance", data: null, error: false },
  { url: "/api/daily-production-status", data: null, error: false },
  { url: "/api/intraday-model-top?model=B&limit=1", data: null, error: false },
];
const dashboard = compile(dashboardSource, { react: harness(resources).hooks, "../lib/home-dashboard.mjs": homeHelpers, "../lib/intraday-model-top-time-policy.mjs": liveTiming, "./HomeTransitionCard": { __esModule: true, ...loadCard() } });
const dashboardHtml = html(React.createElement(dashboard.default, { ...callbacks, onOpenModel: noOp, onOpenPerformance: noOp }));
assert.match(dashboardHtml, /aria-pressed="true"[^>]*>LIVE · 14:00 저장 관측/u);
assert.match(dashboardHtml, /aria-pressed="false"[^>]*>EOD · 확정 일봉 비교/u);
assert.ok(!dashboardHtml.includes("11종목"), "actual homepage defaults to LIVE despite EOD summary availability");
assert.ok(dashboardHtml.includes("장중 잠정") || dashboardHtml.includes("LIVE"));
assert.ok(refreshCalls.includes(true), "homepage uses the shared freshness revalidation hook");

// Transport can resolve after abort; discarded HOME requests cannot publish
// stale data or fall back to the available EOD summary.
const originalFetch = globalThis.fetch;
const pending = [];
const settle = () => new Promise((resolve) => setImmediate(resolve));
try {
  globalThis.fetch = (url, options) => new Promise((resolve) => pending.push({ url, signal: options.signal, resolve }));
  const h = harness(); const liveModule = loadCard(h.hooks);
  liveModule.HomeLiveTransitionResults(callbacks);
  const cleanup = h.effects[0]();
  assert.equal(pending.length, 2);
  for (const p of pending) { const q = new URL(p.url, "http://fixture").searchParams; assert.equal(q.get("mode"), "LIVE"); assert.equal(q.get("state"), "all"); assert.equal(q.get("nearPercent"), "1"); }
  cleanup();
  pending[0].resolve({ ok: true, json: async () => responses[0] });
  pending[1].resolve({ ok: true, json: async () => responses[1] });
  await settle(); assert.equal(h.updates.length, 0);
  const failed = harness(); const failureModule = loadCard(failed.hooks);
  failureModule.HomeLiveTransitionResults(callbacks); failed.effects[0]();
  const reason = "다음 14:00 관측 시점이 지났지만 새 TOP LIVE 자료가 없어 LIVE 판정을 중단했습니다.";
  pending[2].resolve({ ok: false, json: async () => ({ error: { message: reason, diagnostic: "LIVE_SNAPSHOT_STALE" } }) });
  pending[3].resolve({ ok: true, json: async () => responses[1] });
  await settle();
  assert.ok(JSON.stringify(failed.updates).includes(reason));
  assert.equal(pending.length, 4, "LIVE failure must not fetch an EOD fallback");
  assert.ok(!JSON.stringify(failed.updates).includes("합성 검증종목"), "one successful pair must not mask a failed pair");
  const successful = harness(); const successModule = loadCard(successful.hooks);
  successModule.HomeLiveTransitionResults(callbacks); successful.effects[0]();
  pending[4].resolve({ ok: true, json: async () => responses[0] });
  pending[5].resolve({ ok: true, json: async () => responses[1] });
  await settle(); assert.deepEqual(successful.updates, [{ slot: 0, value: responses }]);
  const mixed = harness(); const mixedModule = loadCard(mixed.hooks);
  mixedModule.HomeLiveTransitionResults(callbacks); mixed.effects[0]();
  pending[6].resolve({ ok: true, json: async () => responses[0] });
  pending[7].resolve({ ok: true, json: async () => ({ ...responses[1], source: { ...responses[1].source, signalContentHash: "changed-during-requests" } }) });
  await settle(); assert.equal(mixed.updates.length, 1); assert.equal(mixed.updates[0].slot, 1);
  assert.match(mixed.updates[0].value, /일치하지 않아/u);

} finally { globalThis.fetch = originalFetch; }

// Exercise the actual callback and prop chain from app/page through both
// screener wrappers. No text-only assertion can catch the previous mode loss.
const savedWindow = globalThis.window, savedAnimation = globalThis.requestAnimationFrame;
try {
  globalThis.window = { location: { href: "http://fixture/" }, history: { state: {}, replaceState: noOp } };
  globalThis.requestAnimationFrame = noOp;
  const homeMarker = () => null, screenerMarker = () => null;
  const appHooks = harness();
  const appDependencies = { react: appHooks.hooks,
    "../components/HomeDashboard": { __esModule: true, default: homeMarker },
    "../components/StockScreenerPanel": { __esModule: true, default: screenerMarker },
    "../lib/search-technical-strength.mjs": { buildSearchTechnicalStrength: () => ({}) },
    "../lib/search-market-analysis.mjs": { buildSearchMarketAnalysis: () => ({}) },
    "../lib/kis-quote-display-policy.mjs": { isVerifiedKisRealtimeQuote: () => false },
  };
  for (const match of pageSource.matchAll(/from "([^"]+)"/gu)) if (!Object.hasOwn(appDependencies, match[1]) && match[1] !== "react") appDependencies[match[1]] = { __esModule: true, default: noOp };
  const app = compile(pageSource, appDependencies);
  const homeElement = find(app.default(), (node) => node.type === homeMarker)[0];
  assert.ok(homeElement);
  for (const mode of ["LIVE", "EOD"]) {
    homeElement.props.onOpenTransition("20-60", "APPROACHING", "golden", mode);
    const entry = appHooks.updates.filter((update) => update.value?.tab === "transition").at(-1).value;
    assert.deepEqual(entry, { tab: "transition", pair: "20-60", state: "APPROACHING", direction: "golden", mode });
    const rerenderStates = [...appHooks.states]; rerenderStates[3] = "screener"; rerenderStates[6] = entry;
    const rerender = compile(pageSource, { ...appDependencies, react: harness(rerenderStates).hooks });
    const stockElement = find(rerender.default(), (node) => node.type === screenerMarker)[0];
    assert.equal(stockElement.props.initialMode, mode); assert.ok(stockElement.key.includes(mode));
    const transitionMarker = () => null;
    const stock = compile(stockSource, { react: harness().hooks, "./TransitionScreenerPanel": { __esModule: true, default: transitionMarker } });
    const transitionElement = find(stock.default(stockElement.props), (node) => node.type === transitionMarker)[0];
    assert.equal(transitionElement.props.initialMode, mode);
    const transition = compile(transitionSource, { react: harness().hooks, "./LiveTransitionDetails": details, "./LiveTransitionScreenerPanel": { __esModule: true, default: noOp }, "./ApproachStrengthDetails": { __esModule: true, default: noOp }, "./TransitionEvidenceDetails": { __esModule: true, default: noOp }, "../lib/directional-transition.mjs": directional, "../lib/transition-evidence-policy.mjs": evidencePolicy });
    const finalTree = transition.default(transitionElement.props);
    const selector = find(finalTree, (node) => node.type === details.TransitionModeSelector)[0];
    assert.equal(selector.props.mode, mode, "explicit Home mode must beat the legacy non-all EOD heuristic");
  }
} finally { if (savedWindow === undefined) delete globalThis.window; else globalThis.window = savedWindow; if (savedAnimation === undefined) delete globalThis.requestAnimationFrame; else globalThis.requestAnimationFrame = savedAnimation; }
console.log("Home LIVE transition: actual homepage default, live counts/prices, EOD comparison, same-snapshot validation, abort/error isolation, and real callback-to-screener mode chain passed");
