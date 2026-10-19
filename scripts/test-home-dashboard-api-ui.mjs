import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import * as React from "react";
import * as jsx from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import * as helpers from "../lib/home-dashboard.mjs";
import * as directional from "../lib/directional-transition.mjs";
import * as schedule from "../lib/production-schedule.mjs";
import * as liveTiming from "../lib/intraday-model-top-time-policy.mjs";
import * as presentation from "../lib/home-presentation.mjs";

const compile = (source, jsxFile = false) => ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true, ...(jsxFile ? { jsx: ts.JsxEmit.ReactJSX } : {}) } }).outputText;
const source = await readFile(new URL("../app/api/home-dashboard/route.ts", import.meta.url), "utf8");
const exports = {};
let calls = 0, fail = false;
const require = (name) => {
  if (name === "@/lib/production-schedule.mjs") return schedule;
  if (name === "@/lib/admin-access") return { withAdminAccess: handler => handler }; // Authorized data-contract fixture; auth independently tested.
  if (name === "next/server") return { NextResponse: { json: (body, init) => ({ body, status: init?.status ?? 200, headers: init?.headers }) } };
  if (name === "node:path") return path;
  if (name === "node:fs/promises") return { readFile: async () => JSON.stringify({ status: "FAILED", reason: "private-path-secret", runStartedAt: "must-not-leak", signalDate: "2026-10-08", updatedAt: "2026-10-08T12:00:00Z", credential: "must-not-leak" }) };
  if (name === "@/lib/home-dashboard-store.mjs") return { getHomeDashboard: async (topN) => { calls += 1; if (fail) throw new Error("private-path-secret"); return { models: { topN }, transitions: null }; } };
  throw new Error(name);
};
new Function("require", "exports", compile(source))(require, exports);
const request = (query) => ({ nextUrl: new URL(`http://fixture/api/home-dashboard?${query}`) });
const response = await exports.GET(request("topN=10"));
assert.equal(response.status, 200); assert.equal(response.body.models.topN, 10);
assert.equal(response.body.liveStatus.status, "FAILED");
assert.equal(response.headers["Cache-Control"], "no-store");
assert.doesNotMatch(JSON.stringify(response), /must-not-leak|credential|private-path-secret/);
for (const query of ["topN=6", "topN=NaN", "topN=05", "topN=-5"]) assert.equal((await exports.GET(request(query))).status, 400);
assert.equal(calls, 1);
fail = true;
const isolated = await exports.GET(request(""));
assert.equal(isolated.body.models, null); assert.equal(isolated.body.liveStatus.status, "FAILED");
assert.doesNotMatch(JSON.stringify(isolated), /private-path-secret/);

const panel = await readFile(new URL("../components/HomeDashboard.tsx", import.meta.url), "utf8");
const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
const top = await readFile(new URL("../components/TopStocksPanel.tsx", import.meta.url), "utf8");
for (const expression of [/AbortController/, /id === sequence.current/, /document.hidden/, /clearInterval/, /Cache-Control/]) assert.match(expression.source === "Cache-Control" ? source : panel, expression);
assert.match(page, /<HomeDashboard/);
assert.ok(page.indexOf('{searchError && <p role="alert"') < page.indexOf('<HomeDashboard'), "search failure must be visible before the dashboard");
assert.match(panel, /home-status-line/);
assert.doesNotMatch(page, /BrandMark hero|tb-matte-hero/);
assert.match(page, /ref=\{searchInputRef\} id="header-stock-search"/);
assert.match(page, /setScreenerEntry\(\{ tab: "transition", pair, state, direction, mode \}\)/);
assert.match(page, /initialTab=\{modelInitialTab\}/);
assert.match(top, /initialTab = "B"/);
const model = { modelVersion: "B-v1", rankingUniverseCount: 523, previousDate: "2026-10-06", comparisonStatus: "AVAILABLE", top: [{ code: "000660", name: "긴종목명검증", rank: 1, score: 88, previousRank: 3, rankChange: 2 }], entered: [{ code: "000660", name: "긴종목명검증", rank: 1, score: 88 }], exited: [], risers: [], universeAddedTop: [], universeRemovedTop: [] };
const identity = { referenceDate: "2026-10-07", snapshotHash: "a".repeat(64), commitSha: "b".repeat(40) };
const dashboard = { publicationReady: true, dataIdentity: identity, referenceDate: "2026-10-07", models: { referenceDate: "2026-10-07", previousOfficialDate: "2026-10-06", models: [model], overlap: [] }, transitions: { referenceDate: "2026-10-07", ruleVersion: "transition-research-v1", indicatorCoverage: 508, totalUniverse: 553, excludedCount: 45, sourceQualityGrade: "REJECTED", isPartialRanking: true, pairs: [{ pair: "5-20", states: [{ state: "APPROACHING", count: 1, examples: [{ code: "000660", name: "긴종목명검증", gapPercent: -1, topModels: ["B-v1"] }] }, { state: "CONFIRMED", count: 0, examples: [] }] }] }, calendar: { expectedTradingDate: null, dayStatus: "unchecked" }, liveStatus: { status: "FAILED", signalDate: "2026-10-08" } };
const performance = { publicationReady: true, dataIdentity: identity, daily: [{ modelVersion: "B-v1", topN: 5, horizon: "1DAY", signalDate: "2026-10-06", targetTradingDate: "2026-10-07", observationCount: 4, meanReturn: -1.25, positiveRate: 25 }], live: { daily: [] } };
const operations = { freshnessStatus: "fresh", publicationStatus: "published", siteApiMatchesPublished: true, siteApiReferenceDate: "2026-10-07", lastAutomaticRunConclusion: "success" };
// Preserve the old home EOD card contract explicitly; the default LIVE home
// surface and the real navigation chain are covered in test-home-transition-live-ui.
const liveDetails = {};
new Function("require", "exports", compile(await readFile(new URL("../components/LiveTransitionDetails.tsx", import.meta.url), "utf8"), true))((name) => { if (name === "react/jsx-runtime") return jsx; throw new Error(name); }, liveDetails);
const homeCard = {};
new Function("require", "exports", compile(await readFile(new URL("../components/HomeTransitionCard.tsx", import.meta.url), "utf8"), true))((name) => {
  if (name === "react/jsx-runtime") return jsx;
  if (name === "react") return { ...React, useState: (initial) => [initial === "LIVE" ? "EOD" : typeof initial === "function" ? initial() : initial, () => {}], useEffect: () => {} };
  if (name === "../lib/directional-transition.mjs") return directional;
  if (name === "./LiveTransitionDetails") return liveDetails;
  if (name === "./useLiveTransitionRevalidation") return { useLiveTransitionRevalidation: () => ({ rootRef: { current: null }, refreshVersion: 0 }) };
  throw new Error(name);
}, homeCard);
const rankings = {};
new Function("require", "exports", compile(await readFile(new URL("../components/HomeModelRankings.tsx", import.meta.url), "utf8"), true))((name) => {
  if (name === "react/jsx-runtime") return jsx;
  if (name === "../lib/home-presentation.mjs") return presentation;
  throw new Error(name);
}, rankings);
const render = (data = dashboard, failedPerformance = false, operationsInput = operations, failedHome = false) => {
  const resources = [{ url: "/api/home-dashboard?topN=5", data, error: failedHome }, { url: "/api/model-performance", data: failedPerformance ? null : performance, error: failedPerformance }, { url: "/api/daily-production-status", data: operationsInput, error: false }, { url: "/api/intraday-model-top?model=B&limit=1", data: null, error: true }];
  let index = 0;
  const uiExports = {};
  const requireUi = (name) => {
    if (name === "./PrivateLiveDeliveryPanel") return { PrivateLiveDeliveryView: () => null, usePrivateLiveDelivery: () => ({ data: { delivery: null }, failed: false, disabled: false }) };
    if (name === "./HomeModelRankings") return { __esModule: true, ...rankings };
    if (name === "../lib/home-presentation.mjs") return presentation;
    if (name === "./HomeTransitionCard") return { __esModule: true, ...homeCard };
    if (name === "../lib/intraday-model-top-time-policy.mjs") return liveTiming;
    if (name === "react/jsx-runtime") return jsx;
    // Explicitly inspect EOD and expanded diagnostics/archive. Default LIVE is
    // covered separately; resource state must not consume the new UI states.
    if (name === "react") return { ...React, useState: initial => [initial === null ? resources[index++] : initial === "LIVE" ? "EOD" : initial === false ? true : initial, () => {}], useRef: () => ({ current: 0 }), useEffect: () => {} };
    if (name === "../lib/home-dashboard.mjs") return helpers;
    if (name === "../lib/directional-transition.mjs") return directional;
    throw new Error(name);
  };
  new Function("require", "exports", compile(panel, true))(requireUi, uiExports);
  return renderToStaticMarkup(React.createElement(uiExports.default, { onSelectStock: () => {}, onOpenModel: () => {}, onOpenPerformance: () => {}, onOpenTransition: () => {} }));
};
const html = render();
assert.match(html, /<h1 id="home-dashboard-heading"[^>]*>시장 요약<\/h1>/u);
assert.doesNotMatch(html, /오늘의 분석 대시보드|TIGHT BUDGET · DAILY RESEARCH/u);
const modelUsage = {
  "A-v1": "상승장 · 주도주 탐색",
  "B-v1": "상승장 · 중기 추세 확인",
  "C-v1": "횡보장 · 단기 반등 신호가 나올 때",
  "D-v1": "상승장 · 추세와 진입 조건 함께 확인",
};
const allModelsHtml = render({ ...dashboard, models: { ...dashboard.models, models: Object.keys(modelUsage).map((modelVersion) => ({ ...model, modelVersion })) } });
const modelCards = [...allModelsHtml.matchAll(/<article\b[^>]*>[\s\S]*?<\/article>/g)].map(([card]) => card);
assert.equal(modelCards.length, Object.keys(modelUsage).length);
for (const [index, [version, usage]] of Object.entries(modelUsage).entries()) {
  const card = modelCards[index];
  assert.ok(card.includes(`모델 ${version} 상세 순위`));
  assert.ok(card.includes(usage), `${version}: the usage must be in its existing ranking card`);
  assert.ok(card.includes("긴종목명검증") && card.includes("88.00") && card.includes("↑2"), "guidance must not replace rankings or scores");
}
assert.match(allModelsHtml, /home-model-grid/);
assert.match(allModelsHtml, /home-ranking-note/);
assert.doesNotMatch(allModelsHtml, /저점 매수|수익률 보장|장세 자동 전환|하락장 자동 차단/u);
const caveats = ["장세별 설명은 산식의 특성에 따른 구분이며, 수익률 우위가 검증된 것은 아닙니다.", "하락장에서는 네 모델 모두 신규 매수 판단에 주의가 필요합니다."];
for (const output of [allModelsHtml, render(null), render(null, false, operations, true)]) {
  for (const caveat of caveats) assert.equal(output.split(caveat).length - 1, 1, "show each qualification once, including unavailable ranking states");
}
assert.ok(render(null, false, operations, true).includes("순위 조회 실패"));
const emptyModel = render({ ...dashboard, models: { ...dashboard.models, models: [{ ...model, modelVersion: "C-v1", top: [] }] } });
assert.ok(emptyModel.includes(modelUsage["C-v1"]) && emptyModel.includes("분석 가능한 종목 없음"));
for (const text of ["시장 요약", "모델 TOP3", "긴종목명검증", "000660", "골든크로스 접근", "골든크로스 확인", "해당 조건 종목 없음", "508/553", "미연결", "집계 대기", "-1.25%", "관측 4건", "관측 대기 · 전달된 결과 없음", "확인 불가", "Daily EOD", "14:30 LIVE", "REJECTED", "↑2"]) assert.ok(html.includes(text), text);
assert.ok(render(dashboard, true).includes("성과 조회 실패"));
assert.ok(render({ ...dashboard, transitions: null }).includes("전환 지표 데이터 없음"));
const noComparison = render({ ...dashboard, models: { ...dashboard.models, models: [{ ...model, comparisonStatus: "UNAVAILABLE", comparisonReason: "FORMULA_PROVENANCE_CHANGED_OR_MISSING" }] } });
assert.ok(noComparison.includes("긴종목명검증"));
assert.doesNotMatch(noComparison, /신규 진입|순위 상승/, "홈 요약은 전일 비교 가능성을 주장하지 않습니다.");
assert.doesNotMatch(noComparison, /↑2/u); assert.ok(noComparison.includes("전일 순위 비교 불가"));
assert.doesNotMatch(html, /최고 모델|매수 추천 모델|LIVE.*0\.00%/);
const verified = { ...operations, sourceStatus: "NO_NEW_DATA", runStatus: "NO_NEW_OFFICIAL_EOD", repositoryStatusAvailable: true, publishedReferenceDate: "2026-10-07", lastGoodStoredReferenceDate: "2026-10-07", latestValidatedReferenceDate: "2026-10-07", deployment: { state: "VERIFIED", reason: null, localIdentity: identity, lastVerified: { referenceDate: "2026-10-07", verifiedAt: "2026-10-08T04:30:00Z", runUrl: "https://github.com/klkl789982-droid/stock-research/actions/runs/42" } } };
const failedCurrentRead = render(dashboard, true, verified);
assert.ok(failedCurrentRead.includes("현재 성과 데이터 조회 실패")); assert.ok(failedCurrentRead.includes("확인 기록"));
assert.doesNotMatch(failedCurrentRead, /실제 사이트 확인 완료/u);
for (const altered of [{ ...dashboard, models: null }, { ...dashboard, dataIdentity: { ...identity, snapshotHash: "c".repeat(64) } }]) {
  const output = render(altered, false, verified); assert.doesNotMatch(output, /실제 사이트 확인 완료/u); assert.ok(output.includes("확인 기록"));
}
const verifiedHtml = render(dashboard, false, verified);
for (const text of ["공식 EOD 운영 상태", "원본 대기", "수집·검증 완료", "저장소 게시", "실제 사이트 확인 완료", "마지막 정상 저장 데이터", "마지막 실제 사이트 확인", "다음 영업일 13시 이후", "도착 시각은 보장되지 않습니다"]) assert.ok(verifiedHtml.includes(text), text);
assert.doesNotMatch(render(dashboard, false, operations), /실제 사이트 확인 완료/u, "Legacy published date and success never render green");
for (const [reason, label] of [["SITE_COMMIT_DIFFERS_REPOSITORY", "현재 화면 버전 미확인"], ["SITE_SNAPSHOT_DIFFERS_REPOSITORY", "데이터 반영 미확인"], ["VERCEL_DEPLOYMENT_PENDING", "배포 진행 중"]]) {
  const output = render(dashboard, false, { ...verified, deployment: { ...verified.deployment, state: "DEPLOYING", reason } });
  assert.ok(output.includes(label));
  if (reason !== "VERCEL_DEPLOYMENT_PENDING") assert.doesNotMatch(output, /EOD · 배포 중/u);
}
const failedWithOldProof = render(dashboard, false, { ...verified, runStatus: "FAILED", deployment: { ...verified.deployment, state: "UNVERIFIED", reason: "GITHUB_EVIDENCE_EXPIRED" } });
assert.ok(failedWithOldProof.includes("수집·검증 실패") && failedWithOldProof.includes("사이트 확인 기록 오래됨"));
for (const state of ["DEPLOYING", "DEPLOYMENT_FAILED", "VERIFICATION_FAILED"]) {
  const output = render(dashboard, false, { ...verified, runStatus: "FAILED", deployment: { ...verified.deployment, state, reason: "SITE_COMMIT_DIFFERS_REPOSITORY" } });
  assert.match(output, /공식 EOD<\/strong>[^<]*수집·검증 실패/u, "closed summary must retain collection failures alongside deployment evidence");
  assert.match(output, /home-status-warning/u);
}
for (const [state, reason, label] of [["DEPLOYMENT_FAILED", "VERCEL_DEPLOYMENT_FAILED", "Git 저장 후 Vercel 배포 실패"], ["VERIFICATION_FAILED", "HTTP_401", "사이트 검증 인증 실패 (401)"], ["VERIFICATION_FAILED", "HTTP_403", "사이트 검증 접근 거부 (403)"], ["VERIFICATION_FAILED", "REQUEST_TIMEOUT", "사이트 검증 응답 시간 초과"], ["UNVERIFIED", "GITHUB_403", "배포 증거 조회 제한 (403)"]]) {
  const output = render(dashboard, false, { ...verified, deployment: { ...verified.deployment, state, reason } });
  assert.ok(output.includes(label)); assert.ok(output.includes("2026.10.07")); assert.ok(output.includes("확인 기록"));
  assert.doesNotMatch(output, /실제 사이트 확인 완료/u);
}
console.log("home API allowlist/isolated failure/SSR/navigation/mobile hierarchy/stale guard tests passed");
