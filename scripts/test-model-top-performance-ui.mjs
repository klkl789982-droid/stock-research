import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const panel = await readFile(new URL("../components/ModelTopPerformancePanel.tsx", import.meta.url), "utf8");
const route = await readFile(new URL("../app/api/model-performance/route.ts", import.meta.url), "utf8");
assert.match(panel, /\/api\/model-performance/);
assert.match(panel, /TOP5 평균/);
assert.match(panel, /TOP10 평균/);
assert.match(panel, /TOP20 평균/);
assert.match(panel, /날짜별 결과 보기/);
assert.match(route, /buildModelTopPerformance/);
console.log("model TOP performance UI/API connection test passed");
