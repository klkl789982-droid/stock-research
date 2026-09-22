import { calculateTechnicalStrength } from "./technical-strength.mjs";

export const SEARCH_TECHNICAL_MODEL_VERSION = "A-v1";
export const SEARCH_TECHNICAL_REQUIRED_HISTORY = 260;

const compactDate = (value) => {
  const compact = String(value ?? "").replaceAll("-", "");
  return /^\d{8}$/u.test(compact) ? compact : null;
};

function validateHistory(rows) {
  if (!Array.isArray(rows) || rows.length < SEARCH_TECHNICAL_REQUIRED_HISTORY) {
    return { valid: false, reason: "INSUFFICIENT_HISTORY" };
  }
  const selected = rows.slice(0, SEARCH_TECHNICAL_REQUIRED_HISTORY);
  const dates = selected.map((row) => compactDate(row?.basDt));
  if (dates.some((date) => date === null) || new Set(dates).size !== dates.length) {
    return { valid: false, reason: "INVALID_HISTORY" };
  }
  if (dates.some((date, index) => index > 0 && date >= dates[index - 1])) {
    return { valid: false, reason: "INVALID_HISTORY" };
  }
  const invalidOhlcv = selected.some((row) => {
    const close = Number(row?.clpr);
    const high = Number(row?.hipr);
    const low = Number(row?.lopr);
    const volume = Number(row?.trqu);
    return !Number.isFinite(close) || close <= 0
      || !Number.isFinite(high) || high <= 0
      || !Number.isFinite(low) || low <= 0
      || high < low || high < close || low > close
      || !Number.isFinite(volume) || volume < 0;
  });
  return invalidOhlcv
    ? { valid: false, reason: "INVALID_HISTORY" }
    : { valid: true, rows: selected, latestDate: dates[0] };
}

function selectRealtime(realtimePrice, latestHistoricalDate) {
  if (!realtimePrice) return { value: null, status: "notAvailable" };
  const price = Number(realtimePrice.price);
  const asOfDate = compactDate(realtimePrice.asOfDate);
  if (!Number.isFinite(price) || price <= 0 || asOfDate === null) {
    return { value: null, status: "invalidMetadata" };
  }
  if (asOfDate < latestHistoricalDate) return { value: null, status: "staleIgnored" };
  return {
    value: realtimePrice,
    status: asOfDate === latestHistoricalDate ? "sameDateApplied" : "newerDateApplied",
  };
}

export function buildSearchTechnicalStrength({ priceHistory, priceRequestStatus, realtimePrice }, calculator = calculateTechnicalStrength) {
  if (priceRequestStatus === "loading" || priceRequestStatus === "idle") {
    return { status: "loading", modelVersion: SEARCH_TECHNICAL_MODEL_VERSION };
  }
  if (priceRequestStatus !== "success") {
    return { status: "unavailable", reason: "PRICE_REQUEST_FAILED", modelVersion: SEARCH_TECHNICAL_MODEL_VERSION };
  }

  const history = validateHistory(priceHistory);
  if (!history.valid) {
    return { status: "unavailable", reason: history.reason, modelVersion: SEARCH_TECHNICAL_MODEL_VERSION };
  }

  const realtime = selectRealtime(realtimePrice, history.latestDate);
  try {
    const result = calculator(history.rows, realtime.value);
    if (!Number.isFinite(result.finalTechnicalScore)) {
      return { status: "error", reason: "NON_FINITE_SCORE", modelVersion: SEARCH_TECHNICAL_MODEL_VERSION };
    }
    return {
      status: "available",
      score: result.finalTechnicalScore,
      result,
      modelVersion: SEARCH_TECHNICAL_MODEL_VERSION,
      validationStatus: "inProgress",
      historicalAsOfDate: history.latestDate,
      realtimeStatus: realtime.status,
      realtimeApplied: realtime.value !== null,
      realtimeAsOfDate: realtime.value?.asOfDate ?? null,
      realtimeAsOfTime: realtime.value?.asOfTime ?? null,
      realtimeSource: realtime.value?.source ?? null,
      outsideDisplayRange: result.finalTechnicalScore < 0 || result.finalTechnicalScore > 100,
    };
  } catch {
    return { status: "error", reason: "CALCULATION_FAILED", modelVersion: SEARCH_TECHNICAL_MODEL_VERSION };
  }
}
