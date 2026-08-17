import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const realtime = await readFile(new URL("../app/api/realtime/route.ts", import.meta.url), "utf8");
const investor = await readFile(new URL("../app/api/investor/route.ts", import.meta.url), "utf8");
const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
for (const route of [realtime, investor]) {
  assert.doesNotMatch(route, /oauth2\/tokenP|function getAccessToken/u);
  assert.doesNotMatch(route, /KIS_APP_KEY|KIS_APP_SECRET/u);
}
assert.match(realtime, /getKisQuote/u);
assert.match(investor, /kisRequest/u);
assert.match(investor, /classifyKisHttpStatus/u);
assert.doesNotMatch(investor, /fake_ntby_qty \?\? 0/u);
assert.match(investor, /KIS_INVESTOR_DATA_UNAVAILABLE/u);
assert.match(page, /visibilitychange/u);
assert.match(page, /AbortController/u);
assert.match(page, /consecutiveFailures >= 3/u);
assert.match(page, /document\.hidden/u);
console.log("KIS API route·polling 구조 테스트 통과");
