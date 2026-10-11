import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import * as React from "react";
import * as jsx from "react/jsx-runtime";

const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
const panel = await readFile(new URL("../components/StockScreenerPanel.tsx", import.meta.url), "utf8");
const route = await readFile(new URL("../app/api/screener/route.ts", import.meta.url), "utf8");

assert.match(page, /"home" \| "models" \| "screener"/u);
assert.match(page, /openScreenerFromNavigation/u);
assert.match(page, /navigationButtons\(true\)/u, "모바일도 공통 메뉴를 사용한다");
assert.match(page, /navigationButtons\(false\)/u, "데스크톱도 공통 메뉴를 사용한다");
assert.match(page, /<StockScreenerPanel onSelectStock=\{handleSearch\}/u, "기존 검색 handler로 상세 이동한다");
assert.doesNotMatch(page, /\['▽', '스크리닝'\].*준비 중/u);
assert.match(panel, /\/api\/screener/u);
assert.match(panel, /조건 초기화/u);
assert.match(panel, /모델 데이터 \{data\.modelCoverage\}\/\{data\.totalUniverse\}/u);
assert.match(panel, /onSelectStock\(\{ code: row\.code, name: row\.name, market: row\.market \}\)/u);
assert.match(panel, /overflow-x-auto/u);
assert.match(panel, /AbortController/);
assert.match(panel, /request !== sequence.current/);
assert.match(route, /"data", "history"/u);
assert.doesNotMatch(route, /intraday|KIS|realtime/iu, "스크리너는 Daily EOD만 사용한다");

// An upstream request may resolve despite abort. The newer filter must win.
const callbacks = [], updates = [], pending = [];
let index = 0;
const exports = {}, require = (name) => {
  if (name === "react/jsx-runtime") return jsx;
  if (name === "./TransitionScreenerPanel") return { default: () => null };
  if (name === "react") return { ...React, useEffect: () => {}, useCallback: (fn) => { callbacks.push(fn); return fn; }, useRef: (value) => ({ current: value }),
    useState: (initial) => { const slot = index++; return [initial, (value) => { if (slot === 1) updates.push(value); }]; } };
  throw new Error(name);
};
new Function("require", "exports", ts.transpileModule(panel, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText)(require, exports);
exports.default({ onSelectStock: () => {} });
const originalFetch = globalThis.fetch;
try {
  globalThis.fetch = (_url, options) => new Promise((resolve) => pending.push({ resolve, signal: options.signal }));
  const first = callbacks[0]({ model: "A-v1", sort: "rank", direction: "asc" });
  const second = callbacks[0]({ model: "B-v1", sort: "rank", direction: "asc" });
  assert.equal(pending[0].signal.aborted, true);
  pending[1].resolve({ ok: true, json: async () => ({ selectedModel: "B-v1" }) }); await second;
  pending[0].resolve({ ok: true, json: async () => ({ selectedModel: "A-v1" }) }); await first;
  assert.deepEqual(updates, [{ selectedModel: "B-v1" }]);
} finally { globalThis.fetch = originalFetch; }

console.log("PC·모바일 스크리닝 내비게이션 및 UI 연결 테스트 통과");
