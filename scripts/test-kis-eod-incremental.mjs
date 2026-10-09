import assert from "node:assert/strict";
import { createKisEodProvider } from "../lib/kis-eod-provider.mjs";
import { calculateSnapshotModels } from "../lib/model-score-engine.mjs";
import { normalizeModelInputRows } from "../lib/market-data-quality-validator.mjs";
import { estimateKisEodIncrementalResearchRequests, KisIncrementalResearchError, mergeKisEodIncrementalResearch, planKisEodIncrementalResearch } from "../lib/kis-eod-incremental-research.mjs";

const code = "005930", referenceDate = "2026-10-08", receivedAt = "2026-10-08T11:10:00.000Z";
const dates = [];
for (let instant = new Date(`${referenceDate}T00:00:00Z`); dates.length < 280; instant.setUTCDate(instant.getUTCDate() - 1)) {
  if (![0, 6].includes(instant.getUTCDay())) dates.push(instant.toISOString().slice(0, 10).replaceAll("-", ""));
}
// Synthetic weekdays are fixture dates, not an exchange-calendar claim.
const rawBars = dates.map((date, index) => {
  const close = 10000 + (280 - index) * 7 + index % 11 * 13;
  return { stck_bsop_date: date, stck_oprc: String(close - 10), stck_hgpr: String(close + 40), stck_lwpr: String(close - 50), stck_clpr: String(close), acml_vol: String(100000 + index * 100), acml_tr_pbmn: String(close * 100000), prdy_ctrt: "0.5", prdy_vrss: "10", prdy_vrss_sign: "2", prtt_rate: "", flng_cls_code: "", mod_yn: "", revl_issu_reas: "" };
});
const clone = (value) => structuredClone(value);
async function collect(bars, date, options = {}) {
  let calls = 0;
  const provider = createKisEodProvider({
    client: { request: async (input) => {
      calls += 1;
      const end = new URL(input).searchParams.get("FID_INPUT_DATE_2");
      const payload = { rt_cd: "0", output1: { stck_shrn_iscd: code }, output2: bars.filter((row) => row.stck_bsop_date <= end).slice(0, 100) };
      return new Response(JSON.stringify(payload), { status: 200 });
    } }, wait: async () => {}, now: () => receivedAt, delayMs: 0,
  });
  return { history: await provider.getHistory(code, date, options), calls };
}
const full = await collect(rawBars, referenceDate);
const cached = await collect(rawBars.slice(1), dates[1]);
const recent = await collect(rawBars, referenceDate, { requiredRows: 100, maxPages: 1 });
const input = { cachedHistory: cached.history, recentHistory: recent.history, referenceDate };
const merge = (overrides = {}) => mergeKisEodIncrementalResearch({ ...input, ...overrides });
const requireFull = (result, reason) => {
  assert.equal(result.status, "REQUIRES_FULL_REVALIDATION");
  assert.ok(result.reasons.includes(reason), JSON.stringify(result.reasons));
  assert.equal(result.mergedHistory, undefined);
};
let checks = 0;
async function test(name, body) { await body(); checks += 1; console.log(`PASS ${name}`); }

await test("pure single-page research plan reuses existing provider parameters", () => {
  const plan = planKisEodIncrementalResearch({ cachedHistory: cached.history, referenceDate });
  assert.equal(plan.status, "RESEARCH_SINGLE_PAGE_PLAN");
  assert.deepEqual(plan.providerRequest, { adjustment: "unadjusted", requiredRows: 100, maxPages: 1 });
  assert.equal(plan.cachedCutoffDate, "2026-10-07");
  assert.equal(plan.eligibleForProduction, false);
});
await test("new-date append equals full KIS fixture input and all unchanged model outputs", () => {
  const before = clone(input);
  const result = merge();
  assert.equal(result.status, "RESEARCH_APPEND_ACCEPTED");
  assert.equal(result.newRowsObserved, 1);
  assert.equal(result.sharedRowsCompared, 99);
  assert.deepEqual(result.mergedHistory.rows, full.history.rows);
  assert.deepEqual(result.mergedHistory.adjustmentMetadata, full.history.adjustmentMetadata);
  assert.deepEqual(result.mergedHistory.dailyChangeMetadata, full.history.dailyChangeMetadata);
  const mergedModels = calculateSnapshotModels(normalizeModelInputRows(result.mergedHistory.rows));
  const fullModels = calculateSnapshotModels(normalizeModelInputRows(full.history.rows));
  assert.deepEqual(mergedModels, fullModels);
  for (const value of [mergedModels.modelA.finalTechnicalScore, mergedModels.modelAV2.finalScore, mergedModels.modelB.trendStrength, mergedModels.modelC.entryStrength, mergedModels.modelD]) assert.ok(Number.isFinite(value));
  assert.deepEqual(input, before);
  assert.equal(result.eligibleForPublication, false);
  assert.equal(result.mergedHistory.provenance.externalHistorySpliced, false);
  assert.equal(result.fullHistoryEquivalence, "NOT_VERIFIED");
});
await test("same-date repeat is unchanged rather than duplicate append", () => {
  const result = merge({ cachedHistory: full.history });
  assert.equal(result.status, "RESEARCH_UNCHANGED");
  assert.equal(result.newRowsObserved, 0);
  assert.deepEqual(result.mergedHistory.rows, full.history.rows);
});
await test("multi-day bounded catch-up retains exact full fixture with segment provenance", async () => {
  const oldCache = await collect(rawBars.slice(10), dates[10]);
  const result = merge({ cachedHistory: oldCache.history });
  assert.equal(result.status, "RESEARCH_APPEND_ACCEPTED");
  assert.equal(result.newRowsObserved, 10);
  assert.equal(result.sharedRowsCompared, 90);
  assert.deepEqual(result.mergedHistory.rows, full.history.rows);
  assert.deepEqual(calculateSnapshotModels(normalizeModelInputRows(result.mergedHistory.rows)), calculateSnapshotModels(normalizeModelInputRows(full.history.rows)));
  assert.equal(result.mergedHistory.provenance.newRowsRetained, 10);
  assert.equal(result.mergedHistory.provenance.cachedRowsRetained, 250);
  assert.equal(result.mergedHistory.receivedAt, undefined);
  const trimmed = merge({ cachedHistory: oldCache.history, requiredRows: 1, overlapRows: 1 });
  assert.equal(trimmed.mergedHistory.provenance.newRowsRetained, 1);
  assert.equal(trimmed.mergedHistory.provenance.cachedRowsRetained, 0);
});
await test("all shared rows are compared beyond the minimum research overlap", () => {
  const revised = clone(recent.history);
  revised.rows[70].trqu += 1;
  requireFull(merge({ recentHistory: revised }), "overlapRowRevision");
});
await test("adjustment and daily-change metadata revisions require full revalidation", () => {
  const adjustment = clone(recent.history);
  adjustment.adjustmentMetadata[2].changed = "Y";
  requireFull(merge({ recentHistory: adjustment }), "overlapAdjustmentMetadataRevision");
  const daily = clone(recent.history);
  daily.dailyChangeMetadata[2].reportedDifference += 1;
  requireFull(merge({ recentHistory: daily }), "overlapDailyChangeMetadataRevision");
});
await test("any supplied corporate-action or unknown code blocks blind append", () => {
  for (const [field, value] of [["exDividendCode", "00"], ["splitRatio", 0], ["splitRatio", 2], ["changed", "N"], ["changed", "Y"], ["reevaluationReason", "0"]]) {
    const valueHistory = clone(recent.history);
    valueHistory.adjustmentMetadata[0][field] = value;
    requireFull(merge({ recentHistory: valueHistory }), "corporateActionOrUnknownAdjustmentIndicator");
  }
  const baselineEvent = clone(cached.history);
  baselineEvent.adjustmentMetadata[200].splitRatio = 2;
  requireFull(merge({ cachedHistory: baselineEvent }), "corporateActionOrUnknownAdjustmentIndicator");
  requireFull(planKisEodIncrementalResearch({ cachedHistory: baselineEvent, referenceDate }), "corporateActionOrUnknownAdjustmentIndicator");
});
await test("mixed source, symbol, adjusted basis, or unverified ticker is not merged", () => {
  for (const [field, value, reason] of [["source", "PUBLIC_DATA_PORTAL", "notExclusiveCompatibleKisSource"], ["priceBasis", "publicUnadjusted", "unadjustedResearchBasisRequired"], ["adjustment", "adjusted", "unadjustedResearchBasisRequired"], ["marketDivision", "X", "notExclusiveCompatibleKisSource"]]) {
    const history = clone(recent.history); history[field] = value;
    requireFull(merge({ recentHistory: history }), reason);
  }
  const unmapped = clone(recent.history); unmapped.symbolMapping.status = "UNVERIFIED_RESPONSE_TICKER_ABSENT";
  requireFull(merge({ recentHistory: unmapped }), "responseSymbolNotVerified");
  const another = clone(recent.history); another.code = "000660"; another.rows.forEach((row) => { row.srtnCd = "000660"; }); another.symbolMapping = { requestedCode: "000660", responseCode: "000660", status: "VERIFIED_RESPONSE_TICKER" };
  requireFull(merge({ recentHistory: another }), "symbolMismatch");
});
await test("new IPO and incomplete baseline are full-backfill cases, not normal cache coverage", async () => {
  const short = await collect(rawBars.slice(1, 51), dates[1]);
  assert.equal(short.history.historyComplete, false);
  requireFull(merge({ cachedHistory: short.history }), "incompleteCachedHistoryNeedsFullBackfill");
  requireFull(planKisEodIncrementalResearch({ cachedHistory: short.history, referenceDate }), "incompleteCachedHistoryNeedsFullBackfill");
});
await test("insufficient overlap or catch-up larger than page requests full revalidation", async () => {
  const shortRecent = await collect(rawBars.slice(0, 15), referenceDate, { requiredRows: 100, maxPages: 1 });
  requireFull(merge({ recentHistory: shortRecent.history }), "boundedOverlapNotFullyObserved");
  const oldCache = await collect(rawBars.slice(100), dates[100], { requiredRows: 160 });
  requireFull(merge({ cachedHistory: oldCache.history, requiredRows: 160 }), "boundedOverlapNotFullyObserved");
});
await test("overlap gap requires full revalidation without guessed calendar days", () => {
  const missing = clone(recent.history);
  const [row] = missing.rows.splice(50, 1);
  const date = `${row.basDt.slice(0, 4)}-${row.basDt.slice(4, 6)}-${row.basDt.slice(6, 8)}`;
  missing.adjustmentMetadata = missing.adjustmentMetadata.filter((entry) => entry.date !== date);
  missing.dailyChangeMetadata = missing.dailyChangeMetadata.filter((entry) => entry.date !== date);
  requireFull(merge({ recentHistory: missing }), "overlapContinuityMismatch");
});
await test("malformed/future/duplicate rows and metadata are errors, not coercions", () => {
  const duplicate = clone(recent.history); duplicate.rows[1] = clone(duplicate.rows[0]);
  assert.throws(() => merge({ recentHistory: duplicate }), /KIS_INCREMENTAL_DUPLICATE_DATE/u);
  const future = clone(recent.history); future.rows[0].basDt = "20261009";
  assert.throws(() => merge({ recentHistory: future }), /KIS_INCREMENTAL_FUTURE_ROW/u);
  const invalid = clone(recent.history); invalid.rows[0].basDt = "20260230";
  assert.throws(() => merge({ recentHistory: invalid }), /KIS_INCREMENTAL_DATE_INVALID/u);
  const missing = clone(recent.history); missing.adjustmentMetadata.pop();
  assert.throws(() => merge({ recentHistory: missing }), /KIS_INCREMENTAL_METADATA_MISSING/u);
  const metaDuplicate = clone(recent.history); metaDuplicate.dailyChangeMetadata[1] = clone(metaDuplicate.dailyChangeMetadata[0]);
  assert.throws(() => merge({ recentHistory: metaDuplicate }), /KIS_INCREMENTAL_METADATA_DUPLICATE_DATE/u);
  const numeric = clone(recent.history); numeric.rows[0].clpr = "123";
  assert.throws(() => merge({ recentHistory: numeric }), /KIS_INCREMENTAL_ROW_INVALID/u);
  const wrongSymbol = clone(recent.history); wrongSymbol.rows[0].srtnCd = "000660";
  assert.throws(() => merge({ recentHistory: wrongSymbol }), /KIS_INCREMENTAL_ROW_SYMBOL_MISMATCH/u);
  assert.throws(() => merge({ referenceDate: "2026-10-07" }), /KIS_INCREMENTAL_FUTURE_REFERENCE_DATE/u);
  assert.throws(() => merge({ overlapRows: 101 }), KisIncrementalResearchError);
});
await test("non-trading boundary discontinuity requires full revalidation", () => {
  const haltedCache = clone(cached.history), haltedRecent = clone(recent.history);
  const halt = (row) => Object.assign(row, { mkp: 0, hipr: 0, lopr: 0, trqu: 0, observationStatus: "tradingHaltOrNoTrade" });
  halt(haltedCache.rows[0]); halt(haltedRecent.rows[1]);
  requireFull(merge({ cachedHistory: haltedCache, recentHistory: haltedRecent }), "nonTradingBoundaryOrDiscontinuityNeedsFullRevalidation");
});
await test("unknown revision outside overlap cannot be certified; full fixture detects model drift", () => {
  const revisedFull = clone(full.history);
  for (const field of ["mkp", "hipr", "lopr", "clpr"]) revisedFull.rows[160][field] += 1000;
  const result = merge();
  assert.equal(result.status, "RESEARCH_APPEND_ACCEPTED");
  assert.equal(result.outsideOverlapRevisionDetection, "NOT_POSSIBLE_WITH_INCREMENTAL_PAGE_ONLY");
  assert.equal(result.requiresPeriodicFullRevalidation, true);
  assert.equal(result.mergedHistory.coverage.fullHistoryCertified, false);
  assert.notDeepEqual(result.mergedHistory.rows, revisedFull.rows);
  assert.notDeepEqual(calculateSnapshotModels(normalizeModelInputRows(result.mergedHistory.rows)), calculateSnapshotModels(normalizeModelInputRows(revisedFull.rows)));
});
await test("553-symbol request/storage scenarios exclude retries and do not promise time", () => {
  const costs = estimateKisEodIncrementalResearchRequests();
  assert.equal(full.calls, 3); assert.equal(recent.calls, 1);
  assert.equal(costs.fullDailyMinimumRequests, 1659);
  assert.equal(costs.singlePageIncrementalMinimumRequests, 553);
  assert.equal(costs.retainedCacheObservations, 143780);
  assert.equal(costs.periodicReplacementAverageMinimumRequests, 608.3);
  assert.throws(() => estimateKisEodIncrementalResearchRequests({ fullVerificationEverySessions: 0 }), KisIncrementalResearchError);
});
console.log(`KIS incremental research: ${checks} synthetic tests passed; no live API, persistence, publication, formula, or collector changes.`);
