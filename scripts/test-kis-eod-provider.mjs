import assert from "node:assert/strict";
import { createKisEodProvider, parseKisDailyBarResponse, parseKisHolidayResponse, KIS_EOD_ADJUSTMENTS, KisEodProviderError } from "../lib/kis-eod-provider.mjs";
import { createKisApiClient } from "../lib/kis-api-client-core.mjs";

const code = "005930", referenceDate = "2026-10-08", receivedAt = "2026-10-08T11:10:00.000Z";
const bar = (date, extra = {}) => ({ stck_bsop_date: date, stck_oprc: "100", stck_hgpr: "110", stck_lwpr: "90", stck_clpr: "105", acml_vol: "1000", acml_tr_pbmn: "103000", prtt_rate: "", flng_cls_code: "", mod_yn: "", revl_issu_reas: "", ...extra });
const payload = (rows = [bar("20261008")], output1 = { stck_shrn_iscd: code }) => ({ rt_cd: "0", output1, output2: rows });
const response = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
const create = (request, overrides = {}) => createKisEodProvider({ client: { request }, wait: async () => {}, now: () => receivedAt, delayMs: 0, ...overrides });
const parse = (data, options = {}) => parseKisDailyBarResponse(data, { code, startDate: "20260101", endDate: "20261008", ...options });
let checks = 0;
async function test(name, body) { await body(); checks += 1; console.log(`PASS ${name}`); }

await test("verified period-chart field mapping; no synthetic zero or finality", async () => {
  const parsed = parse(payload());
  assert.equal(parsed.rows[0].clpr, 105);
  assert.equal(parsed.rows[0].trPrc, 103000);
  assert.equal(parsed.rows[0].fltRt, null);
  assert.equal(parsed.adjustmentMetadata[0].splitRatio, null);
  assert.equal(parsed.adjustmentMetadata[0].changed, null);
  assert.equal(parsed.symbolMapping.status, "VERIFIED_RESPONSE_TICKER");
  const result = await create(async () => response(payload())).getHistory(code, referenceDate, { requiredRows: 1 });
  assert.equal(result.priceBasis, "kisDailyBarUnadjusted");
  assert.equal(result.marketDivision, "J");
  assert.equal(result.finality, "NOT_CONFIRMED");
  assert.equal(result.exchangeTime, null);
  assert.equal(result.sourcePublishedAt, null);
  assert.equal(result.receivedAt, receivedAt);
});
await test("adjusted and original flag semantics and parameters", async () => {
  const calls = [];
  const provider = create(async (url, init) => { calls.push({ url: new URL(url), init }); return response(payload()); });
  await provider.getHistory(code, referenceDate, { requiredRows: 1 });
  await provider.getHistory(code, referenceDate, { requiredRows: 1, adjustment: "adjusted" });
  assert.equal(calls[0].url.pathname, "/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice");
  assert.equal(calls[0].init.headers.tr_id, "FHKST03010100");
  assert.equal(calls[0].url.searchParams.get("FID_COND_MRKT_DIV_CODE"), "J");
  assert.equal(calls[0].url.searchParams.get("FID_PERIOD_DIV_CODE"), "D");
  assert.equal(calls[0].url.searchParams.get("FID_INPUT_DATE_2"), "20261008");
  assert.equal(calls[0].url.searchParams.get("FID_ORG_ADJ_PRC"), "1");
  assert.equal(calls[1].url.searchParams.get("FID_ORG_ADJ_PRC"), "0");
  assert.notEqual(KIS_EOD_ADJUSTMENTS.adjusted.priceBasis, KIS_EOD_ADJUSTMENTS.unadjusted.priceBasis);
});
await test("existing auth client supplies headers without provider credentials", async () => {
  const client = createKisApiClient({ tokenManager: { getToken: async () => ({ accessToken: "synthetic-only-token" }) }, getCredentials: () => ({ appKey: "synthetic-only-key", appSecret: "synthetic-only-secret" }), fetchImpl: async (_url, init) => {
    assert.equal(init.headers.authorization, "Bearer synthetic-only-token");
    assert.equal(init.headers.appkey, "synthetic-only-key");
    assert.equal(init.headers.appsecret, "synthetic-only-secret");
    assert.equal(init.cache, "no-store");
    return response(payload());
  } });
  await createKisEodProvider({ client, delayMs: 0 }).getHistory(code, referenceDate, { requiredRows: 1 });
});
await test("response ticker absent unverified; mismatch rejected; alphanumeric preserved", async () => {
  assert.equal(parse(payload(undefined, {})).symbolMapping.status, "UNVERIFIED_RESPONSE_TICKER_ABSENT");
  assert.throws(() => parse(payload(undefined, { stck_shrn_iscd: "000660" })), /KIS_EOD_SYMBOL_MISMATCH/u);
  assert.equal(parseKisDailyBarResponse(payload(undefined, { stck_shrn_iscd: "0009K0" }), { code: "0009K0", startDate: "20260101", endDate: "20261008" }).rows[0].srtnCd, "0009K0");
});
await test("null rate/trading value preserved; explicit rate preserved", async () => {
  const rows = parse(payload([bar("20261008", { acml_tr_pbmn: "", prdy_ctrt: "1.25" })])).rows;
  assert.equal(rows[0].fltRt, 1.25);
  assert.equal(rows[0].trPrc, null);
  assert.equal(parse(payload([bar("20261008", { prdy_ctrt: "0" })])).rows[0].fltRt, 0);
  const sourceChange = parse(payload([bar("20261008", { prdy_vrss: "10", prdy_vrss_sign: "5" })]));
  assert.deepEqual(sourceChange.dailyChangeMetadata, [{ date: referenceDate, reportedDifference: 10, reportedSign: "5" }]);
  assert.equal(sourceChange.rows[0].fltRt, null);
  assert.equal(sourceChange.rows[0].prdy_vrss, undefined);
});
await test("duplicate/future/out-of-range/invalid dates fail closed", async () => {
  assert.throws(() => parse(payload([bar("20261008"), bar("20261008")])), /KIS_EOD_DUPLICATE_DATE/u);
  assert.throws(() => parse(payload([bar("20261009")])), /KIS_EOD_ROW_OUTSIDE_REQUEST_RANGE/u);
  assert.throws(() => parse(payload([bar("20251231")])), /KIS_EOD_ROW_OUTSIDE_REQUEST_RANGE/u);
  assert.throws(() => parse(payload([bar("20260230")])), /KIS_EOD_DATE_INVALID/u);
  assert.throws(() => parse(payload(), { startDate: "20261009" }), /KIS_EOD_DATE_RANGE_INVALID/u);
});
await test("malformed numeric/missing OHLC/negative volume rejected", async () => {
  for (const extra of [{ stck_clpr: "" }, { stck_clpr: null }, { stck_clpr: "NaN" }, { stck_clpr: true }, { stck_clpr: "Infinity" }, { acml_vol: "-1" }, { stck_hgpr: "99" }, { acml_tr_pbmn: "-1" }]) {
    assert.throws(() => parse(payload([bar("20261008", extra)])), KisEodProviderError);
  }
});
await test("valid non-trading observation classified without executable substitution", async () => {
  const row = parse(payload([bar("20261008", { stck_oprc: "0", stck_hgpr: "0", stck_lwpr: "0", acml_vol: "0", acml_tr_pbmn: "0" })])).rows[0];
  assert.equal(row.observationStatus, "tradingHaltOrNoTrade");
  assert.equal(row.mkp, 0);
  assert.equal(row.clpr, 105);
});
await test("bounded dated windows produce 260 exclusively KIS observations", async () => {
  const all = Array.from({ length: 320 }, (_, index) => {
    const date = new Date("2026-10-08T00:00:00Z"); date.setUTCDate(date.getUTCDate() - index);
    return bar(date.toISOString().slice(0, 10).replaceAll("-", ""));
  });
  const ends = [];
  const provider = create(async (input) => {
    const end = new URL(input).searchParams.get("FID_INPUT_DATE_2"); ends.push(end);
    return response(payload(all.filter((row) => row.stck_bsop_date <= end).slice(0, 100)));
  });
  const result = await provider.getHistory(code, referenceDate);
  assert.equal(result.rows.length, 260);
  assert.equal(result.historyComplete, true);
  assert.equal(result.pageCount, 3);
  assert.equal(new Set(result.rows.map((row) => row.basDt)).size, 260);
  assert.ok(ends[1] < all[99].stck_bsop_date && ends[2] < all[199].stck_bsop_date);
  assert.ok(result.rows.every((row) => row.basDt <= "20261008"));
});
await test("incomplete IPO history explicit; bounded page exhaustion explicit", async () => {
  const short = await create(async () => response(payload([bar("20261008"), bar("20261007")]))).getHistory(code, referenceDate);
  assert.equal(short.historyRowsAvailable, 2); assert.equal(short.historyComplete, false); assert.equal(short.pageCount, 1);
  const hundred = Array.from({ length: 100 }, (_, index) => { const date = new Date("2026-10-08T00:00:00Z"); date.setUTCDate(date.getUTCDate() - index); return bar(date.toISOString().slice(0, 10).replaceAll("-", "")); });
  const limited = await create(async () => response(payload(hundred))).getHistory(code, referenceDate, { maxPages: 1 });
  assert.equal(limited.historyRowsAvailable, 100); assert.equal(limited.historyComplete, false);
});
await test("exact reference bar required; pagination overlapping/future page rejected", async () => {
  await assert.rejects(create(async () => response(payload([bar("20261007")]))).getHistory(code, referenceDate), /KIS_EOD_REFERENCE_DATE_MISSING/u);
  await assert.rejects(create(async () => response(payload([]))).getHistory(code, referenceDate), /KIS_EOD_REFERENCE_DATE_MISSING/u);
  let calls = 0;
  const hundred = Array.from({ length: 100 }, (_, index) => { const date = new Date("2026-10-08T00:00:00Z"); date.setUTCDate(date.getUTCDate() - index); return bar(date.toISOString().slice(0, 10).replaceAll("-", "")); });
  await assert.rejects(create(async () => { calls += 1; return response(payload(calls === 1 ? hundred : [hundred.at(-1)])); }).getHistory(code, referenceDate), /KIS_EOD_ROW_OUTSIDE_REQUEST_RANGE/u);
  assert.equal(calls, 2);
});
await test("history single-flight prevents duplicate concurrent requests", async () => {
  let calls = 0;
  const provider = create(async () => { calls += 1; return response(payload()); });
  const results = await Promise.all(Array.from({ length: 5 }, () => provider.getHistory(code, referenceDate, { requiredRows: 1 })));
  assert.equal(calls, 1); assert.ok(results.every((value) => value.rows.length === 1));
});
await test("holiday exact date, no holiday-by-weekday inference, per-date single-flight/cache", async () => {
  let calls = 0;
  const provider = create(async (url, init) => {
    calls += 1;
    assert.equal(new URL(url).pathname, "/uapi/domestic-stock/v1/quotations/chk-holiday");
    assert.equal(new URL(url).searchParams.get("BASS_DT"), "20261008");
    assert.equal(new URL(url).searchParams.get("CTX_AREA_FK"), "");
    assert.equal(init.headers.tr_id, "CTCA0903R");
    return response({ rt_cd: "0", output: [{ bass_dt: "20261008", opnd_yn: "Y", tr_day_yn: "Y" }] });
  });
  const results = await Promise.all([provider.getTradingDay(referenceDate), provider.getTradingDay(referenceDate)]);
  await provider.getTradingDay(referenceDate);
  assert.equal(calls, 1); assert.equal(results[0].status, "tradingDay"); assert.equal(results[0].isTradingDay, true);
  const closed = parseKisHolidayResponse({ rt_cd: "0", output: [{ bass_dt: "20261009", opnd_yn: "N", tr_day_yn: "N" }] }, "2026-10-09");
  assert.equal(closed.status, "marketClosed"); assert.equal(closed.isTradingDay, false);
  const mixed = parseKisHolidayResponse({ rt_cd: "0", output: [{ bass_dt: "20261008", opnd_yn: "Y", tr_day_yn: "N" }] }, referenceDate);
  assert.equal(mixed.status, "unknown"); assert.equal(mixed.isTradingDay, null);
  assert.throws(() => parseKisHolidayResponse({ rt_cd: "0", output: [{ bass_dt: "20261007", opnd_yn: "Y", tr_day_yn: "Y" }] }, referenceDate), /KIS_HOLIDAY_EXACT_DATE_MISSING_OR_DUPLICATE/u);
});
await test("retry HTTP rate limit/5xx and EGW00201 with bounded backoff", async () => {
  for (const first of [() => response({}, 429), () => response({}, 503), () => response({ rt_cd: "1", msg_cd: "EGW00201" })]) {
    let calls = 0; const delays = [];
    const provider = create(async () => { calls += 1; return calls === 1 ? first() : response(payload()); }, { wait: async (ms) => delays.push(ms), delayMs: 150 });
    const result = await provider.getHistory(code, referenceDate, { requiredRows: 1 });
    assert.equal(result.rows.length, 1); assert.equal(calls, 2); assert.deepEqual(delays, [750, 150]);
  }
});
await test("exhausted transient failure is safe and bounded; network recovery", async () => {
  let calls = 0;
  await assert.rejects(create(async () => { calls += 1; return response({}, 503); }).getHistory(code, referenceDate, { requiredRows: 1 }), /KIS_EOD_UPSTREAM_FAILURE/u);
  assert.equal(calls, 3);
  calls = 0;
  const recovered = await create(async () => { calls += 1; if (calls === 1) { const error = new Error("sensitive URL and token"); error.code = "KIS_BUSINESS_NETWORK_ERROR"; throw error; } return response(payload()); }).getHistory(code, referenceDate, { requiredRows: 1 });
  assert.equal(calls, 2); assert.equal(recovered.rows.length, 1);
  calls = 0;
  await assert.rejects(create(async () => { calls += 1; if (calls === 1) return response({}, 429); const error = new Error("raw network failure"); error.code = "KIS_BUSINESS_NETWORK_ERROR"; throw error; }).getHistory(code, referenceDate), /KIS_EOD_NETWORK_ERROR/u);
});
await test("nonretryable auth/business/invalid JSON failures do not repeat", async () => {
  for (const value of [() => response({}, 401), () => response({}, 403), () => response({}, 400), () => response({ rt_cd: "1", msg_cd: "OTHER", msg1: "private message" }), () => new Response("invalid", { status: 200 })]) {
    let calls = 0;
    await assert.rejects(create(async () => { calls += 1; return value(); }).getHistory(code, referenceDate), KisEodProviderError);
    assert.equal(calls, 1);
  }
  await assert.rejects(create(async () => { const error = new Error("token endpoint raw failure"); error.code = "KIS_TOKEN_HTTP_401"; throw error; }).getHistory(code, referenceDate), /KIS_EOD_AUTHENTICATION_FAILED/u);
});
await test("timeout abort covers request and retries without arbitrary values", async () => {
  let calls = 0, aborted = 0;
  const provider = create(async (_url, init) => { calls += 1; init.signal.addEventListener("abort", () => { aborted += 1; }); return new Promise(() => {}); }, { timeoutMs: 5, maxAttempts: 2 });
  await assert.rejects(provider.getHistory(code, referenceDate), /KIS_EOD_TIMEOUT/u);
  assert.equal(calls, 2); assert.equal(aborted, 2);
});
await test("logs and exceptions omit token, URL, payload and raw failures", async () => {
  const logs = [], secret = "synthetic-super-secret";
  const provider = create(async () => { const error = new Error(`https://host/?secret=${secret}`); error.code = "KIS_BUSINESS_NETWORK_ERROR"; throw error; }, { logger: (entry) => logs.push(entry) });
  let failure;
  try { await provider.getHistory(code, referenceDate); } catch (error) { failure = error.message; }
  const serialized = JSON.stringify({ logs, failure });
  assert.ok(!serialized.includes(secret)); assert.ok(!serialized.includes("https://")); assert.ok(!serialized.includes("authorization"));
  assert.equal(failure, "KIS_EOD_NETWORK_ERROR");
  assert.equal(logs.filter((entry) => entry.status === "RETRYABLE_FAILURE").length, 3);
  assert.equal(logs.filter((entry) => entry.status === "ATTEMPT_FAILURE").length, 3);
});
await test("safe request telemetry includes timestamps/duration and cannot alter results", async () => {
  const logs = [];
  const provider = create(async () => response(payload()), { logger: (event) => logs.push(event) });
  const history = await provider.getHistory(code, referenceDate, { requiredRows: 1 });
  assert.equal(history.requestedAt, receivedAt);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].status, "SUCCESS");
  assert.equal(logs[0].httpStatus, 200);
  assert.equal(logs[0].businessCode, "SUCCESS");
  assert.equal(logs[0].requestStartedAt, receivedAt);
  assert.equal(logs[0].receivedAt, receivedAt);
  assert.equal(logs[0].durationMs, 0);
  assert.ok(!JSON.stringify(logs).includes("stck_clpr"));
  const ignored = await create(async () => response(payload()), { logger: () => { throw new Error("logger unavailable"); } }).getHistory(code, referenceDate, { requiredRows: 1 });
  assert.equal(ignored.rows.length, 1);
});
await test("invalid caller options fail before network", async () => {
  let calls = 0; const provider = create(async () => { calls += 1; return response(payload()); });
  for (const options of [{ adjustment: "guess" }, { requiredRows: 0 }, { requiredRows: 261 }, { maxPages: 6 }]) await assert.rejects(provider.getHistory(code, referenceDate, options), /KIS_EOD_REQUEST_INVALID/u);
  await assert.rejects(provider.getHistory(code, "2026-02-30"), /KIS_EOD_DATE_INVALID/u);
  assert.equal(calls, 0);
});
await test("optional private rejection sink retains rejection and never logs raw fields", async () => {
  const captured = [], logs = [];
  const provider = create(async () => response(payload([bar("20261008", { stck_hgpr: "99" })])), {
    onRejectedResponse: async (context) => captured.push(context), logger: (event) => logs.push(event) });
  await assert.rejects(provider.getHistory(code, referenceDate), /KIS_EOD_OHLCV_INVALID/u);
  assert.equal(captured.length, 1); assert.equal(captured[0].code, code); assert.equal(captured[0].reason, "KIS_EOD_OHLCV_INVALID");
  assert.ok(!JSON.stringify(logs).includes("stck_hgpr"));
  const brokenSink = create(async () => response(payload([bar("20261008", { stck_hgpr: "99" })])), { onRejectedResponse: async () => { throw new Error("private storage inaccessible"); } });
  await assert.rejects(brokenSink.getHistory(code, referenceDate), /KIS_EOD_REJECTION_CAPTURE_FAILED/u);
});
console.log(`KIS EOD provider: ${checks} synthetic tests passed (no live API requests).`);
