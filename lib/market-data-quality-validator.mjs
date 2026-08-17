import { normalizeStockCode } from "./stock-code.mjs";

export const MARKET_DATA_QUALITY_SCHEMA_VERSION = 2;
export const MARKET_DATA_NORMALIZATION_VERSION = "v2";

export const INDICATOR_HISTORY_REQUIREMENTS = Object.freeze({
  RSI: 15,
  ATR: 15,
  MACD: 34,
  MA120: 120,
  POSITION_52W: 260,
});

export const MODEL_HISTORY_REQUIREMENTS = Object.freeze({
  "A-v1": 260,
  "A-v2": 260,
  "B-v1": 260,
  "C-v1": 34,
  "D-v1": 260,
});

const MODEL_VERSIONS = Object.freeze(["A-v1", "A-v2", "B-v1", "C-v1", "D-v1"]);
const DATE_PATTERN = /^\d{8}$/u;

export function normalizeMarketDataCode(value) {
  return normalizeStockCode(value);
}

function normalizeRequestedDate(value) {
  const compact = String(value ?? "").replaceAll("-", "");
  return DATE_PATTERN.test(compact) ? compact : null;
}

function issue(severity, type, details = {}) {
  return { severity, type, ...details };
}

function asEntries(historyByCode) {
  if (historyByCode instanceof Map) return [...historyByCode.entries()];
  if (historyByCode && typeof historyByCode === "object") return Object.entries(historyByCode);
  return [];
}

function numeric(value) {
  if (value === null || value === undefined || value === "") return null;
  const converted = Number(value);
  return Number.isFinite(converted) ? converted : null;
}

export function classifyMarketDataRow(row, olderRow = null, newerRow = null) {
  const volume = numeric(row?.trqu);
  const prices = Object.fromEntries(["mkp", "hipr", "lopr", "clpr"].map((field) => [field, numeric(row?.[field])]));
  const closeValid = prices.clpr !== null && prices.clpr > 0;
  if (volume === null || volume < 0 || !closeValid) return { type: "invalidTradingRow", reason: volume === null || volume < 0 ? "invalidVolume" : "invalidClose", prices, volume };
  const ohlMissing = [prices.mkp, prices.hipr, prices.lopr].every((value) => value === null || value === 0);
  if (volume === 0 && ohlMissing) {
    const adjacentCloses = [numeric(olderRow?.clpr), numeric(newerRow?.clpr)].filter((value) => value !== null);
    if (adjacentCloses.some((value) => value !== prices.clpr)) return { type: "invalidTradingRow", reason: "zeroVolumePriceChanged", prices, volume };
    return { type: "nonTradingObservation", reason: "tradingHaltOrNoTrade", prices, volume, referenceClose: prices.clpr };
  }
  if (volume === 0) return { type: "invalidTradingRow", reason: "zeroVolumeWithExecutableOhlc", prices, volume };
  if ([prices.mkp, prices.hipr, prices.lopr].some((value) => value === null || value <= 0)) return { type: "invalidTradingRow", reason: "invalidPrice", prices, volume };
  if (prices.hipr < prices.lopr || prices.hipr < prices.mkp || prices.hipr < prices.clpr || prices.lopr > prices.mkp || prices.lopr > prices.clpr) return { type: "invalidTradingRow", reason: "invalidOhlcRelationship", prices, volume };
  return { type: "validTradingRow", reason: null, prices, volume };
}

export function normalizeModelInputRows(rows) {
  return rows.filter((row, index) => classifyMarketDataRow(row, rows[index + 1], rows[index - 1]).type === "validTradingRow");
}

function validateRow(row, code, index, rows, rowIssues) {
  const date = String(row?.basDt ?? "");
  const classification = classifyMarketDataRow(row, rows[index + 1], rows[index - 1]);
  if (classification.type === "nonTradingObservation") rowIssues.push(issue("warning", "nonTradingObservation", { code, date, rowIndex: index, referenceClose: classification.referenceClose }));
  if (classification.type === "invalidTradingRow") rowIssues.push(issue("fatal", classification.reason, { code, date, rowIndex: index }));

  const tradingValue = numeric(row?.trPrc);
  if (tradingValue === null || tradingValue < 0) {
    rowIssues.push(issue("fatal", "invalidTradingValue", { code, date, rowIndex: index }));
  }

  const marketCap = numeric(row?.mrktTotAmt);
  if (marketCap === null || marketCap <= 0) {
    rowIssues.push(issue("fatal", "invalidMarketCap", { code, date, rowIndex: index }));
  }
}

function modelStatus({ validHistory, stale, missing, requestedNonTrading, uniqueTradingDays }) {
  const result = {};
  for (const model of MODEL_VERSIONS) {
    let status = "eligible";
    if (missing) status = "missingData";
    else if (stale) status = "staleLatestDate";
    else if (requestedNonTrading) status = "tradingHaltOrNoTrade";
    else if (!validHistory) status = "invalidHistory";
    else if (uniqueTradingDays < MODEL_HISTORY_REQUIREMENTS[model]) status = "insufficientHistory";
    result[model] = status;
  }
  if (result["B-v1"] !== "eligible" || result["C-v1"] !== "eligible") {
    result["D-v1"] = result["B-v1"] !== "eligible" ? result["B-v1"] : result["C-v1"];
  }
  result["A-v2"] = result["A-v1"];
  return result;
}

export function validateMarketDataQuality(input) {
  const requestedDate = normalizeRequestedDate(input?.requestedDate);
  const universeRecords = Array.isArray(input?.universeRecords) ? input.universeRecords : [];
  const requirements = {
    expectedUniverseCount: input?.requirements?.expectedUniverseCount ?? universeRecords.length,
    requiredTradingValueDays: input?.requirements?.requiredTradingValueDays ?? 20,
    sourceManifestPresent: input?.requirements?.sourceManifestPresent ?? false,
    adjustedPricePolicy: input?.requirements?.adjustedPricePolicy ?? "unknown",
    corporateActionPolicy: input?.requirements?.corporateActionPolicy ?? "unknown",
    pointInTimeMasterCertified: input?.requirements?.pointInTimeMasterCertified ?? false,
    securityStatusVerified: input?.requirements?.securityStatusVerified ?? false,
    universeFilterVersion: input?.requirements?.universeFilterVersion ?? null,
    universeGeneratedAt: input?.requirements?.universeGeneratedAt ?? null,
    maxRequestedNonTradingRatio: input?.requirements?.maxRequestedNonTradingRatio ?? 0.1,
  };
  const issues = [];
  if (!requestedDate) issues.push(issue("fatal", "invalidRequestedDate"));

  const universeCodes = [];
  const invalidUniverseCodes = [];
  for (const record of universeRecords) {
    const code = normalizeMarketDataCode(record?.code ?? record?.srtnCd);
    if (code) universeCodes.push(code);
    else invalidUniverseCodes.push(String(record?.code ?? record?.srtnCd ?? ""));
  }
  if (invalidUniverseCodes.length > 0) {
    issues.push(issue("fatal", "invalidUniverseCodes", { codes: [...new Set(invalidUniverseCodes)].sort() }));
  }
  const duplicateUniverseCodes = [...new Set(universeCodes.filter((code, index) => universeCodes.indexOf(code) !== index))].sort();
  if (duplicateUniverseCodes.length > 0) {
    issues.push(issue("fatal", "duplicateUniverseCodes", { codes: duplicateUniverseCodes }));
  }
  if (universeRecords.length !== requirements.expectedUniverseCount) {
    issues.push(issue("fatal", "unexpectedUniverseCount", {
      expected: requirements.expectedUniverseCount,
      actual: universeRecords.length,
    }));
  }

  const historyEntries = asEntries(input?.historyByCode);
  const normalizedHistory = new Map();
  const invalidHistoryCodes = [];
  const duplicateHistoryKeys = [];
  for (const [rawCode, rows] of historyEntries) {
    const code = normalizeMarketDataCode(rawCode);
    if (!code) {
      invalidHistoryCodes.push(String(rawCode));
      continue;
    }
    if (normalizedHistory.has(code)) duplicateHistoryKeys.push(code);
    else normalizedHistory.set(code, Array.isArray(rows) ? rows : null);
  }
  if (invalidHistoryCodes.length > 0) issues.push(issue("fatal", "invalidHistoryCodes", { codes: [...new Set(invalidHistoryCodes)].sort() }));
  if (duplicateHistoryKeys.length > 0) issues.push(issue("fatal", "duplicateHistoryCodes", { codes: [...new Set(duplicateHistoryKeys)].sort() }));

  const universeCodeSet = new Set(universeCodes);
  const historyCodeSet = new Set(normalizedHistory.keys());
  const missingHistoryCodes = [...universeCodeSet].filter((code) => !historyCodeSet.has(code)).sort();
  const unexpectedHistoryCodes = [...historyCodeSet].filter((code) => !universeCodeSet.has(code)).sort();
  if (missingHistoryCodes.length > 0) issues.push(issue("fatal", "missingHistoryCodes", { codes: missingHistoryCodes }));
  if (unexpectedHistoryCodes.length > 0) issues.push(issue("fatal", "unexpectedHistoryCodes", { codes: unexpectedHistoryCodes }));

  const perSymbol = {};
  let duplicateDateRows = 0;
  let invalidOhlcvRows = 0;
  let zeroVolumeRows = 0;
  let exactDateMatches = 0;
  let insufficientHistorySymbols = 0;

  for (const code of [...new Set(universeCodes)].sort()) {
    const rows = normalizedHistory.get(code);
    if (!Array.isArray(rows) || rows.length === 0) {
      perSymbol[code] = {
        latestBasDt: null,
        oldestBasDt: null,
        uniqueTradingDays: 0,
        issues: [issue("fatal", "missingData", { code })],
        modelStatus: modelStatus({ validHistory: false, stale: false, missing: true, requestedNonTrading: false, uniqueTradingDays: 0 }),
      };
      continue;
    }

    const symbolIssues = [];
    const dates = rows.map((row) => String(row?.basDt ?? ""));
    for (let index = 0; index < dates.length; index += 1) {
      if (!DATE_PATTERN.test(dates[index])) symbolIssues.push(issue("fatal", "invalidBasDt", { code, rowIndex: index, value: dates[index] }));
      if (index > 0 && dates[index - 1] < dates[index]) symbolIssues.push(issue("fatal", "historyNotDescending", { code, rowIndex: index }));
      if (requestedDate && DATE_PATTERN.test(dates[index]) && dates[index] > requestedDate) symbolIssues.push(issue("fatal", "futureDate", { code, date: dates[index] }));
    }
    const duplicateDates = [...new Set(dates.filter((date, index) => dates.indexOf(date) !== index))].sort();
    if (duplicateDates.length > 0) {
      duplicateDateRows += duplicateDates.length;
      symbolIssues.push(issue("fatal", "duplicateDates", { code, dates: duplicateDates }));
    }

    rows.forEach((row, index) => validateRow(row, code, index, rows, symbolIssues));
    const modelRows = normalizeModelInputRows(rows);
    const validDates = dates.filter((date) => DATE_PATTERN.test(date));
    const uniqueTradingDays = new Set(modelRows.map((row) => String(row.basDt))).size;
    const latestBasDt = validDates.length > 0 ? [...validDates].sort().at(-1) : null;
    const oldestBasDt = validDates.length > 0 ? [...validDates].sort().at(0) : null;
    const stale = Boolean(requestedDate && latestBasDt !== requestedDate);
    if (stale) symbolIssues.push(issue("fatal", "latestDateMismatch", { code, expected: requestedDate, actual: latestBasDt }));
    else if (requestedDate) exactDateMatches += 1;

    const exactRow = requestedDate ? rows.find((row) => String(row?.basDt) === requestedDate) : null;
    const requestedIndex = exactRow ? rows.indexOf(exactRow) : -1;
    const requestedClassification = exactRow ? classifyMarketDataRow(exactRow, rows[requestedIndex + 1], rows[requestedIndex - 1]) : null;
    const requestedNonTrading = requestedClassification?.type === "nonTradingObservation";
    if (!exactRow || numeric(exactRow.mrktTotAmt) === null || numeric(exactRow.mrktTotAmt) <= 0) {
      symbolIssues.push(issue("fatal", "missingExactDateMarketCap", { code, requestedDate }));
    }
    const recentTradingDates = modelRows.slice(0, requirements.requiredTradingValueDays).map((row) => String(row?.basDt ?? ""));
    if (recentTradingDates.length < requirements.requiredTradingValueDays || new Set(recentTradingDates).size !== requirements.requiredTradingValueDays) {
      symbolIssues.push(issue("fatal", "invalidTradingValueDateWindow", { code, dates: recentTradingDates }));
    }

    const errorRows = new Set(symbolIssues.filter((entry) => entry.severity === "fatal" && Number.isInteger(entry.rowIndex)).map((entry) => entry.rowIndex));
    invalidOhlcvRows += errorRows.size;
    zeroVolumeRows += symbolIssues.filter((entry) => entry.type === "nonTradingObservation").length;
    const validHistory = !symbolIssues.some((entry) => entry.severity === "fatal");
    const statuses = modelStatus({ validHistory, stale, missing: false, requestedNonTrading, uniqueTradingDays });
    if (Object.values(statuses).some((status) => status === "insufficientHistory")) insufficientHistorySymbols += 1;
    const nonTradingObservationCount = rows.filter((row, index) => classifyMarketDataRow(row, rows[index + 1], rows[index - 1]).type === "nonTradingObservation").length;
    perSymbol[code] = { latestBasDt, oldestBasDt, uniqueTradingDays, rawObservationCount: rows.length, nonTradingObservationCount, requestedPriceStatus: requestedNonTrading ? "tradingHaltOrNoTrade" : "executable", referenceClose: requestedNonTrading ? requestedClassification.referenceClose : null, issues: symbolIssues, modelStatus: statuses };
    issues.push(...symbolIssues);
  }

  if (!requirements.universeFilterVersion) issues.push(issue("warning", "universeFilterVersionUnknown"));
  if (!requirements.universeGeneratedAt) issues.push(issue("warning", "universeGeneratedAtUnknown"));
  if (!requirements.sourceManifestPresent) issues.push(issue("warning", "sourceManifestMissing"));
  if (requirements.adjustedPricePolicy === "unknown") issues.push(issue("warning", "adjustedPricePolicyUnknown"));
  if (requirements.corporateActionPolicy === "unknown") issues.push(issue("warning", "corporateActionPolicyUnknown"));
  if (!requirements.pointInTimeMasterCertified) issues.push(issue("warning", "pointInTimeMasterNotCertified"));
  if (zeroVolumeRows > 0) issues.push(issue("warning", "zeroVolumeRowsPresent", { count: zeroVolumeRows }));
  if (!requirements.securityStatusVerified) issues.push(issue("warning", "securityStatusUnknown"));
  const requestedNonTradingCount = Object.values(perSymbol).filter((item) => item.requestedPriceStatus === "tradingHaltOrNoTrade").length;
  if (universeCodes.length > 0 && requestedNonTradingCount / universeCodes.length > requirements.maxRequestedNonTradingRatio) issues.push(issue("fatal", "excessiveRequestedNonTradingRatio", { count: requestedNonTradingCount, ratio: requestedNonTradingCount / universeCodes.length, threshold: requirements.maxRequestedNonTradingRatio }));

  const modelEligibility = {};
  for (const model of MODEL_VERSIONS) {
    const eligibleCodes = [];
    const ineligibleCodes = [];
    const reasons = {};
    for (const code of Object.keys(perSymbol).sort()) {
      const status = perSymbol[code].modelStatus[model];
      if (status === "eligible") eligibleCodes.push(code);
      else {
        ineligibleCodes.push(code);
        reasons[code] = status;
      }
    }
    modelEligibility[model] = { eligibleCodes, ineligibleCodes, reasons };
  }

  const hasStructuralErrors = issues.some((entry) => entry.severity === "fatal");
  const allModelsEligible = MODEL_VERSIONS.every((model) => modelEligibility[model].ineligibleCodes.length === 0);
  const provisionalReasons = [...new Set(issues.filter((entry) => entry.severity === "warning").map((entry) => entry.type))].sort();
  const grade = hasStructuralErrors ? "REJECTED" : provisionalReasons.length > 0 ? "PROVISIONAL" : "CERTIFIED";

  return {
    schemaVersion: MARKET_DATA_QUALITY_SCHEMA_VERSION,
    status: hasStructuralErrors ? "failed" : "passed",
    grade,
    eligibleForSnapshot: !hasStructuralErrors && allModelsEligible,
    eligibleForOptimization: grade === "CERTIFIED" && allModelsEligible,
    requestedDate,
    summary: {
      expectedUniverseCount: requirements.expectedUniverseCount,
      universeRecordCount: universeRecords.length,
      normalizedUniverseCodeCount: universeCodeSet.size,
      historyCodeCount: historyCodeSet.size,
      exactDateMatches,
      missingHistoryCodes,
      unexpectedHistoryCodes,
      duplicateUniverseCodes,
      duplicateDateRows,
      invalidOhlcvRows,
      zeroVolumeRows,
      insufficientHistorySymbols,
      structuralStatus: hasStructuralErrors ? "failed" : "passed",
      provisionalReasons,
    },
    requirements: {
      indicators: INDICATOR_HISTORY_REQUIREMENTS,
      models: MODEL_HISTORY_REQUIREMENTS,
    },
    issues,
    perSymbol,
    modelEligibility,
  };
}
