import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (file) => readFile(new URL(`../${file}`, import.meta.url), "utf8");
const files = ["app/page.tsx", "app/layout.tsx", "components/HomeDashboard.tsx", "components/StockScreenerPanel.tsx", "components/TopStocksPanel.tsx", "components/ModelTopPerformancePanel.tsx", "components/ModelExplanationPanel.tsx", "components/TechnicalStrengthPanel.tsx", "components/market-analysis/MarketAnalysisPanel.tsx", "components/AdminLogin.tsx"];
const sources = Object.fromEntries(await Promise.all(files.map(async (file) => [file, await read(file)])));
const all = Object.values(sources).join("\n");
assert.doesNotMatch(all, /오늘의 분석 대시보드|TIGHT BUDGET · DAILY RESEARCH|Research models|Daily EOD screening|Daily model ranking|Model performance|Model guide|Stock Detail|Official daily analysis|Private Research Workspace|핵심 결과를 한눈에|검증된 데이터만 표시|데이터로 시작하는 종목 분석/u);
assert.match(sources["components/HomeDashboard.tsx"], /<h1 id="home-dashboard-heading"[^>]*>홈<\/h1>/u);
assert.match(sources["app/page.tsx"], /<h3[^>]*>분석 요약<\/h3>/u);
assert.match(sources["components/TechnicalStrengthPanel.tsx"], /<h2[^>]*>기술 강도<\/h2>/u);
// Shorter headings must not erase the information that qualifies each result.
for (const text of ["공식 EOD", "14:30 LIVE", "원본 대기", "저장소 게시 실패", "배포 실패", "사이트 확인 실패", "최근 수집 실패 사유", "독립 표본 아님", "모델 우열 판정 없음"])
  assert.ok(sources["components/HomeDashboard.tsx"].includes(text), text);
for (const text of ["공식 일봉 모델 순위", "모델 기준일", "기업분석", "격리 종목", "선택 모델 결측", 'role="alert"', "조건 초기화"])
  assert.ok(sources["components/StockScreenerPanel.tsx"].includes(text), text);
for (const text of ["데이터 기준일", "KIS 당일 잠정 EOD", "14:30 KIS 관측 신호", "최신 공식 일봉 기준일을 확인할 수 없습니다", "시세 확인 불가", "TOP50 데이터 없음", "다시 시도"])
  assert.ok(sources["components/TopStocksPanel.tsx"].includes(text), text);
for (const text of ["Daily EOD", "14:30 LIVE", "실행 연구", "미확정 결과는 통계와 N에 포함하지 않습니다", "독립 표본이 아니며", "실제 매수 진입일을 뜻하지 않습니다", "비용·슬리피지를 반영한 실현 수익률이 아닙니다"])
  assert.ok(sources["components/ModelTopPerformancePanel.tsx"].includes(text), text);
for (const text of ["관리자 로그인", 'htmlFor="admin-username"', 'htmlFor="admin-password"', 'type="password"', 'role="alert"', "인증되지 않은 요청에는 분석 데이터가 제공되지 않습니다"])
  assert.ok(sources["components/AdminLogin.tsx"].includes(text), text);
console.log("UI concise-copy and essential disclosure regression tests passed");
