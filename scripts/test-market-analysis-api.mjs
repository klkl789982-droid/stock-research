import assert from "node:assert/strict";
import fs from "node:fs";

const route = fs.readFileSync(new URL("../app/api/market-analysis/route.ts", import.meta.url), "utf8");

assert.match(route, /data["'], ["']analysis["'], ["']market/);
assert.match(route, /MARKET_ANALYSIS_SNAPSHOT_NOT_FOUND/);
assert.match(route, /MARKET_ANALYSIS_RECORD_NOT_FOUND/);
assert.match(route, /MARKET_ANALYSIS_SNAPSHOT_INVALID/);
assert.match(route, /Cache-Control["']: ["']no-store/);
assert.match(route, /\^\\d\{6\}\$/);
assert.doesNotMatch(route, /fetch\s*\(/, "조회 API는 외부 API를 호출하면 안 됩니다.");
assert.doesNotMatch(route, /calculateMarketAnalysis|technical-strength/, "조회 API는 점수를 계산하면 안 됩니다.");
assert.doesNotMatch(route, /realtime|KIS_APP|access_token/i, "조회 API는 KIS 시세나 인증정보를 사용하면 안 됩니다.");

console.log("시장분석 API 조회 전용 계약 테스트 통과");
