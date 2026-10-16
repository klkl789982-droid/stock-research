import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import * as React from "react";
import * as jsx from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import { isPublicResource } from "../lib/admin-route-policy.mjs";

const read = (file) => readFile(new URL(`../${file}`, import.meta.url), "utf8");
const [source, page, home] = await Promise.all(["components/ForecastSwingPanel.tsx", "app/forecasts/page.tsx", "app/page.tsx"].map(read));
const Link = (props) => { const anchor = { ...props }; delete anchor.prefetch; return React.createElement("a", anchor); };
function compile(hooks = React) {
  const exports = {};
  const require = (name) => {
    if (name === "react") return hooks;
    if (name === "react/jsx-runtime") return jsx;
    if (name === "next/link") return { __esModule: true, default: Link };
    throw new Error(`Unexpected UI import: ${name}`);
  };
  new Function("require", "exports", ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText)(require, exports);
  return exports;
}
const fixture = {
  schemaVersion: 1, observationPolicyId: "intraday-1400-v1", officialSignalTime: "14:00:00", status: "PREPARING", generatedAt: "2026-10-16T06:00:00.000Z",
  model: { version: "swing-5d-preparing-v1", trainingStatus: "NOT_TRAINED", externalValidationStatus: "NOT_VALIDATED" },
  horizon: { tradingDays: 5, entryPolicy: "NEXT_SESSION_OPEN_AFTER_ISSUANCE", exitPolicy: "FIFTH_SESSION_CLOSE" },
  prediction: { expectedReturnPercent: null, lossProbability: null, rangePercent: null },
  observation: { status: "AVAILABLE", signalDate: "2026-10-15", collectionStartedAt: "2026-10-15T05:30:00.000Z", collectionCompletedAt: "2026-10-15T05:31:00.000Z", availableAt: null, referencePrice: 0, ticker: "005930", companyName: "관측 표본", observedAt: "2026-10-15T05:30:00.000Z", rowCount: 0, independentDateCount: 0 },
  readiness: { status: "BLOCKED", eligibleForTraining: false, blockers: [{ code: "NO_TRAINING", message: "독립된 날짜 표본이 부족합니다." }, { code: "AVAILABILITY_UNKNOWN", message: "입력 사용 가능 시각을 확인해야 합니다." }] },
  ledger: { recordCount: 0, records: [] },
  evaluation: { mature5DayCount: 0, independentDateCount: 0, costStatus: "UNKNOWN", costAdjustedReturnPercent: null },
  daytrade: { status: "PREPARING", reason: "분봉 데이터가 없습니다." },
};
const mod = compile();
assert.equal(mod.validateForecastSwingResponse(fixture), fixture);
const html = (element) => renderToStaticMarkup(element);
const view = (data) => html(React.createElement(mod.ForecastSwingPreparingView, { data }));
const prepared = view(fixture);
for (const text of ["PREPARING", "판단을 보류", "기대 수익률", "손실 확률", "예측 범위", "학습 불가", "미학습", "미검증", "availableAt", "미확인", "체결가 아님", "0원", "swing-5d-preparing-v1", "2026-10-15", "KST", "수집 시작", "수집 완료", "첫 거래 세션 시가", "발행 시각보다 엄격히 늦어야", "5번째 거래일 종가", "거래비용 미확인", "순수익률 —", "발행된 예측이 없습니다", "읽기 전용 · 준비 기록 0건", "0일", "0건"]) assert.ok(prepared.includes(text), text);
for (const id of ["expected-return", "loss-probability", "prediction-range"]) assert.match(prepared, new RegExp(`data-testid="${id}"[^>]*>—</p>`, "u"));
assert.doesNotMatch(prepared, /(?:0|null|undefined)%|NaN|Infinity/u);
assert.ok(!prepared.includes("예측 발행"), "There must be no forecast issue action");
const unavailable = structuredClone(fixture);
unavailable.observation = { ...unavailable.observation, status: "UNAVAILABLE", signalDate: null, referencePrice: null, ticker: null, companyName: null, collectionStartedAt: null, collectionCompletedAt: null, observedAt: null };
const missingHtml = view(unavailable);
assert.ok(missingHtml.includes("저장 관측이 없습니다."));
assert.match(missingHtml, /data-testid="reference-price"[^>]*>—<\/p>/u);
assert.ok(!missingHtml.includes("0원"));
assert.equal(mod.formatForecastTimestamp(null), "미확인");
assert.equal(mod.formatForecastTimestamp("2026-10-15 14:30"), "2026-10-15 14:30", "Unzoned stored timestamps must not receive an invented zone");
assert.match(mod.formatForecastTimestamp("2026-10-15T05:30:00Z"), /14:30:00 KST/u);

for (const [name, mutate] of [
  ["schema", (v) => { v.schemaVersion = 2; }],
  ["status", (v) => { v.status = "READY"; }],
  ["return", (v) => { v.prediction.expectedReturnPercent = 0; }],
  ["probability", (v) => { v.prediction.lossProbability = 0.5; }],
  ["range", (v) => { v.prediction.rangePercent = [-2, 3]; }],
  ["trained", (v) => { v.model.trainingStatus = "TRAINED"; }],
  ["availability", (v) => { delete v.observation.availableAt; }],
  ["negative count", (v) => { v.observation.independentDateCount = -1; }],
  ["non-finite price", (v) => { v.observation.referencePrice = Infinity; }],
  ["maturity", (v) => { v.evaluation.mature5DayCount = 1; }],
  ["net return", (v) => { v.evaluation.costAdjustedReturnPercent = 0; }],
  ["costs", (v) => { v.evaluation.costStatus = "KNOWN"; }],
  ["negative ledger count", (v) => { v.ledger.recordCount = -1; }],
  ["entry", (v) => { v.horizon.entryPolicy = "CURRENT_CLOSE"; }],
  ["daytrade", (v) => { v.daytrade.status = "READY"; }],
]) { const changed = structuredClone(fixture); mutate(changed); assert.throws(() => mod.validateForecastSwingResponse(changed), undefined, name); }
assert.throws(() => mod.validateForecastSwingResponse(null));
const truncated = structuredClone(fixture);
truncated.ledger.recordCount = 21;
truncated.ledger.records = Array.from({ length: 20 }, (_, i) => ({ id: `record-${i}`, status: "PREPARING", issuedAt: null, ticker: "005930", modelVersion: fixture.model.version, expectedReturnPercent: null, lossProbability: null, rangePercent: null }));
assert.equal(mod.validateForecastSwingResponse(truncated), truncated);
const truncatedHtml = view(truncated);
assert.ok(truncatedHtml.includes("준비 기록 최근 20건 / 전체 21건"));
assert.ok(truncatedHtml.includes("준비 기록 · 예측 미발행"));
assert.ok(truncatedHtml.includes("준비 기록 시각 미확인"));
const ledgerOnly = structuredClone(truncated);
ledgerOnly.observation = unavailable.observation;
assert.ok(view(ledgerOnly).includes("최신 관측 요약은 연결되지 않았습니다."));
assert.ok(!view(ledgerOnly).includes("저장 관측이 없습니다."));
assert.ok(!truncatedHtml.includes("발행 시각 미확인"), "Preparation timestamps cannot masquerade as prediction issuance");
assert.ok(prepared.includes("준비 기록은 실제 예측·검증 성과가 아닙니다."));
const observed = structuredClone(truncated);
observed.ledger.records[0].observedModels = [{ modelVersion: "B-v1", score: 71.25, rank: 2 }];
observed.ledger.records[0].outcome = { status: "OBSERVED", reasons: [], resolvedAt: "2026-10-26T03:00:00Z", entryDate: "2026-10-19", exitDate: "2026-10-23", benchmarkReturnPercent: 5, netReturnPercent: null };
observed.evaluation.mature5DayCount = 1; observed.evaluation.independentDateCount = 1;
assert.equal(mod.validateForecastSwingResponse(observed), observed);
const outcomeHtml = view(observed);
for (const text of ["B-v1 2위", "71.25점", "독립 표본이 아닙니다", "2026-10-19", "2026-10-23"]) assert.ok(outcomeHtml.includes(text), text);
assert.equal(observed.prediction.expectedReturnPercent, null);
observed.ledger.records[0].outcome.status = "PENDING";
assert.throws(() => mod.validateForecastSwingResponse(observed), undefined, "Pending results cannot contain returns");
const invalidLedger = structuredClone(truncated); invalidLedger.ledger.recordCount = 19;
assert.throws(() => mod.validateForecastSwingResponse(invalidLedger));
invalidLedger.ledger.recordCount = 21; invalidLedger.ledger.records.push({ ...invalidLedger.ledger.records[0], id: "record-20" });
assert.throws(() => mod.validateForecastSwingResponse(invalidLedger), undefined, "The API view is bounded to 20 records");


const children = (node) => node && typeof node === "object" && node.props ? React.Children.toArray(node.props.children) : [];
const find = (node, predicate) => [...(node && typeof node === "object" && node.props && predicate(node) ? [node] : []), ...children(node).flatMap((child) => find(child, predicate))];
function harness() {
  let cursor = 0, effects = [], tree;
  const slots = [], updates = [];
  const hooks = { ...React,
    useState(initial) { const index = cursor++; if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial; return [slots[index], (next) => { slots[index] = typeof next === "function" ? next(slots[index]) : next; updates.push({ index, value: slots[index] }); }]; },
    useRef(initial) { const index = cursor++; if (!(index in slots)) slots[index] = { current: initial }; return slots[index]; },
    useEffect(callback, dependencies) { const index = cursor++, previous = slots[index]; if (!previous || dependencies.some((value, i) => !Object.is(value, previous.dependencies[i]))) { effects.push(() => { previous?.cleanup?.(); slots[index] = { dependencies, cleanup: callback() }; }); } },
  };
  const component = compile(hooks).default;
  return {
    slots, updates,
    render() { cursor = 0; effects = []; tree = component(); return tree; },
    flushEffects() { effects.forEach((effect) => effect()); effects = []; },
    unmount() { slots.forEach((slot) => slot?.cleanup?.()); },
    search(value) { const input = find(tree, (node) => node.type === "input")[0]; input.props.onChange({ target: { value } }); this.render(); find(tree, (node) => node.type === "form")[0].props.onSubmit({ preventDefault() {} }); this.render(); },
  };
}
const originalFetch = globalThis.fetch;
const pending = [];
const settle = () => new Promise((resolve) => setImmediate(resolve));
const response = (data, status = 200) => ({ ok: status === 200, status, json: async () => data });
try {
  globalThis.fetch = (url, options) => new Promise((resolve, reject) => pending.push({ url, options, resolve, reject }));
  const h = harness();
  assert.ok(html(h.render()).includes("불러오는 중"));
  assert.ok(!html(h.render()).includes("발행된 예측이 없습니다"), "Loading must not masquerade as a known empty ledger");
  h.flushEffects();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].url, "/api/forecasts/swing");
  assert.equal(pending[0].options.cache, "no-store");
  assert.equal(pending[0].options.credentials, "same-origin");

  h.search("000001");
  assert.equal(pending[0].options.signal.aborted, true, "Search aborts immediately before the next effect");
  pending[0].resolve(response(fixture));
  await settle();
  assert.equal(h.slots[3].status, "loading", "Aborted transport resolving successfully must not publish");
  h.flushEffects();
  assert.equal(pending[1].url, "/api/forecasts/swing?code=000001");
  const second = structuredClone(fixture); second.observation.ticker = "000001"; second.observation.companyName = "두 번째 관측";
  pending[1].resolve(response(second)); await settle();
  assert.equal(h.slots[3].data.observation.ticker, "000001");
  assert.ok(html(h.render()).includes("두 번째 관측"));

  h.search("000002"); h.flushEffects();
  assert.ok(!html(h.render()).includes("두 번째 관측"), "New searches clear previously successful data");
  h.search("000003"); h.flushEffects();
  const newestMissing = structuredClone(unavailable); newestMissing.observation.ticker = "000003";
  pending[3].resolve(response(newestMissing)); await settle();
  pending[2].resolve(response(second)); await settle();
  assert.equal(h.slots[3].data.observation.status, "UNAVAILABLE", "An older successful response must not replace newer no-data");

  h.render(); h.search("ABC!12"); h.flushEffects();
  assert.equal(pending.length, 4, "Invalid code must not cause a request");
  assert.ok(html(h.render()).includes("종목코드 6자리를 입력해 주세요"));
  h.search("005930"); h.flushEffects();
  pending[4].resolve(response({ secret: "SERVER_INTERNAL_DETAIL" }, 401)); await settle();
  const authHtml = html(h.render());
  assert.ok(authHtml.includes("로그인이 필요"));
  assert.ok(authHtml.includes('href="/login"'));
  assert.ok(!authHtml.includes("SERVER_INTERNAL_DETAIL"));
  assert.ok(!authHtml.includes("두 번째 관측"));
  assert.ok(!authHtml.includes("발행된 예측이 없습니다"));

  find(h.render(), (node) => node.type === "button" && node.props.children === "다시 시도")[0].props.onClick();
  h.render(); h.flushEffects();
  assert.equal(pending[5].url, "/api/forecasts/swing?code=005930", "Retry preserves the active code");
  pending[5].resolve(response({ error: { message: "DO_NOT_DISPLAY_AUTH_INTERNALS" } }, 503)); await settle();
  assert.equal(h.slots[3].kind, "unavailable");
  assert.ok(!html(h.render()).includes("DO_NOT_DISPLAY_AUTH_INTERNALS"));

  h.search(""); h.flushEffects();
  assert.equal(pending[6].url, "/api/forecasts/swing");
  const compromised = structuredClone(fixture); compromised.prediction.expectedReturnPercent = 18.5;
  pending[6].resolve(response(compromised)); await settle();
  assert.equal(h.slots[3].status, "error", "Numeric forecast values cannot leak through PREPARING");
  assert.ok(!html(h.render()).includes("18.5"));

  h.search("000004"); h.flushEffects();
  h.search("000005"); h.flushEffects();
  const fifth = structuredClone(fixture); fifth.observation.ticker = "000005";
  pending[8].resolve(response(fifth)); await settle();
  pending[7].reject(new Error("stale network failure")); await settle();
  assert.equal(h.slots[3].status, "success", "Stale rejection must not overwrite newer success");

  h.search("000006"); h.flushEffects();
  const beforeUnmount = h.updates.length;
  h.unmount();
  assert.equal(pending[9].options.signal.aborted, true);
  pending[9].resolve(response(fixture)); await settle();
  assert.equal(h.updates.length, beforeUnmount, "Unmounted requests must not publish any state");

  const alpha = harness(); alpha.render(); alpha.search("0009k0"); alpha.flushEffects();
  assert.equal(pending[10].url, "/api/forecasts/swing?code=0009K0", "New alphanumeric Korean tickers are supported");
  pending[10].resolve(response(fixture)); await settle();
  assert.equal(alpha.slots[3].status, "error", "A response for a different symbol must fail closed");
  alpha.unmount();

} finally { globalThis.fetch = originalFetch; }

assert.match(page, /<ForecastSwingPanel/u);
assert.match(home, /href="\/forecasts"/u);
assert.equal(isPublicResource(new URL("https://fixture/forecasts")), false);
assert.equal(isPublicResource(new URL("https://fixture/api/forecasts/swing")), false);
assert.doesNotMatch(source, /method:\s*["'](?:POST|PUT|PATCH|DELETE)["']/u);
assert.equal((source.match(/fetch\(/gu) ?? []).length, 1, "Only the guarded stored-data endpoint is fetched");
console.log("forecast swing UI: null/zero rendering, provenance, empty ledger, auth failures, retry, request races and route protection passed");
