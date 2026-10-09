import { requestKisWithTransientRetry } from "./kis-intraday-collector.mjs";
import { normalizeStockCode } from "./stock-code.mjs";

// KIS's period-chart adjustment flag is different from inquire-daily-price.
// Official KIS examples: examples_llm/domestic_stock/inquire_daily_itemchartprice.
export const KIS_EOD_ADJUSTMENTS = Object.freeze({
  unadjusted: { flag: "1", priceBasis: "kisDailyBarUnadjusted" },
  adjusted: { flag: "0", priceBasis: "kisDailyBarAdjusted" },
});
export const KIS_EOD_OPERATION = "inquire-daily-itemchartprice";
export const KIS_EOD_TR_ID = "FHKST03010100";
export const KIS_HOLIDAY_OPERATION = "chk-holiday";
export const KIS_HOLIDAY_TR_ID = "CTCA0903R";
const BASE = "https://openapi.koreainvestment.com:9443/uapi/domestic-stock/v1/quotations/";
const waitDefault = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export class KisEodProviderError extends Error {
  constructor(code) { super(code); this.name = "KisEodProviderError"; this.code = code; }
}
const fail = (code) => { throw new KisEodProviderError(code); };

function compactDate(value) {
  const date = typeof value === "string" ? value.replaceAll("-", "") : "";
  if (!/^[0-9]{8}$/u.test(date)) fail("KIS_EOD_DATE_INVALID");
  const expanded = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
  const parsed = new Date(`${expanded}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== expanded) fail("KIS_EOD_DATE_INVALID");
  return date;
}
const isoDate = (value) => `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
const shiftedDate = (value, days) => {
  const date = new Date(`${isoDate(value)}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10).replaceAll("-", "");
};
function numeric(value, required = true) {
  if (value === null || value === undefined || value === "") {
    if (required) fail("KIS_EOD_NUMBER_MISSING");
    return null;
  }
  if (!((typeof value === "number" && Number.isFinite(value)) || (typeof value === "string" && /^[+-]?(?:[0-9]+(?:[.][0-9]*)?|[.][0-9]+)$/u.test(value.trim())))) fail("KIS_EOD_NUMBER_INVALID");
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) fail("KIS_EOD_NUMBER_INVALID");
  return parsed;
}
function metadataCode(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || !/^[0-9A-Z._-]{1,24}$/u.test(value)) fail("KIS_EOD_ADJUSTMENT_METADATA_INVALID");
  return value;
}

export function parseKisDailyBarResponse(payload, { code, startDate, endDate, adjustment = "unadjusted" }) {
  const ticker = normalizeStockCode(code);
  if (!ticker || !KIS_EOD_ADJUSTMENTS[adjustment]) fail("KIS_EOD_REQUEST_INVALID");
  const start = compactDate(startDate), end = compactDate(endDate);
  if (start > end) fail("KIS_EOD_DATE_RANGE_INVALID");
  if (payload?.rt_cd !== "0" || !Array.isArray(payload?.output2) || payload.output2.length > 100) fail("KIS_EOD_RESPONSE_INVALID");
  const reported = payload.output1?.stck_shrn_iscd;
  if (reported !== undefined && reported !== null && reported !== "" && normalizeStockCode(reported) !== ticker) fail("KIS_EOD_SYMBOL_MISMATCH");
  const seen = new Set(), adjustmentMetadata = [], dailyChangeMetadata = [];
  const rows = payload.output2.map((row) => {
    const basDt = compactDate(row?.stck_bsop_date);
    if (basDt < start || basDt > end) fail("KIS_EOD_ROW_OUTSIDE_REQUEST_RANGE");
    if (seen.has(basDt)) fail("KIS_EOD_DUPLICATE_DATE");
    seen.add(basDt);
    const mkp = numeric(row.stck_oprc), hipr = numeric(row.stck_hgpr), lopr = numeric(row.stck_lwpr), clpr = numeric(row.stck_clpr), trqu = numeric(row.acml_vol);
    const trPrc = numeric(row.acml_tr_pbmn, false), fltRt = numeric(row.prdy_ctrt, false);
    const nonTrading = trqu === 0 && mkp === 0 && hipr === 0 && lopr === 0;
    if (clpr <= 0 || trqu < 0 || !Number.isSafeInteger(trqu) || (trPrc !== null && trPrc < 0)) fail("KIS_EOD_OHLCV_INVALID");
    if (!nonTrading && (trqu === 0 || [mkp, hipr, lopr].some((price) => price <= 0) || hipr < Math.max(mkp, clpr) || lopr > Math.min(mkp, clpr) || hipr < lopr)) fail("KIS_EOD_OHLCV_INVALID");
    adjustmentMetadata.push({ date: isoDate(basDt), exDividendCode: metadataCode(row.flng_cls_code), splitRatio: numeric(row.prtt_rate, false), changed: metadataCode(row.mod_yn), reevaluationReason: metadataCode(row.revl_issu_reas) });
    dailyChangeMetadata.push({ date: isoDate(basDt), reportedDifference: numeric(row.prdy_vrss, false), reportedSign: metadataCode(row.prdy_vrss_sign) });
    // No synthetic rate, market cap, exchange time, or official publication time.
    return { basDt, srtnCd: ticker, mkp, hipr, lopr, clpr, trqu, trPrc, fltRt, observationStatus: nonTrading ? "tradingHaltOrNoTrade" : "trading" };
  }).sort((left, right) => right.basDt.localeCompare(left.basDt));
  return {
    rows, adjustmentMetadata: adjustmentMetadata.sort((left, right) => right.date.localeCompare(left.date)), dailyChangeMetadata: dailyChangeMetadata.sort((left, right) => right.date.localeCompare(left.date)),
    symbolMapping: { requestedCode: ticker, responseCode: reported ? normalizeStockCode(reported) : null, status: reported ? "VERIFIED_RESPONSE_TICKER" : "UNVERIFIED_RESPONSE_TICKER_ABSENT" },
    adjustment, priceBasis: KIS_EOD_ADJUSTMENTS[adjustment].priceBasis,
  };
}

export function parseKisHolidayResponse(payload, referenceDate, receivedAt = null) {
  const date = compactDate(referenceDate);
  if (payload?.rt_cd !== "0" || !Array.isArray(payload.output)) fail("KIS_HOLIDAY_RESPONSE_INVALID");
  const matching = payload.output.filter((row) => row?.bass_dt === date);
  if (matching.length !== 1) fail("KIS_HOLIDAY_EXACT_DATE_MISSING_OR_DUPLICATE");
  const row = matching[0];
  if (![row.opnd_yn, row.tr_day_yn].every((value) => ["Y", "N"].includes(value))) fail("KIS_HOLIDAY_STATUS_INVALID");
  const status = row.opnd_yn === "Y" && row.tr_day_yn === "Y" ? "tradingDay" : row.opnd_yn === "N" && row.tr_day_yn === "N" ? "marketClosed" : "unknown";
  return {
    referenceDate: isoDate(date), status, isTradingDay: status === "unknown" ? null : status === "tradingDay", isOpenDay: row.opnd_yn === "Y",
    source: "KIS", operation: KIS_HOLIDAY_OPERATION, exchange: "KRX", receivedAt,
    sourceFields: { bass_dt: row.bass_dt, opnd_yn: row.opnd_yn, tr_day_yn: row.tr_day_yn }, finality: "CALENDAR_ONLY_NOT_BAR_FINALITY",
  };
}

export function createKisEodProvider({ client, wait = waitDefault, now = () => Date.now(), delayMs = 150, maxAttempts = 3, timeoutMs = 15_000, logger = () => {}, onRejectedResponse = null }) {
  if (typeof client?.request !== "function" || !Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 3 || !Number.isFinite(delayMs) || delayMs < 0 || !Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30_000 || (onRejectedResponse !== null && typeof onRejectedResponse !== "function")) fail("KIS_EOD_PROVIDER_OPTIONS_INVALID");
  const calendarCache = new Map(), inFlight = new Map();
  let requestCount = 0;
  // Telemetry is an explicit whitelist, never an HTTP body, URL or auth header.
  // An operations logger must not change collection success/failure semantics.
  const emit = (event) => { try { logger(event); } catch { /* Diagnostics only. */ } };
  const timestamp = () => {
    const value = now();
    const parsed = new Date(value);
    if (!Number.isFinite(parsed.getTime())) fail("KIS_EOD_RECEIVED_TIMESTAMP_INVALID");
    return parsed.toISOString();
  };
  async function read(operation, trId, params) {
    let attempt = 0;
    let lastReason = "KIS_EOD_REQUEST_FAILED";
    try {
      const result = await requestKisWithTransientRetry({
        retries: maxAttempts - 1, backoffMs: 750, wait,
        request: async () => {
          attempt += 1;
          lastReason = "KIS_EOD_REQUEST_FAILED";
          if (requestCount > 0 && delayMs > 0) await wait(delayMs);
          requestCount += 1;
          const requestStartedAt = timestamp();
          const startedMs = Date.parse(requestStartedAt);
          let httpStatus = null, businessCode = null, succeeded = false;
          const abort = new AbortController();
          let timer;
          const retryable = (reason) => {
            lastReason = reason;
            const error = new Error("KIS_BUSINESS_NETWORK_ERROR");
            error.code = "KIS_BUSINESS_NETWORK_ERROR";
            throw error;
          };
          try {
            const operationPromise = (async () => {
              const url = new URL(`${BASE}${operation}`);
              url.search = new URLSearchParams(params).toString();
              const response = await client.request(url.toString(), { headers: { "Content-Type": "application/json", tr_id: trId }, signal: abort.signal });
              httpStatus = Number.isInteger(response?.status) ? response.status : null;
              if (!response?.ok) {
                await response?.body?.cancel().catch(() => {});
                if (response?.status === 429 || response?.status >= 500) retryable(response.status === 429 ? "KIS_EOD_RATE_LIMITED" : "KIS_EOD_UPSTREAM_FAILURE");
                fail([401, 403].includes(response?.status) ? "KIS_EOD_AUTHORIZATION_FAILED" : "KIS_EOD_HTTP_REJECTED");
              }
              let payload;
              try { payload = await response.json(); } catch { fail("KIS_EOD_INVALID_JSON"); }
              if (payload?.rt_cd !== "0") {
                businessCode = payload?.msg_cd === "EGW00201" ? "EGW00201" : "OTHER_BUSINESS_ERROR";
                if (payload?.msg_cd === "EGW00201") retryable("KIS_EOD_RATE_LIMITED");
                fail("KIS_EOD_BUSINESS_FAILED");
              }
              businessCode = "SUCCESS";
              succeeded = true;
              return { ok: true, status: 200, payload, receivedAt: timestamp() };
            })();
            const deadline = new Promise((_, reject) => { timer = setTimeout(() => { abort.abort(); lastReason = "KIS_EOD_TIMEOUT"; const error = new Error("KIS_BUSINESS_NETWORK_ERROR"); error.code = "KIS_BUSINESS_NETWORK_ERROR"; reject(error); }, timeoutMs); });
            return await Promise.race([operationPromise, deadline]);
          } catch (error) {
            if (["KIS_BUSINESS_NETWORK_ERROR", "KIS_TOKEN_NETWORK_ERROR"].includes(error?.code)) {
              if (lastReason === "KIS_EOD_REQUEST_FAILED") lastReason = "KIS_EOD_NETWORK_ERROR";
              emit({ component: "kis-eod-provider", operation, status: "RETRYABLE_FAILURE", reason: lastReason, attempt });
              throw error;
            }
            if (error instanceof KisEodProviderError) { lastReason = error.code; throw error; }
            if (typeof error?.code === "string" && error.code.startsWith("KIS_TOKEN_")) { lastReason = "KIS_EOD_AUTHENTICATION_FAILED"; fail(lastReason); }
            fail("KIS_EOD_REQUEST_FAILED");
          } finally {
            clearTimeout(timer);
            const receivedAt = timestamp();
            emit({ component: "kis-eod-provider", operation, status: succeeded ? "SUCCESS" : "ATTEMPT_FAILURE", reason: succeeded ? null : lastReason,
              attempt, requestStartedAt, receivedAt, durationMs: Math.max(0, Date.parse(receivedAt) - startedMs), httpStatus, businessCode });
          }
        },
      });
      return result;
    } catch (error) {
      if (error instanceof KisEodProviderError) throw error;
      fail(lastReason);
    }
  }
  async function getTradingDay(referenceDate) {
    const date = compactDate(referenceDate);
    if (calendarCache.has(date)) return calendarCache.get(date);
    const key = `calendar:${date}`;
    if (inFlight.has(key)) return inFlight.get(key);
    // KIS asks for one holiday query per day. Persist/reuse this evidence in the
    // caller across processes; this map only deduplicates one provider instance.
    const promise = read(KIS_HOLIDAY_OPERATION, KIS_HOLIDAY_TR_ID, { BASS_DT: date, CTX_AREA_FK: "", CTX_AREA_NK: "" })
      .then((result) => { const value = parseKisHolidayResponse(result.payload, date, result.receivedAt); calendarCache.set(date, value); return value; })
      .finally(() => inFlight.delete(key));
    inFlight.set(key, promise);
    return promise;
  }
  async function getHistory(code, referenceDate, { adjustment = "unadjusted", requiredRows = 260, maxPages = 5 } = {}) {
    const ticker = normalizeStockCode(code), date = compactDate(referenceDate);
    if (!ticker || !KIS_EOD_ADJUSTMENTS[adjustment] || !Number.isInteger(requiredRows) || requiredRows < 1 || requiredRows > 260 || !Number.isInteger(maxPages) || maxPages < 1 || maxPages > 5) fail("KIS_EOD_REQUEST_INVALID");
    const key = `history:${ticker}:${date}:${adjustment}:${requiredRows}:${maxPages}`;
    if (inFlight.has(key)) return inFlight.get(key);
    const promise = (async () => {
      const requestedAt = timestamp();
      const startDate = shiftedDate(date, -1_095);
      let endDate = date, receivedAt = null, pageCount = 0;
      const rows = [], adjustmentMetadata = [], dailyChangeMetadata = [], seen = new Set();
      let symbolMapping = null;
      while (pageCount < maxPages && rows.length < requiredRows) {
        const result = await read(KIS_EOD_OPERATION, KIS_EOD_TR_ID, { FID_COND_MRKT_DIV_CODE: "J", FID_INPUT_ISCD: ticker, FID_INPUT_DATE_1: startDate, FID_INPUT_DATE_2: endDate, FID_PERIOD_DIV_CODE: "D", FID_ORG_ADJ_PRC: KIS_EOD_ADJUSTMENTS[adjustment].flag });
        pageCount += 1;
        receivedAt = result.receivedAt;
        let parsed;
        try { parsed = parseKisDailyBarResponse(result.payload, { code: ticker, startDate, endDate, adjustment }); }
        catch (error) {
          // Optional research-only sink, never a logger or public projection.
          // The rejected response remains rejected; capture cannot repair it.
          if (onRejectedResponse) {
            try { await onRejectedResponse({ code: ticker, referenceDate: isoDate(date), startDate: isoDate(startDate), endDate: isoDate(endDate), adjustment,
              requestedAt, receivedAt: result.receivedAt, reason: error instanceof KisEodProviderError ? error.code : "KIS_EOD_RESPONSE_INVALID", payload: result.payload }); }
            catch { fail("KIS_EOD_REJECTION_CAPTURE_FAILED"); }
          }
          throw error;
        }
        if (pageCount === 1 && parsed.rows[0]?.basDt !== date) fail("KIS_EOD_REFERENCE_DATE_MISSING");
        if (!parsed.rows.length) break;
        if (symbolMapping === null || parsed.symbolMapping.status !== "VERIFIED_RESPONSE_TICKER") symbolMapping = parsed.symbolMapping;
        for (const row of parsed.rows) { if (seen.has(row.basDt)) fail("KIS_EOD_DUPLICATE_DATE"); seen.add(row.basDt); rows.push(row); }
        adjustmentMetadata.push(...parsed.adjustmentMetadata);
        dailyChangeMetadata.push(...parsed.dailyChangeMetadata);
        const oldest = parsed.rows.at(-1).basDt;
        if (oldest <= startDate || parsed.rows.length < 100) break;
        endDate = shiftedDate(oldest, -1);
      }
      const selected = rows.sort((left, right) => right.basDt.localeCompare(left.basDt)).slice(0, requiredRows);
      const includedDates = new Set(selected.map((row) => isoDate(row.basDt)));
      return {
        code: ticker, referenceDate: isoDate(date), rows: selected, historyRowsAvailable: selected.length, historyComplete: selected.length >= requiredRows,
        source: "KIS", sourceOperation: KIS_EOD_OPERATION, marketDivision: "J", priceBasis: KIS_EOD_ADJUSTMENTS[adjustment].priceBasis, adjustment,
        symbolMapping, adjustmentMetadata: adjustmentMetadata.filter((entry) => includedDates.has(entry.date)), dailyChangeMetadata: dailyChangeMetadata.filter((entry) => includedDates.has(entry.date)), pageCount, requestedAt, receivedAt,
        requestedDateBounds: { startDate: isoDate(startDate), endDate: isoDate(date) }, finality: "NOT_CONFIRMED", exchangeTime: null, sourcePublishedAt: null,
      };
    })().finally(() => inFlight.delete(key));
    inFlight.set(key, promise);
    return promise;
  }
  return { getTradingDay, getHistory };
}
