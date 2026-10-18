import test from "node:test";
import assert from "node:assert/strict";
import { createKisSource } from "./kis-source.mjs";

const DATE = "2026-10-12";
const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const quotePayload = (code) => ({ rt_cd: "0", output: { stck_shrn_iscd: code, stck_prpr: "101", stck_oprc: "100", stck_hgpr: "102", stck_lwpr: "99", acml_vol: "1000", prdy_vrss: "1", prdy_ctrt: "1" } });
function harness({ at = `${DATE}T05:00:00.000Z`, override, minuteTime = "140000", options = {} } = {}) {
  let clock = Date.parse(at);
  const calls = [], events = [];
  const source = createKisSource({ credentials: { appKey: "fixture-key", appSecret: "fixture-secret" }, now: () => clock,
    wait: async (ms) => { clock += ms; }, onRequest: (event) => events.push(event),
    fetchImpl: async (input, init) => {
      const url = new URL(input), kind = url.pathname.split("/").at(-1);
      calls.push({ kind, at: clock, trId: init.headers.tr_id });
      const replacement = await override?.({ kind, url, init, count: calls.filter((call) => call.kind === kind).length, advance: (ms) => { clock += ms; } });
      if (replacement) return replacement;
      if (kind === "tokenP") return response({ access_token: "fixture-token", expires_in: 86400 });
      if (kind === "chk-holiday") return response({ rt_cd: "0", output: [{ bass_dt: "20261012", opnd_yn: "Y", tr_day_yn: "Y" }] });
      if (kind === "inquire-price") return response(quotePayload(url.searchParams.get("FID_INPUT_ISCD")));
      if (kind === "inquire-time-itemchartprice") return response({ rt_cd: "0", output2: [{ stck_bsop_date: "20261012", stck_cntg_hour: minuteTime }] });
      throw new Error("unexpected fixture URL");
    }, ...options });
  return { source, calls, events, advance: (ms) => { clock += ms; } };
}

test("reuses KIS authentication/calendar/quote parsers and preserves actual request timestamps", async () => {
  const { source, calls, events } = harness();
  assert.equal((await source.calendar(DATE)).isTradingDay, true);
  const quote = await source.collectQuote("005930", { date: DATE, live: true });
  assert.equal(quote.asOfDate, DATE);
  assert.equal(quote.asOfTime, "14:00:00");
  assert.equal(quote.code, "005930");
  assert.equal(quote.receivedAt, quote.responseAt);
  assert.ok(Date.parse(quote.minuteRequestedAt) >= Date.parse(quote.responseAt));
  assert.equal(calls.filter((call) => call.kind === "tokenP").length, 1);
  assert.equal(source.getMetrics().requests, 4);
  assert.equal(JSON.stringify(events).includes("fixture-secret"), false);
  assert.equal(JSON.stringify(events).includes("fixture-token"), false);
  assert.equal(JSON.stringify(events).includes("stck_prpr"), false);
});

test("parallel collectors share a 5-request/second start budget and one token", async () => {
  const { source, events, calls } = harness();
  const quotes = await Promise.all(["005930", "000660", "064290"].map((code) => source.collectQuote(code, { date: DATE })));
  assert.equal(quotes.length, 3);
  const starts = events.filter((event) => event.phase === "request").map((event) => Date.parse(event.requestedAt));
  for (let index = 1; index < starts.length; index += 1) assert.ok(starts[index] - starts[index - 1] >= 200);
  assert.equal(calls.filter((call) => call.kind === "tokenP").length, 1);
  assert.equal(source.getMetrics().requests, 7);
});

test("LIVE rejects before-window, late and weekend collection without authentication", async () => {
  for (const [at, date] of [[`${DATE}T04:59:59Z`, DATE], [`${DATE}T05:05:01Z`, DATE], ["2026-10-11T05:00:00Z", "2026-10-11"]]) {
    const { source, calls } = harness({ at });
    await assert.rejects(source.collectQuote("005930", { date }), /KIS_QUOTE_COLLECTION_WINDOW_EXPIRED/u);
    assert.equal(calls.length, 0);
  }
});

test("shadow retains an actual off-window minute timestamp without inventing 14:00", async () => {
  const { source } = harness({ at: `${DATE}T09:00:00Z`, minuteTime: "153000" });
  const quote = await source.collectQuote("005930", { date: DATE, live: false });
  assert.equal(quote.asOfTime, "15:30:00");
  assert.equal(quote.receivedAt.slice(11, 13), "09");
});

test("LIVE rejects stale minute timestamps and contradictory quote dates", async () => {
  const stale = harness({ minuteTime: "135900" });
  await assert.rejects(stale.source.collectQuote("005930", { date: DATE }), /KIS_QUOTE_TIMESTAMP_OUTSIDE_WINDOW/u);
  const mismatch = harness({ override: ({ kind }) => kind === "inquire-price" ? response({ ...quotePayload("005930"), output: { ...quotePayload("005930").output, stck_bsop_date: "20261008" } }) : null });
  await assert.rejects(mismatch.source.collectQuote("005930", { date: DATE }), /KIS_QUOTE_DATE_MISMATCH/u);
  assert.equal(mismatch.calls.some((call) => call.kind === "inquire-time-itemchartprice"), false);
});

test("retries rate limits and HTTP server failures only once", async () => {
  for (const failed of [response({ error: "fixture" }, 429), response({ error: "fixture" }, 503), response({ rt_cd: "1", msg_cd: "EGW00201" })]) {
    const { source, calls } = harness({ override: ({ kind, count }) => kind === "inquire-price" && count === 1 ? failed : null });
    assert.equal((await source.collectQuote("005930", { date: DATE })).code, "005930");
    assert.equal(source.getMetrics().retries, 1);
    assert.equal(calls.filter((call) => call.kind === "inquire-price").length, 2);
  }
  const exhausted = harness({ override: ({ kind }) => kind === "inquire-price" ? response({}, 503) : null });
  await assert.rejects(exhausted.source.collectQuote("005930", { date: DATE }), /KIS_HTTP_503/u);
  assert.equal(exhausted.calls.filter((call) => call.kind === "inquire-price").length, 2);
});

test("window is checked after token acquisition and again before retry and minute request", async () => {
  const tokenDelay = harness({ at: `${DATE}T05:04:59Z`, override: ({ kind, advance }) => { if (kind === "tokenP") advance(2000); } });
  await assert.rejects(tokenDelay.source.collectQuote("005930", { date: DATE }), /KIS_QUOTE_COLLECTION_WINDOW_EXPIRED/u);
  assert.equal(tokenDelay.calls.some((call) => call.kind === "inquire-price"), false);
  const retryLate = harness({ at: `${DATE}T05:04:59.800Z`, override: ({ kind }) => kind === "inquire-price" ? response({}, 503) : null });
  await assert.rejects(retryLate.source.collectQuote("005930", { date: DATE }), /KIS_QUOTE_COLLECTION_WINDOW_EXPIRED/u);
  assert.equal(retryLate.calls.filter((call) => call.kind === "inquire-price").length, 1);
  const minuteLate = harness({ at: `${DATE}T05:04:59Z`, override: ({ kind, advance }) => { if (kind === "inquire-price") advance(2000); } });
  await assert.rejects(minuteLate.source.collectQuote("005930", { date: DATE }), /KIS_QUOTE_COLLECTION_WINDOW_EXPIRED/u);
  assert.equal(minuteLate.calls.some((call) => call.kind === "inquire-time-itemchartprice"), false);
});

test("failed quote does not leak upstream response or poison subsequent collection", async () => {
  const { source } = harness({ override: ({ kind, url }) => kind === "inquire-price" && url.searchParams.get("FID_INPUT_ISCD") === "005930" ? response({ rt_cd: "1", msg1: "PRIVATE_UPSTREAM_BODY" }) : null });
  await assert.rejects(source.collectQuote("005930", { date: DATE }), (error) => error.message === "KIS_BUSINESS_ERROR");
  assert.equal((await source.collectQuote("000660", { date: DATE })).code, "000660");
});

test("invalid credentials, ticker, date and unsafe rate settings fail closed", async () => {
  assert.throws(() => createKisSource(), /KIS_CREDENTIALS_MISSING/u);
  assert.throws(() => harness({ options: { spacingMs: 1 } }), /KIS_SOURCE_OPTIONS_INVALID/u);
  const { source, calls } = harness();
  await assert.rejects(source.collectQuote("../secret", { date: DATE }), /KIS_SOURCE_REQUEST_INVALID/u);
  await assert.rejects(source.collectQuote("005930", { date: "2026-10-11", live: false }), /KIS_QUOTE_DATE_MISMATCH/u);
  assert.equal(calls.length, 0);
});

test("a delayed source retains 14:00:30 while a five-minute delay plus expiry makes no requests", async () => {
  const delayed = harness({ at: `${DATE}T05:00:30Z`, minuteTime: "140030" });
  assert.equal((await delayed.source.collectQuote("005930", { date: DATE })).asOfTime, "14:00:30");
  const expired = harness({ at: `${DATE}T05:05:01Z` });
  await assert.rejects(expired.source.collectQuote("005930", { date: DATE }), /KIS_QUOTE_COLLECTION_WINDOW_EXPIRED/u);
  assert.equal(expired.calls.length, 0);
});

test("header and body timeouts are bounded and preserve the timeout code without upstream details", async () => {
  for (const phase of ["headers", "body"]) {
    const { source, calls, events } = harness({ options: { timeoutMs: 15 }, override: async ({ kind, init }) => {
      if (kind !== "inquire-price") return null;
      const error = new Error("PRIVATE_TRANSPORT_DETAIL");
      if (phase === "headers") return new Promise((resolve, reject) => {
        void resolve;
        init.signal.addEventListener("abort", () => reject(error), { once: true });
      });
      return new Response(new ReadableStream({ start(controller) {
        init.signal.addEventListener("abort", () => controller.error(error), { once: true });
      } }), { status: 200 });
    } });
    await assert.rejects(source.collectQuote("005930", { date: DATE }), (error) => error.message === "KIS_SOURCE_TIMEOUT");
    assert.equal(calls.filter((call) => call.kind === "inquire-price").length, 2);
    assert.equal(source.getMetrics().retries, 1);
    assert.equal(source.getMetrics().failures, 2);
    assert.equal(JSON.stringify(events).includes("PRIVATE_TRANSPORT_DETAIL"), false);
  }
});

test("a transient timeout can recover and a window-expired paced request is never retried", async () => {
  const recovered = harness({ options: { timeoutMs: 15 }, override: async ({ kind, count, init }) => {
    if (kind === "inquire-price" && count === 1) return new Promise((resolve, reject) => {
      void resolve;
      init.signal.addEventListener("abort", () => reject(new Error("timeout fixture")), { once: true });
    });
    return null;
  } });
  assert.equal((await recovered.source.collectQuote("005930", { date: DATE })).code, "005930");
  assert.equal(recovered.source.getMetrics().retries, 1);
  const expired = harness({ at: `${DATE}T05:04:59Z`, override: ({ kind, advance }) => { if (kind === "tokenP") advance(2000); } });
  await assert.rejects(expired.source.collectQuote("005930", { date: DATE }), /KIS_QUOTE_COLLECTION_WINDOW_EXPIRED/u);
  assert.equal(expired.source.getMetrics().retries, 0);
  assert.equal(expired.calls.some((call) => call.kind === "inquire-price"), false);
});

test("203650 HTTP 500 retries once within the window and keeps the successful attempt time", async () => {
  const f = harness({ minuteTime: "140001", override: ({ kind, count, advance }) => {
    if (kind === "inquire-price" && count === 1) { advance(400); return response({}, 500); }
    return null;
  } });
  const quote = await f.source.collectQuote("203650", { date: DATE });
  const requests = f.calls.filter(call => call.kind === "inquire-price");
  assert.equal(requests.length, 2);
  assert.ok(requests[1].at - requests[0].at >= 1000);
  assert.equal(quote.requestedAt, new Date(requests[1].at).toISOString());
  assert.notEqual(quote.requestedAt, new Date(requests[0].at).toISOString());
  assert.equal(quote.asOfTime, "14:00:01");
  assert.equal(f.source.getMetrics().retries, 1);
});

test("203650 persistent 500 is bounded; a later control cannot repair the rejected observation", async () => {
  const f = harness({ override: ({ kind }) => kind === "inquire-price" ? response({}, 500) : null });
  await assert.rejects(f.source.collectQuote("203650", { date: DATE }), /KIS_HTTP_500/u);
  assert.equal(f.calls.filter(call => call.kind === "inquire-price").length, 2);
  assert.equal(f.calls.some(call => call.kind === "inquire-time-itemchartprice"), false);
  f.advance(301000);
  const before = f.calls.length;
  await assert.rejects(f.source.collectQuote("203650", { date: DATE }), /WINDOW_EXPIRED/u);
  assert.equal(f.calls.length, before);
});

test("203650 successful HTTP body arriving after 14:05 is rejected without minute lookup", async () => {
  const f = harness({ at: `${DATE}T05:04:59Z`, minuteTime: "140459", override: ({ kind, advance }) => {
    if (kind === "inquire-price") advance(1100);
    return null;
  } });
  await assert.rejects(f.source.collectQuote("203650", { date: DATE }), /WINDOW_EXPIRED/u);
  assert.equal(f.calls.filter(call => call.kind === "inquire-price").length, 1);
  assert.equal(f.calls.some(call => call.kind === "inquire-time-itemchartprice"), false);
  assert.equal(f.source.getMetrics().retries, 0);
});
