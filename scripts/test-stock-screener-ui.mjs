import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

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
assert.match(panel, /onSelectStock\(\{ code: row\.code, name: row\.name \}\)/u);
assert.match(panel, /overflow-x-auto/u);
assert.match(route, /"data", "history"/u);
assert.doesNotMatch(route, /intraday|KIS|realtime/iu, "스크리너는 Daily EOD만 사용한다");

console.log("PC·모바일 스크리닝 내비게이션 및 UI 연결 테스트 통과");
