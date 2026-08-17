import assert from "node:assert/strict";
import fs from "node:fs";

const page = fs.readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
const panel = fs.readFileSync(new URL("../components/market-analysis/MarketAnalysisPanel.tsx", import.meta.url), "utf8");

assert.match(page, /<MarketAnalysisPanel/);
assert.doesNotMatch(page, /calculateEMAArray|const rsi14|const finalTechnicalScore|const atr14|const momentum20/, "page.tsx에서 시장분석을 재계산하면 안 됩니다.");
assert.match(page, /\/api\/market-analysis\?code=/);
assert.equal((page.match(/api\/market-analysis/g) ?? []).length, 1, "검색 시 한 번만 조회해야 합니다.");
assert.doesNotMatch(panel, /fetch\s*\(/, "탭 클릭은 API를 호출하면 안 됩니다.");
assert.match(panel, /시장분석 결과 없음/);
assert.match(panel, /브라우저에서 과거 공식을 대신 계산하거나 실시간 가격으로 대체하지 않습니다/);
assert.match(panel, /KIS 현재가는 표시용 시세에만 사용/);
assert.doesNotMatch(panel, /\/api\/(price|realtime)/, "시장분석 패널은 가격 API를 fallback으로 호출하면 안 됩니다.");
assert.doesNotMatch(panel, /calculateMarketAnalysis|technical-strength/, "시장분석 패널은 점수를 계산하면 안 됩니다.");

console.log("시장분석 UI 조회 전용 구조 테스트 통과");
