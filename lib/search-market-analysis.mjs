import { calculateMarketAnalysis, MARKET_ANALYSIS_CALCULATOR_VERSION } from "./market-analysis-v1.mjs";

export const SEARCH_MARKET_MODEL_VERSION = MARKET_ANALYSIS_CALCULATOR_VERSION;
export const SEARCH_MARKET_REQUIRED_HISTORY = 260;

const compactDate = (value) => {
  const compact = String(value ?? "").replaceAll("-", "");
  return /^\d{8}$/u.test(compact) ? compact : null;
};

function validateRows(rows) {
  if (!Array.isArray(rows) || rows.length < SEARCH_MARKET_REQUIRED_HISTORY) return { valid: false, reason: "INSUFFICIENT_HISTORY" };
  const selected = rows.slice(0, SEARCH_MARKET_REQUIRED_HISTORY);
  let previousDate = null;
  for (const row of selected) {
    const date = compactDate(row?.basDt);
    const values = [row?.mkp, row?.hipr, row?.lopr, row?.clpr].map(Number);
    const volume = Number(row?.trqu);
    if (!date || (previousDate && date >= previousDate)
      || !values.every((value) => Number.isFinite(value) && value > 0)
      || !Number.isFinite(volume) || volume < 0
      || values[1] < Math.max(values[0], values[3]) || values[2] > Math.min(values[0], values[3])) {
      return { valid: false, reason: "INVALID_HISTORY" };
    }
    previousDate = date;
  }
  return { valid: true, rows: selected, asOfDate: compactDate(selected[0].basDt) };
}

export function buildSearchMarketAnalysis({ priceHistory, priceRequestStatus, storedMarketData }, calculator = calculateMarketAnalysis) {
  const storedDate = compactDate(storedMarketData?.record?.asOfDate);
  const storedAvailable = Boolean(storedMarketData?.record?.eligible && storedDate);
  const history = validateRows(priceHistory);
  if (!history.valid) {
    if (storedAvailable) {
      return {
        status: "available",
        data: storedMarketData,
        modelVersion: storedMarketData.calculatorVersion ?? SEARCH_MARKET_MODEL_VERSION,
        validationStatus: "inProgress",
        source: "storedOfficialSnapshot",
        asOfDate: storedMarketData.record.asOfDate,
        realtimeApplied: false,
      };
    }
    if (priceRequestStatus === "idle" || priceRequestStatus === "loading") return { status: "loading", modelVersion: SEARCH_MARKET_MODEL_VERSION };
    return { status: "unavailable", reason: priceRequestStatus === "success" ? history.reason : "PRICE_REQUEST_FAILED", modelVersion: SEARCH_MARKET_MODEL_VERSION };
  }

  if (storedAvailable && storedDate === history.asOfDate) {
    return {
      status: "available",
      data: storedMarketData,
      modelVersion: storedMarketData.calculatorVersion ?? SEARCH_MARKET_MODEL_VERSION,
      validationStatus: "inProgress",
      source: "storedOfficialSnapshot",
      asOfDate: storedMarketData.record.asOfDate,
      realtimeApplied: false,
    };
  }

  try {
    const record = calculator(history.rows);
    if (!Number.isFinite(record.finalTechnicalScore)) return { status: "error", reason: "NON_FINITE_SCORE", modelVersion: SEARCH_MARKET_MODEL_VERSION };
    return {
      status: "available",
      data: {
        requestedDate: history.asOfDate,
        generatedAt: null,
        calculatorVersion: SEARCH_MARKET_MODEL_VERSION,
        record: {
          code: null,
          name: null,
          market: null,
          asOfDate: history.asOfDate,
          officialClosePrice: Number(history.rows[0].clpr),
          qualityStatus: "SEARCH_SESSION_PROVISIONAL",
          eligible: true,
          ineligibleReasons: [],
          ...record,
        },
      },
      modelVersion: SEARCH_MARKET_MODEL_VERSION,
      validationStatus: "inProgress",
      source: "searchOfficialDailyHistory",
      asOfDate: history.asOfDate,
      realtimeApplied: false,
    };
  } catch {
    return { status: "error", reason: "CALCULATION_FAILED", modelVersion: SEARCH_MARKET_MODEL_VERSION };
  }
}
