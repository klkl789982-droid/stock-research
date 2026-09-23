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

const finite = (value) => typeof value === "number" && Number.isFinite(value);

export function prepareSearchTechnicalStrengthInput(priceHistory, realtimePrice) {
  const historicalRows = Array.isArray(priceHistory) ? priceHistory : [];
  const latestHistoricalDate = compactDate(historicalRows[0]?.basDt);
  if (!realtimePrice) return { priceHistory: historicalRows, realtimePrice: null, status: "notAvailable", observationCount: historicalRows.length, appliedQuote: null };
  const price = Number(realtimePrice.price);
  const asOfDate = compactDate(realtimePrice.asOfDate);
  if (!Number.isFinite(price) || price <= 0 || asOfDate === null) {
    return { priceHistory: historicalRows, realtimePrice: null, status: "invalidMetadata", observationCount: historicalRows.length, appliedQuote: null };
  }
  if (latestHistoricalDate === null || asOfDate < latestHistoricalDate) {
    return { priceHistory: historicalRows, realtimePrice: null, status: "staleIgnored", observationCount: historicalRows.length, appliedQuote: null };
  }
  if (asOfDate === latestHistoricalDate) {
    const latest = historicalRows[0];
    const merged = {
      ...latest,
      ...(finite(realtimePrice.open) && realtimePrice.open > 0 ? { mkp: realtimePrice.open } : {}),
      ...(finite(realtimePrice.high) && realtimePrice.high > 0 ? { hipr: realtimePrice.high } : {}),
      ...(finite(realtimePrice.low) && realtimePrice.low > 0 ? { lopr: realtimePrice.low } : {}),
      clpr: price,
      ...(finite(realtimePrice.volume) && realtimePrice.volume >= 0 ? { trqu: realtimePrice.volume } : {}),
    };
    return {
      priceHistory: [merged, ...historicalRows.slice(1)],
      realtimePrice: null,
      status: "sameDateApplied",
      observationCount: historicalRows.length,
      appliedQuote: realtimePrice,
    };
  }
  return {
    priceHistory: historicalRows,
    realtimePrice,
    status: "newerDateApplied",
    observationCount: historicalRows.length + 1,
    appliedQuote: realtimePrice,
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

  const prepared = prepareSearchTechnicalStrengthInput(history.rows, realtimePrice);
  try {
    const result = calculator(prepared.priceHistory, prepared.realtimePrice);
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
      realtimeStatus: prepared.status,
      realtimeApplied: prepared.appliedQuote !== null,
      realtimeAsOfDate: prepared.appliedQuote?.asOfDate ?? null,
      realtimeAsOfTime: prepared.appliedQuote?.asOfTime ?? null,
      realtimeSource: prepared.appliedQuote?.source ?? null,
      observationCount: prepared.observationCount,
      outsideDisplayRange: result.finalTechnicalScore < 0 || result.finalTechnicalScore > 100,
    };
  } catch {
    return { status: "error", reason: "CALCULATION_FAILED", modelVersion: SEARCH_TECHNICAL_MODEL_VERSION };
  }
}
