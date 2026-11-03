import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { sha256Canonical } from "../lib/snapshot-quality-pipeline.mjs";
import { DAILY_MODEL_VERSIONS } from "../lib/daily-production.mjs";
import { createMarketPriceLedger } from "../lib/market-price-ledger.mjs";
import { summarizeMarketIndex, summarizeMarketBreadth } from "../lib/market-overview.mjs";
import { loadResearchIndexSeries } from "../lib/research-index-benchmarks.mjs";

const calendar = { dates: {} }, days = [];
for (let at = Date.parse("2026-09-01"); days.length < 21; at += 86400000) {
  const d = new Date(at);
  if ([0, 6].includes(d.getUTCDay())) continue;
  const date = d.toISOString().slice(0, 10);
  calendar.dates[date] = { status: "tradingDay" };
  days.push(date);
}
const now = days.at(-1) + "T09:00:00.000Z";
const points = days.map((date, i) => ({ date, market: "KOSPI", close: 2 ** i, observedAt: now }));
test("same-market calendar-aligned close changes, daily sample deviation and dating", () => {
  const x = summarizeMarketIndex("KOSPI", [...points].reverse(), calendar, now, days.at(-1));
  assert.equal(x.status, "AVAILABLE");
  assert.deepEqual(x.recentCloses, points.slice(-5).map(({ date, close }) => ({ date, close })));
  assert.equal(x.changePct, 100);
  assert.equal(x.return5Pct, 3100);
  assert.equal(x.volatility20Pct, 0);
  assert.equal(x.priorDate, days.at(-2));
  assert.equal(x.timing, "CURRENT_SOURCE_DAY");
  assert.equal(x.closeConfirmed, null, "same date as the stock EOD cannot certify the index close");
  assert.equal(x.exchangeAsOfTime, null);
  assert.equal(x.sourceDateField, "output2.stck_bsop_date");
  assert.equal(x.observedAt, now);
  const older = summarizeMarketIndex("KOSPI", points.slice(0, -1), calendar, now, days.at(-1));
  assert.equal(older.timing, "BEHIND_DAILY");
  assert.equal(older.closeConfirmed, null);
  assert.equal(older.date, days.at(-2));
  assert.equal(summarizeMarketIndex("KOSPI", points, calendar, now, days.at(-2)).timing, "CURRENT_SOURCE_DAY");
  assert.equal(summarizeMarketIndex("KOSDAQ", points, calendar, now, days.at(-1)).status, "UNAVAILABLE");
  const noPrior = summarizeMarketIndex("KOSPI", points.filter(row => row.date !== days.at(-2)), calendar, now, days.at(-1));
  assert.equal(noPrior.change, null);
  assert.deepEqual(noPrior.recentCloses, [{ date: days.at(-1), close: points.at(-1).close }], "never bridge an unobserved trading day on the index chart");
  assert.equal(noPrior.return5Pct, null);
  assert.equal(noPrior.volatility20Pct, null);
  assert.equal(summarizeMarketIndex("KOSPI", [...points, points.at(-1)], calendar, now, days.at(-1)).status, "UNAVAILABLE");
  assert.equal(summarizeMarketIndex("KOSPI", [{ ...points[0], observedAt:"2027-01-01T00:00:00.000Z" }], calendar, now, days.at(-1)).status,"UNAVAILABLE");
});

test("existing KIS source isolates malformed or missing markets and deduplicates requests", async () => {
  let calls = 0;
  const request = async url => {
    calls++;
    const code = url.searchParams.get("FID_INPUT_ISCD");
    return Response.json({ rt_cd: "0", output1: { bstp_cls_code: code }, output2: code === "1001" ? [] :
      [{ stck_bsop_date: "20260903", bstp_nmix_oprc: "1000", bstp_nmix_prpr: "1010" }] });
  };
  const ranges = ["2026-09-03", "2026-09-04"];
  const [a,b] = await Promise.all([loadResearchIndexSeries(ranges,request),loadResearchIndexSeries(ranges,request)]);
  assert.equal(calls,2);
  assert.deepEqual(a,b);
  assert.equal(a.length,1);
  assert.equal(a[0].market,"KOSPI");
});

const tickers = ["000001","000002","000003","000004","000005","000006"];
function compact(date) {
  const base = { dataset:"compact-model-history", schemaVersion:1, referenceDate:date, universeSummary:{ originalUniverse:{ count:tickers.length } },
    records:tickers.map((ticker,i) => ({ ticker, market:"KOSPI", eligibility: { eligible:i !== 4, status:i === 4 ? "quarantined" : "eligible" },
      models:Object.fromEntries(DAILY_MODEL_VERSIONS.map(version => [version, {score:null,rank:null}])) })) };
  return { ...base, contentHash:sha256Canonical(base) };
}
const day1 = "2026-09-01", day2 = "2026-09-02";
const prices = (date, values) => createMarketPriceLedger(date,tickers.slice(0,values.length).map((code,i) => ({ code,executable:i!==5,
  openPrice:values[i],closePrice:values[i],referenceClose:values[i] })));
test("breadth denominator excludes prior/current quarantine, absent and nontrading prices", () => {
  const args = { current:compact(day2), previous:compact(day1), prices:prices(day2,[11,9,10,12,11,10]),
    priorPrices:prices(day1,[10,10,10]), calendar };
  const result = summarizeMarketBreadth(args);
  assert.deepEqual([result.universe,result.compared,result.up,result.flat,result.down,result.unavailable],[6,3,1,1,1,3]);
  assert.throws(()=>summarizeMarketBreadth({...args,prices:{...args.prices,date:day1}}));
  assert.throws(()=>summarizeMarketBreadth({...args,calendar:{dates:{[day1]:{status:"tradingDay"},[day2]:{status:"unchecked"}}}}));
  assert.throws(()=>summarizeMarketBreadth({...args,previous:{...args.previous,contentHash:"bad"}}));
});

test("private read-only endpoint, screen labels and no whole-universe quote polling", async () => {
  const file = name => readFile(new URL("../" + name,import.meta.url),"utf8");
  const [ui,route] = await Promise.all([file("components/MarketOverviewPanel.tsx"), file("app/api/market-overview/route.ts")]);
  for (const label of ["20거래일 일간 변동성","분석 대상 종목의 등락","비교 가능","거래소 기준시각 미확인","최근 5거래일","마감 확정 여부 미확인","시스템 수신","서로 다른 날짜의 자료","직전 조회 결과"]) assert.ok(ui.includes(label));
  assert.match(route,/GET = withAdminAccess/);
  assert.match(route,/private, no-store/);
  assert.match(ui,/\/api\/market-overview/); assert.doesNotMatch(ui,/api\/realtime|setInterval|PARTIAL|UNVERIFIED/);
});
