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
const ranking = compile(await read("components/HomeModelRankings.tsx"), { "../lib/home-presentation.mjs": dates }).default;
// Synthetic rendering fixtures only, never passed to an application store/API.
const models = ["A", "B", "C", "D"].map(model => ({ modelVersion: model + "-v1", comparisonStatus: "AVAILABLE", previousDate: "2026-10-16", top: Array.from({ length: 5 }, (_, i) => ({ code: String(i).padStart(6, "0"), name: "매우 긴 합성 종목명 " + i, rank: i + 1, score: i === 0 ? 0 : 81.234 + i, previousRank: i + 3, rankChange: 2 })) }));
const stockOpens = [], modelOpens = [];
const props = { models, limit: 5, source: "LIVE", onSelectStock: stock => stockOpens.push(stock), onOpenModel: model => modelOpens.push(model) };
const liveTree = ranking(props), live = html(liveTree);
assert.equal((live.match(/data-stock-code=/g) ?? []).length, 20);
assert.equal((live.match(/data-stock-code="000000"/g) ?? []).length, 4, "same stock retains each model's rank/score");
assert.ok(live.includes("0.00")); assert.ok(!live.includes("↑2"), "LIVE has no verified previous ranking");
for (const button of find(liveTree, node => node.type === "button")) button.props.onClick();
assert.deepEqual(modelOpens, ["A-v1", "B", "C", "D"]); assert.equal(stockOpens.length, 20); assert.equal(stockOpens[0].code, "000000");
const eod = html(ranking({ ...props, limit: 3, source: "EOD" }));
assert.equal((eod.match(/data-stock-code=/g) ?? []).length, 12); assert.equal((eod.match(/↑2/g) ?? []).length, 12);
assert.ok(!html(ranking({ ...props, source: "EOD", models: models.map(m => ({ ...m, comparisonStatus: "UNAVAILABLE" })) })).includes("↑2"));
const source = await read("components/HomeDashboard.tsx");
let slot = 0; const updates = [];
const resources = [
  { url: "/api/home-dashboard?topN=5", data: { referenceDate: "2026-10-16", models: { referenceDate: "2026-10-16", models } }, error: false },
  { url: "/api/model-performance", data: null, error: false },
  { url: "/api/daily-production-status", data: null, error: true },
  { url: "/api/intraday-model-top?model=B&limit=1", data: null, error: true },
];
const state = { ...React, useEffect: () => {}, useRef: value => ({ current: value }), useState: initial => { const id = slot++; return [id < 4 ? resources[id] : initial, value => updates.push({ id, value })]; } };
const dashboard = compile(source, { react: state, "../lib/home-dashboard.mjs": helpers, "../lib/home-presentation.mjs": dates,
  "./HomeModelRankings": { __esModule: true, default: ranking }, "./HomeTransitionCard": { __esModule: true, default: () => { throw Error("archive must be lazy"); } },
  "./PrivateLiveDeliveryPanel": { usePrivateLiveDelivery: () => ({ data: { delivery: null }, failed: true, disabled: false }), PrivateLiveDeliveryView: () => null },
}).default;
const tree = dashboard({ ...props, onOpenPerformance: () => {}, onOpenTransition: () => {} });
const tabs = find(tree, node => node.props.role === "tab");
assert.equal(tabs[0].props["aria-selected"], true); assert.equal(tabs[1].props["aria-selected"], false);
const panels = find(tree, node => node.props.role === "tabpanel");
assert.equal(panels[0].props.hidden, false); assert.equal(panels[1].props.hidden, true);
const markup = html(tree);
assert.match(markup, /LIVE 결과 조회 실패/u); assert.match(markup, /Daily EOD로 자동 대체하지 않습니다/u);
assert.match(markup, /현재 LIVE 실행: 확인되지 않음/u); assert.match(markup, /운영 상태 조회 실패/u);
assert.equal(find(tree, node => node.props.id === "home-operations-details")[0].props.hidden, true);
const savedDocument = globalThis.document; const focused = [];
try {
  globalThis.document = { getElementById: id => ({ focus: () => focused.push(id) }) };
  find(tree, node => node.props.role === "tablist")[0].props.onKeyDown({ key: "ArrowRight", preventDefault() {} });
  assert.deepEqual(updates.at(-1), { id: 4, value: "EOD" }); assert.deepEqual(focused, ["home-source-EOD"]);
} finally { if (savedDocument === undefined) delete globalThis.document; else globalThis.document = savedDocument; }
const css = await read("app/globals.css");
assert.match(css, /min-width: 640px[\s\S]*repeat\(2,minmax/); assert.match(css, /min-width: 1280px[\s\S]*repeat\(4,minmax/);
assert.match(css, /min-width: 640px[\s\S]*\.home-rank-list > li \{ min-height: 90px; \}/, "long names reserve equal comparison-row height, without enlarging mobile rows");
assert.match(css, /\.home-dashboard \[hidden\]/);
assert.doesNotMatch(source, /onOpenSearch|종목 검색/);
console.log("Home summary: date/KST, LIVE20/EOD12, shared stocks, scores, verified changes, navigation, default/no-fallback, unknown/failure, lazy archive, keyboard tabs and responsive rules passed");
