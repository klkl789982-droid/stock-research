import { classifyMarketDataRow } from "./market-data-quality-validator.mjs";
import { normalizeStockCode } from "./stock-code.mjs";

// Deliberately unconnected to the collector, Daily, LIVE, publication, or cron.
// The overlap length is a research parameter, not a new operational threshold.
export const KIS_INCREMENTAL_RESEARCH_VERSION = "kis-incremental-research-v1";
export const KIS_INCREMENTAL_RESEARCH_POLICY = Object.freeze({
  researchOnly: true,
  requiredRows: 260,
  overlapRows: 20,
  recentPageCapacity: 100,
  adjustment: "unadjusted",
  priceBasis: "kisDailyBarUnadjusted",
  corporateMetadataPolicy: "NULL_ONLY_UNTIL_OFFICIAL_CODE_CONTRACT_VERIFIED",
  outsideOverlapRevisionDetection: "NOT_POSSIBLE_WITH_INCREMENTAL_PAGE_ONLY",
});

export class KisIncrementalResearchError extends Error {
  constructor(code) { super(code); this.name = "KisIncrementalResearchError"; this.code = code; }
}
const fail = (code) => { throw new KisIncrementalResearchError(code); };
const iso = (date) => `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
const rowFields = ["basDt", "srtnCd", "mkp", "hipr", "lopr", "clpr", "trqu", "trPrc", "fltRt", "observationStatus"];
const adjustmentFields = ["date", "exDividendCode", "splitRatio", "changed", "reevaluationReason"];
const changeFields = ["date", "reportedDifference", "reportedSign"];
const pick = (value, fields) => Object.fromEntries(fields.map((field) => [field, value[field]]));
const equalFields = (left, right, fields) => fields.every((field) => left[field] === right[field]);

function dateOf(value) {
  const compact = typeof value === "string" ? value.replaceAll("-", "") : "";
  if (!/^\d{8}$/u.test(compact)) fail("KIS_INCREMENTAL_DATE_INVALID");
  const parsed = new Date(`${iso(compact)}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== iso(compact)) fail("KIS_INCREMENTAL_DATE_INVALID");
  return compact;
}

function optionsOf(requiredRows, overlapRows) {
  if (!Number.isInteger(requiredRows) || requiredRows < 1 || requiredRows > 260
    || !Number.isInteger(overlapRows) || overlapRows < 1 || overlapRows > 100 || overlapRows > requiredRows) fail("KIS_INCREMENTAL_OPTIONS_INVALID");
  return { requiredRows, overlapRows };
}

function metadataIndex(entries, dates, fields, type) {
  if (!Array.isArray(entries)) fail("KIS_INCREMENTAL_METADATA_MISSING");
  const result = new Map();
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") fail("KIS_INCREMENTAL_METADATA_INVALID");
    const compact = dateOf(entry.date);
    if (entry.date !== iso(compact) || !dates.has(compact)) fail("KIS_INCREMENTAL_METADATA_DATE_INVALID");
    if (result.has(compact)) fail("KIS_INCREMENTAL_METADATA_DUPLICATE_DATE");
    for (const field of fields.filter((field) => field !== "date")) {
      const value = entry[field];
      const numberField = ["splitRatio", "reportedDifference"].includes(field);
      if (value !== null && (numberField ? typeof value !== "number" || !Number.isFinite(value) : typeof value !== "string" || !/^[0-9A-Z._-]{1,24}$/u.test(value))) fail("KIS_INCREMENTAL_METADATA_INVALID");
    }
    result.set(compact, pick(entry, fields));
  }
  if (result.size !== dates.size) fail("KIS_INCREMENTAL_METADATA_MISSING");
  return { type, entries: result };
}

// Only already-parsed getHistory shapes are accepted. No public-portal rows are
// converted, rebased, synthesized, or spliced into a KIS history here.
function inspectHistory(history, maximumDate) {
  if (!history || !Array.isArray(history.rows) || history.rows.length < 1 || history.rows.length > 260) fail("KIS_INCREMENTAL_HISTORY_INVALID");
  const code = normalizeStockCode(history.code);
  if (!code) fail("KIS_INCREMENTAL_SYMBOL_INVALID");
  const referenceDate = dateOf(history.referenceDate);
  if (referenceDate > maximumDate) fail("KIS_INCREMENTAL_FUTURE_REFERENCE_DATE");
  const dates = new Set();
  const rows = history.rows.map((row, index) => {
    if (!row || typeof row !== "object") fail("KIS_INCREMENTAL_ROW_INVALID");
    const date = dateOf(row.basDt);
    if (row.basDt !== date) fail("KIS_INCREMENTAL_ROW_DATE_INVALID");
    if (date > referenceDate || date > maximumDate) fail("KIS_INCREMENTAL_FUTURE_ROW");
    if (dates.has(date)) fail("KIS_INCREMENTAL_DUPLICATE_DATE");
    if (index > 0 && history.rows[index - 1].basDt <= date) fail("KIS_INCREMENTAL_HISTORY_NOT_DESCENDING");
    if (row.srtnCd !== code) fail("KIS_INCREMENTAL_ROW_SYMBOL_MISMATCH");
    dates.add(date);
    if (!["mkp", "hipr", "lopr", "clpr", "trqu"].every((field) => typeof row[field] === "number" && Number.isFinite(row[field]))
      || !Number.isSafeInteger(row.trqu) || row.trqu < 0
      || !["trPrc", "fltRt"].every((field) => row[field] === null || typeof row[field] === "number" && Number.isFinite(row[field]))
      || row.trPrc !== null && row.trPrc < 0) fail("KIS_INCREMENTAL_ROW_INVALID");
    const classification = classifyMarketDataRow(row);
    if (classification.type === "invalidTradingRow") fail("KIS_INCREMENTAL_OHLCV_INVALID");
    const expectedStatus = classification.type === "nonTradingObservation" ? "tradingHaltOrNoTrade" : "trading";
    if (row.observationStatus !== expectedStatus) fail("KIS_INCREMENTAL_OBSERVATION_STATUS_INVALID");
    return pick(row, rowFields);
  });
  if (rows[0].basDt !== referenceDate) fail("KIS_INCREMENTAL_REFERENCE_DATE_MISSING");
  const adjustments = metadataIndex(history.adjustmentMetadata, dates, adjustmentFields, "adjustment").entries;
  const changes = metadataIndex(history.dailyChangeMetadata, dates, changeFields, "dailyChange").entries;
  return { code, referenceDate, rows, adjustments, changes, history };
}

function sourceReasons(value) {
  const history = value.history;
  const mapping = history.symbolMapping;
  const reasons = [];
  if (history.source !== "KIS" || history.sourceOperation !== "inquire-daily-itemchartprice" || history.marketDivision !== "J") reasons.push("notExclusiveCompatibleKisSource");
  if (history.adjustment !== "unadjusted" || history.priceBasis !== "kisDailyBarUnadjusted") reasons.push("unadjustedResearchBasisRequired");
  if (mapping?.status !== "VERIFIED_RESPONSE_TICKER" || mapping.requestedCode !== value.code || mapping.responseCode !== value.code) reasons.push("responseSymbolNotVerified");
  return reasons;
}

const hasSuppliedAdjustmentIndicator = (value) => [...value.adjustments.values()].some((entry) => adjustmentFields.filter((field) => field !== "date").some((field) => entry[field] !== null));

const decision = (status, reasons, details = {}) => ({
  researchVersion: KIS_INCREMENTAL_RESEARCH_VERSION,
  researchOnly: true,
  status,
  reasons: [...new Set(reasons)],
  eligibleForProduction: false,
  eligibleForOfficialRanking: false,
  eligibleForPublication: false,
  validationScope: "KIS_PARSED_SHAPE_AND_EXACT_RECENT_OVERLAP_ONLY",
  corporateActionAbsenceCertified: false,
  modelEligibilityEvaluated: false,
  sourceFinality: "NOT_CONFIRMED",
  fullHistoryEquivalence: "NOT_VERIFIED",
  requiresPeriodicFullRevalidation: true,
  outsideOverlapRevisionDetection: KIS_INCREMENTAL_RESEARCH_POLICY.outsideOverlapRevisionDetection,
  ...details,
});

export function planKisEodIncrementalResearch({ cachedHistory, referenceDate, requiredRows = 260, overlapRows = 20 } = {}) {
  optionsOf(requiredRows, overlapRows);
  const reference = dateOf(referenceDate);
  const cached = inspectHistory(cachedHistory, reference);
  const reasons = sourceReasons(cached);
  if (cachedHistory.historyComplete !== true || cached.rows.length < requiredRows) reasons.push("incompleteCachedHistoryNeedsFullBackfill");
  if (hasSuppliedAdjustmentIndicator(cached)) reasons.push("corporateActionOrUnknownAdjustmentIndicator");
  if (reasons.length) return decision("REQUIRES_FULL_REVALIDATION", reasons);
  return decision("RESEARCH_SINGLE_PAGE_PLAN", [], {
    code: cached.code,
    referenceDate: iso(reference),
    cachedCutoffDate: iso(cached.referenceDate),
    overlapRows,
    // Existing provider is reused by a caller only in a separately approved
    // experiment; this pure planner makes no network or storage calls.
    providerRequest: { adjustment: "unadjusted", requiredRows: 100, maxPages: 1 },
    fullBackfillRequest: { adjustment: "unadjusted", requiredRows, maxPages: 5 },
    catchUpBound: "NEW_ROWS_PLUS_REQUIRED_OVERLAP_MUST_FIT_RECENT_PAGE",
  });
}

export function mergeKisEodIncrementalResearch({ cachedHistory, recentHistory, referenceDate, requiredRows = 260, overlapRows = 20 } = {}) {
  optionsOf(requiredRows, overlapRows);
  const reference = dateOf(referenceDate);
  const cached = inspectHistory(cachedHistory, reference);
  const recent = inspectHistory(recentHistory, reference);
  const reasons = [...sourceReasons(cached), ...sourceReasons(recent)];
  if (cached.code !== recent.code) reasons.push("symbolMismatch");
  if (recent.referenceDate !== reference) reasons.push("recentReferenceDateMismatch");
  if (cachedHistory.historyComplete !== true || cached.rows.length < requiredRows) reasons.push("incompleteCachedHistoryNeedsFullBackfill");
  if (recent.rows.length > 100 || recentHistory.pageCount !== 1) reasons.push("singleRecentPageRequired");
  if (reasons.length) return decision("REQUIRES_FULL_REVALIDATION", reasons);

  const cutoff = cached.rows[0].basDt;
  const cachedByDate = new Map(cached.rows.map((row) => [row.basDt, row]));
  const recentByDate = new Map(recent.rows.map((row) => [row.basDt, row]));
  const expectedOverlap = cached.rows.slice(0, overlapRows);
  if (expectedOverlap.some((row) => !recentByDate.has(row.basDt))) reasons.push("boundedOverlapNotFullyObserved");
  // Check the entire shared one-page interval, not only the minimum overlap.
  const recentOldest = recent.rows.at(-1).basDt;
  const expectedShared = cached.rows.filter((row) => row.basDt >= recentOldest);
  const actualShared = recent.rows.filter((row) => row.basDt <= cutoff);
  if (expectedShared.length !== actualShared.length || actualShared.some((row, index) => row.basDt !== expectedShared[index]?.basDt)) reasons.push("overlapContinuityMismatch");
  const sharedDates = recent.rows.filter((row) => cachedByDate.has(row.basDt)).map((row) => row.basDt);
  for (const date of sharedDates) {
    if (!equalFields(cachedByDate.get(date), recentByDate.get(date), rowFields)) reasons.push("overlapRowRevision");
    if (!equalFields(cached.adjustments.get(date), recent.adjustments.get(date), adjustmentFields)) reasons.push("overlapAdjustmentMetadataRevision");
    if (!equalFields(cached.changes.get(date), recent.changes.get(date), changeFields)) reasons.push("overlapDailyChangeMetadataRevision");
  }
  // Null is the only accepted "no supplied indicator" state. In particular,
  // 0, 00, N, 100 and other supplied codes are NOT guessed to mean neutral.
  // This intentionally blocks real pages until the official code contract is
  // verified; equality of a flag alone does not prove absence of an event.
  const suppliedAdjustmentIndicator = [cached, recent].some(hasSuppliedAdjustmentIndicator);
  if (suppliedAdjustmentIndicator) reasons.push("corporateActionOrUnknownAdjustmentIndicator");
  const newRows = recent.rows.filter((row) => row.basDt > cutoff);
  if (reference > cutoff && !newRows.length) reasons.push("newReferenceObservationMissing");
  const rows = [...newRows, ...cached.rows].slice(0, requiredRows);
  if (rows.length < requiredRows) reasons.push("mergedHistoryInsufficient");
  if (rows.some((row, index) => {
    const classification = classifyMarketDataRow(row, rows[index + 1], rows[index - 1]);
    return classification.type === "invalidTradingRow" || classification.postNonTradingPriceDiscontinuity;
  })) reasons.push("nonTradingBoundaryOrDiscontinuityNeedsFullRevalidation");
  const details = { code: cached.code, referenceDate: iso(reference), cachedCutoffDate: iso(cutoff), newRowsObserved: newRows.length, sharedRowsCompared: sharedDates.length, requiredOverlapRows: overlapRows };
  if (reasons.length) return decision("REQUIRES_FULL_REVALIDATION", reasons, details);

  const originFor = (date) => date > cutoff ? recent : cached;
  const newRowsRetained = rows.filter((row) => row.basDt > cutoff).length;
  return decision(newRows.length ? "RESEARCH_APPEND_ACCEPTED" : "RESEARCH_UNCHANGED", [], {
    ...details,
    // Not a provider getHistory result: receipt times remain per segment and
    // this object is explicitly unusable for operational publication.
    mergedHistory: {
      researchOnly: true, code: cached.code, referenceDate: iso(reference), source: "KIS", adjustment: "unadjusted", priceBasis: "kisDailyBarUnadjusted",
      rows: rows.map((row) => ({ ...row })),
      adjustmentMetadata: rows.map((row) => ({ ...originFor(row.basDt).adjustments.get(row.basDt) })),
      dailyChangeMetadata: rows.map((row) => ({ ...originFor(row.basDt).changes.get(row.basDt) })),
      coverage: {
        retainedObservations: rows.length, requiredObservations: requiredRows,
        validTradingObservations: rows.filter((row) => classifyMarketDataRow(row).type === "validTradingRow").length,
        fullHistoryCertified: false, modelEligibilityEvaluated: false,
      },
      provenance: {
        cacheReferenceDate: cachedHistory.referenceDate, cacheReceivedAt: cachedHistory.receivedAt ?? null,
        recentReferenceDate: recentHistory.referenceDate, recentReceivedAt: recentHistory.receivedAt ?? null,
        cachedRowsRetained: rows.length - newRowsRetained, newRowsRetained,
        finality: "NOT_CONFIRMED", externalHistorySpliced: false,
        metadataCodeContract: "UNVERIFIED_NULL_ONLY_RESEARCH_POLICY",
      },
    },
  });
}

export function estimateKisEodIncrementalResearchRequests({ symbolCount = 553, requiredRows = 260, pageCapacity = 100, fullVerificationEverySessions = 20 } = {}) {
  if (![symbolCount, requiredRows, pageCapacity, fullVerificationEverySessions].every((value) => Number.isInteger(value) && value > 0)) fail("KIS_INCREMENTAL_COST_OPTIONS_INVALID");
  const fullPagesPerSymbol = Math.ceil(requiredRows / pageCapacity);
  const fullDailyMinimumRequests = symbolCount * fullPagesPerSymbol;
  const singlePageIncrementalMinimumRequests = symbolCount;
  return {
    researchOnly: true,
    symbolCount,
    fullPagesPerSymbol,
    fullDailyMinimumRequests,
    singlePageIncrementalMinimumRequests,
    initialFullBackfillMinimumRequests: fullDailyMinimumRequests,
    retainedCacheObservations: symbolCount * requiredRows,
    periodicFullEverySessions: fullVerificationEverySessions,
    // A full refresh replaces, rather than adds to, that session's page fetch.
    periodicReplacementAverageMinimumRequests: singlePageIncrementalMinimumRequests + (fullDailyMinimumRequests - singlePageIncrementalMinimumRequests) / fullVerificationEverySessions,
    assumptions: ["completeMatureHistories", "singleRecentPageCoversNewRowsAndOverlap", "noRetriesOrFallbacks", "calendarAndTokenRequestsExcluded", "periodicIntervalIsResearchScenarioNotOperationalRecommendation"],
  };
}
