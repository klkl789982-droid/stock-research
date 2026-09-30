import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { TOP_INTRADAY_POLL_MS, toTopIntradayOverlay } from "../lib/top-stocks-intraday-overlay.mjs";

const verifiedQuote = { code: "005930", price: 70000, rate: -1.25, asOfDate: "2026-09-30", asOfTime: "10:15:00", responseAt: "2026-09-30T01:15:01.000Z", source: "KIS", freshnessStatus: "freshObservation", metadataAvailability: { status: "complete" } };
const valid = toTopIntradayOverlay("005930", verifiedQuote);
assert.deepEqual(valid, { code: "005930", status: "available", price: 70000, rate: -1.25, asOfDate: "2026-09-30", asOfTime: "10:15:00", receivedAt: "2026-09-30T01:15:01.000Z", source: "KIS" });
assert.deepEqual(toTopIntradayOverlay("005930", null), { code: "005930", status: "unavailable" });
assert.deepEqual(toTopIntradayOverlay("005930", { ...verifiedQuote, code: "000660" }), { code: "005930", status: "unavailable" }, "다른 종목 응답은 overlay에 붙지 않아야 합니다.");
assert.deepEqual(toTopIntradayOverlay("005930", { ...verifiedQuote, price: 0 }), { code: "005930", status: "unavailable" });
assert.deepEqual(toTopIntradayOverlay("005930", { ...verifiedQuote, freshnessStatus: "unverified" }), { code: "005930", status: "unavailable" }, "freshness를 검증하지 못한 quote는 현재 시세로 표시하지 않아야 합니다.");
assert.deepEqual(toTopIntradayOverlay("005930", { ...verifiedQuote, metadataAvailability: { status: "incomplete" } }), { code: "005930", status: "unavailable" }, "timestamp metadata가 불완전한 quote는 현재 시세로 표시하지 않아야 합니다.");
assert.deepEqual(toTopIntradayOverlay("005930", { ...verifiedQuote, asOfTime: null }), { code: "005930", status: "unavailable" }, "기준시각이 없는 quote는 현재 시세로 표시하지 않아야 합니다.");
assert.equal(TOP_INTRADAY_POLL_MS, 60_000);

const panel = await readFile(new URL("../components/TopStocksPanel.tsx", import.meta.url), "utf8");
assert.match(panel, /\/api\/realtime\?code=\$\{code\}/u);
assert.match(panel, /slice\(0, 5\)/u);
assert.match(panel, /intradayRequestVersionRef/u);
assert.match(panel, /controller\.abort\(\)/u);
assert.match(panel, /shortReferenceDate\(data\.rankingAsOfDate\).*기준 점수/u);
assert.doesNotMatch(panel, /전일 점수/u);
assert.match(panel, /오늘 현재/u);
assert.match(panel, /현재가 확인 불가/u);
assert.match(panel, /오늘 현재 ·/u);
assert.match(panel, /sm:hidden/u);
assert.match(panel, /compact \? "hidden sm:table-cell"/u);
assert.doesNotMatch(panel, /setData\(.*intraday/u);

console.log("TOP intraday overlay 성공·실패·종목 불일치·polling cleanup·daily 분리 테스트 통과");
