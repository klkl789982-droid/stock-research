// Exercise the actual TOP fetch/fallback/render flow without network requests.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import * as React from "react";
import * as jsx from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import * as timing from "../lib/intraday-model-top-time-policy.mjs";
import * as overlay from "../lib/top-stocks-intraday-overlay.mjs";
import * as selection from "../lib/kis-eod-top-selection.mjs";
const source = await readFile(new URL("../components/TopStocksPanel.tsx", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
const daily = { dataMode: "historySnapshot", model: "B", modelName: "trendStrength", modelVersion: "B-v1", rankingAsOfDate: "2026-10-15", priceAsOfDate: "2026-10-15", priceBasis: "officialDailyClose", count: 1, stocks: [{ code: "000001", name: "Synthetic EOD stock", market: "KOSPI", score: 80, rank: 1, closePrice: 100, priceBasis: "officialDailyClose", priceAsOfDate: "2026-10-15" }] };
const current = { dataMode: "intradayOfficialSignal", archived: false, signalVersion: timing.CURRENT_LIVE_PROFILE.signalVersion, observationPolicyId: timing.CURRENT_LIVE_PROFILE.policyId, officialSignalTime: timing.CURRENT_LIVE_PROFILE.signalTime, model: "B", modelVersion: "B-v1", signalDate: "2026-10-16", collectionStartedAt: "2026-10-16T05:00:00Z", collectionCompletedAt: "2026-10-16T05:01:00Z", count: 1, rankingUniverse: { count: 1 }, stocks: [{ code: "000002", name: "Synthetic current stock", market: "KOSPI", score: 81, rank: 1, observedPrice: 110 }] };
const response = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
const originalFetch = globalThis.fetch;
async function run(liveResponse, eodResponse = response(200, daily), { abort = false } = {}) {
  const effects = [], values = [], calls = [], updates = [];
  let index = 0;
  const exports = {};
  const hooks = { ...React, useState: initial => { const slot = index++; if (!(slot in values)) values[slot] = typeof initial === "function" ? initial() : initial; return [values[slot], value => { values[slot] = typeof value === "function" ? value(values[slot]) : value; updates.push(slot); }]; }, useRef: value => ({ current: value }), useEffect: callback => effects.push(callback) };
  new Function("require", "exports", compiled)(name => {
    if (name === "react") return hooks;
    if (name === "react/jsx-runtime") return jsx;
    if (name === "../lib/intraday-model-top-time-policy.mjs") return timing;
    if (name === "../lib/top-stocks-intraday-overlay.mjs") return overlay;
    if (name === "../lib/kis-eod-top-selection.mjs") return selection;
    throw new Error(name);
  }, exports);
  globalThis.fetch = async url => { calls.push(url); if (url.startsWith("/api/intraday-model-top?")) return liveResponse; if (url.startsWith("/api/top-stocks?")) return eodResponse; if (url.startsWith("/api/kis-eod-top-stocks?")) return response(503, {}); throw new Error(`Unexpected request: ${url}`); };
  exports.default({});
  const cleanup = effects[0](); if (abort) cleanup();
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  index = 0;
  const html = renderToStaticMarkup(exports.default({}));
  cleanup();
  return { html, calls, values, updates };
}
try {
  let result = await run(response(200, current));
  assert.match(result.html, /Synthetic current stock/u); assert.match(result.html, /14:00 KIS 관측 신호/u); assert.doesNotMatch(result.html, /Synthetic EOD stock/u);
  assert.ok(!result.calls.some(url => url.startsWith("/api/top-stocks?")));
  result = await run(response(503, { error: { reason: "LIVE_INPUT_NOT_READY_PREVIOUS_SESSION_MISSING", currentAttempt: {
    observationPolicyId: timing.CURRENT_LIVE_PROFILE.policyId, officialSignalTime: timing.CURRENT_LIVE_PROFILE.signalTime,
    attemptDate: "2026-10-16", failureStageLabel: "수집", lastGoodDate: "2026-10-14",
  } } }));
  assert.match(result.html, /실제 시도일: 2026-10-16/u); assert.match(result.html, /수집 단계/u); assert.match(result.html, /마지막 정상 관측: 2026-10-14/u);
  assert.match(result.html, /직전 공식 EOD 입력 확인 대기/u); assert.match(result.html, /2026-10-15 공식 EOD 순위/u); assert.match(result.html, /Synthetic EOD stock/u); assert.doesNotMatch(result.html, /14:00 KIS 관측 신호/u);
  result = await run(response(503, { error: { reason: "raw-secret-exception", currentAttempt: { observationPolicyId: timing.CURRENT_LIVE_PROFILE.policyId, officialSignalTime: timing.CURRENT_LIVE_PROFILE.signalTime, attemptDate: "2026-02-30", lastGoodDate: "malformed-secret-date", failureStageLabel: "secret-stage" } } }));
  assert.match(result.html, /실제 시도일: 확인 불가/u); assert.match(result.html, /마지막 정상 관측: 없음 \/ 미확인/u); assert.doesNotMatch(result.html, /secret|2026-02-30/u);
  result = await run(response(503, { error: { currentAttempt: { observationPolicyId: "intraday-1430-v1", officialSignalTime: "14:30:00", attemptDate: "2026-10-16", failureStageLabel: "수집", lastGoodDate: "2026-10-14" } } }));
  assert.doesNotMatch(result.html, /실제 시도일|마지막 정상 관측|2026-10-14/u, "legacy diagnostics never get a current label");
  result = await run({ status: 503, ok: false, json: async () => { throw new Error("non-json outage"); } });
  assert.match(result.html, /Synthetic EOD stock/u, "an unavailable non-JSON LIVE response still allows explicit EOD fallback");
  result = await run(response(200, { ...current, officialSignalTime: "14:30:00", observationPolicyId: "intraday-1430-v1", signalVersion: "intraday-model-top-official-signal-v1", stocks: [{ ...current.stocks[0], name: "Forbidden archived stock" }] }));
  assert.match(result.html, /현재 14:00 LIVE 관측 자료를 확인할 수 없습니다/u); assert.doesNotMatch(result.html, /Forbidden archived stock/u);
  result = await run(response(503, {}), response(200, { ...daily, dataMode: "intradayOfficialSignal", stocks: [{ ...daily.stocks[0], name: "Forbidden legacy B" }] }));
  assert.doesNotMatch(result.html, /Forbidden legacy B/u); assert.match(result.html, /데이터 모드 또는 모델이 올바르지 않습니다/u);
  result = await run(response(200, current), response(200, daily), { abort: true });
  assert.doesNotMatch(result.html, /Synthetic current stock|Synthetic EOD stock/u, "aborted current request cannot publish old rows");
  console.log("14:00 TOP UI: current identity, input-wait/EOD distinction, non-JSON fallback, archive/legacy rejection and abort passed");
} finally { globalThis.fetch = originalFetch; }
