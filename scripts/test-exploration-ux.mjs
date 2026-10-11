import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import * as React from "react";
import * as jsx from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import { selectVerifiedStock } from "../lib/search-request-isolation.mjs";
import * as directional from "../lib/directional-transition.mjs";
const items = [{ srtnCd: "000001", itmsNm: "같은이름", mrktCtg: "KOSPI" }, { srtnCd: "A000002", itmsNm: "같은이름", mrktCtg: "KOSDAQ" }];
assert.equal(selectVerifiedStock(items, { code: "000002", name: "같은이름", market: "KOSDAQ" }, "같은이름"), items[1]);
assert.throws(() => selectVerifiedStock(items, { code: "000003", name: "같은이름" }, "같은이름"), /종목코드/u);
assert.throws(() => selectVerifiedStock(items, { code: "000002", name: "다른이름" }, ""), /종목명/u);
assert.throws(() => selectVerifiedStock(items, { code: "000002", name: "같은이름", market: "KOSPI" }, ""), /시장/u);
assert.equal(selectVerifiedStock(items, null, "000002"), items[1]);
assert.equal(selectVerifiedStock(items, null, "000999"), null);
assert.equal(selectVerifiedStock(items[1], { code: "000002" }, ""), items[1]);
const compile = source => ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const detailExports = {};
const requireDetail = name => name === "react/jsx-runtime" ? jsx : name === "../lib/directional-transition.mjs" ? directional : (() => { throw new Error(name); })();
new Function("require", "exports", compile(await readFile(new URL("../components/ApproachStrengthDetails.tsx", import.meta.url), "utf8")))(requireDetail, detailExports);
const points = [90, 91, 92, 93, 95, 98].map((s, i) => ({ date: String(i), ma5: s, ma20: 100, close: s }));
for (const direction of ["golden", "dead"]) {
  const data = direction === "golden" ? points : points.map(p => ({ ...p, ma5: 200 - p.ma5, close: 200 - p.close }));
  const row = { ...directional.observeDirectionalTransition(data, "ma5", "ma20", direction), crossDirection: direction };
  const html = renderToStaticMarkup(React.createElement(detailExports.default, { row }));
  for (const text of [direction === "golden" ? "골든 접근" : "데드 접근", "연구용 상대 강도", "확률이 아닙니다", "간격 축소 속도", "단기선 기울기", "장기선 기울기", "간격 축소 지속성", "가격 위치", directional.APPROACH_SCORE_VERSION]) assert.ok(html.includes(text), text);
  const missing = renderToStaticMarkup(React.createElement(detailExports.default, { row: { ...row, components: null } }));
  assert.ok(missing.includes("임의 기여값을 표시하지 않습니다")); assert.ok(!missing.includes("/ 25점"));
}
const routeSource = await readFile(new URL("../app/api/stock/route.ts", import.meta.url), "utf8"), exports = {};
let upstream;
const oldFetch = globalThis.fetch, oldKey = process.env.DATA_GO_KR_SERVICE_KEY;
process.env.DATA_GO_KR_SERVICE_KEY = "non-sensitive-fixture";
globalThis.fetch = async url => { upstream = new URL(url); return { ok: true, json: async () => ({ response: { body: { items: { item: items } } } }) }; };
try {
  new Function("require", "exports", compile(routeSource))(name => name === "next/server" ? { NextResponse: { json: (body, init) => ({ body, status: init?.status ?? 200 }) } } : (() => { throw new Error(name); })(), exports);
  const response = await exports.GET({ url: "https://fixture/api/stock?query=000002" });
  assert.equal(upstream.searchParams.get("likeSrtnCd"), "000002"); assert.equal(upstream.searchParams.has("likeItmsNm"), false);
  assert.deepEqual(response.body.items, [items[1]]);
  assert.equal((await exports.GET({ url: "https://fixture/api/stock?query=000999" })).body.items.length, 0);
} finally { globalThis.fetch = oldFetch; if (oldKey === undefined) delete process.env.DATA_GO_KR_SERVICE_KEY; else process.env.DATA_GO_KR_SERVICE_KEY = oldKey; }
console.log("stock code/name/market guards, API code lookup, directional contribution disclosure and separation tests passed");
