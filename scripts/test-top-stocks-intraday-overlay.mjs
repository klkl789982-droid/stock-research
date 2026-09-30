import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { TOP_INTRADAY_POLL_MS, toTopIntradayOverlay } from "../lib/top-stocks-intraday-overlay.mjs";

const valid = toTopIntradayOverlay("005930", { code: "005930", price: 70000, rate: -1.25, asOfDate: "2026-09-30", asOfTime: "10:15:00", responseAt: "2026-09-30T01:15:01.000Z", source: "KIS" });
assert.deepEqual(valid, { code: "005930", status: "available", price: 70000, rate: -1.25, asOfDate: "2026-09-30", asOfTime: "10:15:00", receivedAt: "2026-09-30T01:15:01.000Z", source: "KIS" });
assert.deepEqual(toTopIntradayOverlay("005930", null), { code: "005930", status: "unavailable" });
assert.deepEqual(toTopIntradayOverlay("005930", { code: "000660", price: 70000 }), { code: "005930", status: "unavailable" }, "다른 종목 응답은 overlay에 붙지 않아야 합니다.");
assert.deepEqual(toTopIntradayOverlay("005930", { code: "005930", price: 0 }), { code: "005930", status: "unavailable" });
assert.equal(TOP_INTRADAY_POLL_MS, 60_000);

const panel = await readFile(new URL("../components/TopStocksPanel.tsx", import.meta.url), "utf8");
assert.match(panel, /\/api\/realtime\?code=\$\{code\}/u);
assert.match(panel, /slice\(0, 5\)/u);
assert.match(panel, /intradayRequestVersionRef/u);
assert.match(panel, /controller\.abort\(\)/u);
assert.match(panel, /전일 점수/u);
assert.match(panel, /오늘 현재/u);
assert.match(panel, /현재가 확인 불가/u);
assert.doesNotMatch(panel, /setData\(.*intraday/u);

console.log("TOP intraday overlay 성공·실패·종목 불일치·polling cleanup·daily 분리 테스트 통과");
