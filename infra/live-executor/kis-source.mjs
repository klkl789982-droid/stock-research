import { createKisTokenManager } from "../../lib/kis-token-manager-core.mjs";
import { createKisApiClient } from "../../lib/kis-api-client-core.mjs";
import { attachKisMinuteObservation, parseKisQuote } from "../../lib/kis-quote-provider-core.mjs";
import { createKisEodProvider } from "../../lib/kis-eod-provider.mjs";
import { classifyOfficialSignalWindow, signalWeekday } from "../../lib/intraday-model-top-time-policy.mjs";

const BASE = "https://openapi.koreainvestment.com:9443";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fail = (code) => { throw Object.assign(new Error(code), { code }); };
const kst = (ms) => {
  const value = new Date(ms + 9 * 60 * 60 * 1000).toISOString();
  return { date: value.slice(0, 10), time: value.slice(11, 19) };
};
const safeCode = (error) => /^KIS_[A-Z0-9_]+$/u.test(error?.code ?? "") ? error.code : "KIS_SOURCE_REQUEST_FAILED";

// One start-rate budget covers tokens, calendar, quotes, timestamps and retries.
export function createKisSource({ credentials, now = Date.now, wait = sleep, fetchImpl = fetch, onRequest = () => {}, spacingMs = 200, timeoutMs = 15_000 } = {}) {
  if (!credentials?.appKey || !credentials?.appSecret) fail("KIS_CREDENTIALS_MISSING");
  if (!Number.isFinite(spacingMs) || spacingMs < 200 || !Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30_000) fail("KIS_SOURCE_OPTIONS_INVALID");
  let queue = Promise.resolve(), nextRequestAt = 0;
  const metrics = { requests: 0, authenticationRequests: 0, calendarRequests: 0, quoteRequests: 0, minuteRequests: 0, retries: 0, failures: 0, firstRequestAt: null, lastRequestAt: null, lastReceivedAt: null, spacingMs };
  const emit = (event) => { try { onRequest(Object.freeze({ ...event })); } catch { /* Diagnostics only. */ } };
  function assertObservationWindow(date, live) {
    const current = kst(now());
    if (current.date !== date) fail("KIS_QUOTE_DATE_MISMATCH");
    if (live && classifyOfficialSignalWindow({ time: current.time, weekday: signalWeekday(current.date) }) !== "COLLECT") fail("KIS_QUOTE_COLLECTION_WINDOW_EXPIRED");
  }
  async function pacedFetch(input, init, { kind, date, live, timing } = {}) {
    const ready = queue.then(async () => {
      const delay = Math.max(0, nextRequestAt - now());
      if (delay) await wait(delay);
      if (date) assertObservationWindow(date, live);
      nextRequestAt = now() + spacingMs;
      const requestedAt = new Date(now()).toISOString();
      metrics.requests += 1;
      metrics[`${kind}Requests`] += 1;
      metrics.firstRequestAt ??= requestedAt;
      metrics.lastRequestAt = requestedAt;
      if (timing) timing.requestedAt = requestedAt;
      emit({ phase: "request", kind, requestedAt });
    });
    queue = ready.catch(() => {});
    await ready;
    const controller = new AbortController();
    const signal = init?.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal;
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(input, { ...init, signal, redirect: "error" });
      // Keep the timeout until the body has arrived, not just the headers.
      const body = await response.text();
      const receivedAt = new Date(now()).toISOString();
      metrics.lastReceivedAt = receivedAt;
      if (timing) timing.receivedAt = receivedAt;
      emit({ phase: "response", kind, requestedAt: timing?.requestedAt ?? null, receivedAt, status: response.status });
      return new Response(body, { status: response.status, headers: response.headers });
    } catch {
      metrics.failures += 1;
      fail(controller.signal.aborted ? "KIS_SOURCE_TIMEOUT" : "KIS_BUSINESS_NETWORK_ERROR");
    } finally {
      clearTimeout(timeout);
    }
  }
  const tokenManager = createKisTokenManager({ getCredentials: () => credentials, now, fetchImpl: (url, init) => pacedFetch(url, init, { kind: "authentication" }) });
  const calendarClient = createKisApiClient({ getCredentials: () => credentials, tokenManager, fetchImpl: (url, init) => pacedFetch(url, init, { kind: "calendar" }) });
  const calendarProvider = createKisEodProvider({ client: calendarClient, now, wait, maxAttempts: 2, timeoutMs });

  async function readMarket(url, trId, context) {
    const timing = {};
    const client = createKisApiClient({ getCredentials: () => credentials, tokenManager, fetchImpl: (input, init) => pacedFetch(input, init, { ...context, timing }) });
    for (let attempt = 0; attempt <= 1; attempt += 1) {
      try {
        assertObservationWindow(context.date, context.live);
        const response = await client.request(url, { headers: { "Content-Type": "application/json", tr_id: trId } });
        if (!response.ok) throw Object.assign(new Error(`KIS_HTTP_${response.status}`), { code: `KIS_HTTP_${response.status}`, retryable: response.status === 429 || response.status >= 500 });
        let payload;
        try { payload = await response.json(); } catch { fail("KIS_RESPONSE_INVALID_JSON"); }
        if (payload?.rt_cd !== "0") throw Object.assign(new Error("KIS_BUSINESS_ERROR"), { code: "KIS_BUSINESS_ERROR", retryable: payload?.msg_cd === "EGW00201" });
        return { payload, ...timing };
      } catch (error) {
        const retryable = error?.retryable || ["KIS_BUSINESS_NETWORK_ERROR", "KIS_TOKEN_NETWORK_ERROR", "KIS_SOURCE_TIMEOUT"].includes(error?.code);
        if (!retryable || attempt === 1) fail(safeCode(error));
        metrics.retries += 1;
        await wait(1000);
      }
    }
    fail("KIS_RETRY_EXHAUSTED");
  }
  async function collectQuote(code, { date, live = true } = {}) {
    if (!/^\d{6}$/u.test(code ?? "") || typeof live !== "boolean") fail("KIS_SOURCE_REQUEST_INVALID");
    signalWeekday(date);
    assertObservationWindow(date, live);
    const result = await readMarket(`${BASE}/uapi/domestic-stock/v1/quotations/inquire-price?FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD=${code}`, "FHKST01010100", { kind: "quote", date, live });
    const quote = parseKisQuote(result.payload, code, result.receivedAt);
    // Never replace a contradictory exchange date with a newer minute date.
    if (quote.asOfDate && quote.asOfDate !== date) fail("KIS_QUOTE_DATE_MISMATCH");
    const requestedTime = kst(Date.parse(result.requestedAt)).time.replaceAll(":", "");
    const minute = await readMarket(`${BASE}/uapi/domestic-stock/v1/quotations/inquire-time-itemchartprice?FID_ETC_CLS_CODE=&FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD=${code}&FID_INPUT_HOUR_1=${requestedTime}&FID_PW_DATA_INCU_YN=N`, "FHKST03010200", { kind: "minute", date, live });
    const observed = attachKisMinuteObservation(quote, minute.payload, { requestedDate: date, requestedTime });
    if (observed.asOfDate !== date) fail("KIS_QUOTE_DATE_MISMATCH");
    if (live && classifyOfficialSignalWindow({ time: observed.asOfTime, weekday: signalWeekday(date) }) !== "COLLECT") fail("KIS_QUOTE_TIMESTAMP_OUTSIDE_WINDOW");
    return { ...observed, requestedAt: result.requestedAt, responseAt: result.receivedAt, minuteRequestedAt: minute.requestedAt, minuteReceivedAt: minute.receivedAt };
  }
  return { calendar: (date) => calendarProvider.getTradingDay(date), collectQuote, getMetrics: () => ({ ...metrics }) };
}
