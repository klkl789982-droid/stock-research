import assert from "node:assert/strict";
import fs from "node:fs";

const page = fs.readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
const panel = fs.readFileSync(new URL("../components/market-analysis/MarketAnalysisPanel.tsx", import.meta.url), "utf8");

assert.match(page, /<MarketAnalysisPanel/);
assert.doesNotMatch(page, /calculateEMAArray|const rsi14|const finalTechnicalScore|const atr14|const momentum20/, "page.tsx에서 시장분석을 재계산하면 안 됩니다.");
assert.match(page, /\/api\/market-analysis\?code=/);
assert.equal((page.match(/api\/market-analysis/g) ?? []).length, 1, "검색 시 한 번만 조회해야 합니다.");
assert.doesNotMatch(panel, /fetch\s*\(/, "탭 클릭은 API를 호출하면 안 됩니다.");
assert.match(panel, /시장분석을 이용할 수 없습니다/);
assert.match(panel, /확인되지 않은 값으로 대신 계산하지 않습니다/);
assert.match(panel, /종합 기술 흐름/);
assert.match(panel, /상세 기술지표 보기/);
assert.match(panel, /데이터 기준 자세히 보기/);
for (const label of ["가격 상승 흐름", "중장기 추세", "거래량 강도", "단기 과열 균형", "52주 가격 위치", "반전 신호"]) assert.match(panel, new RegExp(label));
for (const internal of ["reversal bonus / penalty", "realtime 미적용"]) assert.doesNotMatch(panel, new RegExp(internal));
assert.doesNotMatch(panel, /\/api\/(price|realtime)/, "시장분석 패널은 가격 API를 fallback으로 호출하면 안 됩니다.");
assert.doesNotMatch(panel, /calculateMarketAnalysis|technical-strength/, "시장분석 패널은 점수를 계산하면 안 됩니다.");

console.log("시장분석 UI 조회 전용 구조 테스트 통과");
