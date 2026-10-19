import { normalDayBudget } from "./production-core.mjs";

// Admission is a conservative reservation, NOT an assertion of exact billing
// or a fabricated zero analytics delay. Free platform caps remain authoritative.
export const LAG_RESERVE = Object.freeze({ workflowSteps: 100, workerRequests: 500, doRequests: 1000,
  durationGbSeconds: 1000, sqlRowsRead: 500000, sqlRowsWritten: 10000 });
const fields = { workflowSteps: "workflowAllOperationsReported", workerRequests: "workersRequestsReported",
  doRequests: "doRequestsReported", durationGbSeconds: "doDurationRawMetric", sqlRowsRead: "sqlRowsReadReported", sqlRowsWritten: "sqlRowsWrittenReported" };
export function admitFreeBudget({ before, latest, inventory, workersFree, noPaymentMethod }, now = Date.now()) {
  if (workersFree !== true || noPaymentMethod !== true || inventory?.workerCount !== 4 || inventory?.workflowCount !== 3
    || inventory?.activeInstances !== 0 || inventory?.allPagesRead !== true || inventory?.zeroMonthOpeningWorkflowState !== true
    || inventory?.onlyDailyCronActive !== true || inventory?.noAdditionalCollectionSinceLastReceipt !== true) throw new Error("FREE_INVENTORY_UNVERIFIED");
  const start = Date.parse(before?.observedAt), end = Date.parse(latest?.observedAt), checked = Date.parse(inventory?.checkedAt);
  if (![start, end, checked, now].every(Number.isFinite) || end - start < 1800000 || now < end || now - end > 900000
    || now < checked || now - checked > 900000 || before.utcDay !== latest.utcDay || latest.utcDay !== new Date(now).toISOString().slice(0, 10)) throw new Error("FREE_SNAPSHOT_STALE");
  const upperBound = {}, headroom = {};
  for (const [key, name] of Object.entries(fields)) {
    const a = before[name], b = latest[name];
    if (!Number.isFinite(a) || !Number.isFinite(b) || a < 0 || b < a) throw new Error("FREE_METRIC_UNVERIFIED");
    // Since all collection instances have ended, a late increment beyond the
    // explicitly bounded metadata/EOD tail requires another review, not zero.
    if (b - a > LAG_RESERVE[key]) throw new Error("FREE_ANALYTICS_NOT_SETTLED");
    upperBound[key] = b + LAG_RESERVE[key];
    headroom[key] = normalDayBudget()[key].limit - upperBound[key] - normalDayBudget()[key].total;
    if (headroom[key] < 0) throw new Error(`FREE_DAILY_BUDGET_${key}`);
  }
  const storage = latest.workflowStorageEvidence;
  if (latest.doDurationUnit !== "GB_SECONDS_OFFICIAL_SCHEMA" || storage?.completeUnsampledRows !== true
    || storage.unit !== "BYTES_OFFICIAL_SCHEMA" || !Number.isFinite(storage.positiveGrowthBytes)
    || !Number.isFinite(latest.persistentSqlNamespacePeakBytes)) throw new Error("FREE_STORAGE_UNVERIFIED");
  // Double all observed positive month growth (ignoring releases), then add
  // 10MB for delayed events. Charge that whole peak for all30days. In addition,
  // normalDayBudget reserves40MB for three retained LIVE days incl retry state.
  const workflowStorageGbMonthsUpperBound = (storage.positiveGrowthBytes * 2 + 10000000) / 1e9;
  const persistentSqlBytes = Math.max(100000000, latest.persistentSqlNamespacePeakBytes + 10000000);
  if (workflowStorageGbMonthsUpperBound + 0.04 >= 1 || persistentSqlBytes + 2000000 >= 4000000000) throw new Error("FREE_STORAGE_BUDGET");
  return { schemaVersion: 1, utcDay: latest.utcDay, observedAt: latest.observedAt, workersFree: true, inventoryVerified: true, storageVerified: true,
    upperBound, headroomAfterAnotherWholeNormalDay: headroom, persistentSqlBytes, workflowStorageGbMonthsUpperBound,
    lagReserve: LAG_RESERVE, aggregationLagMs: null, exactBillingClaimed: false, boundType: "CONSERVATIVE_ADMISSION_RESERVATION",
    assumptions: "Complete fixed-resource inventory, no active collection or additional trials; re-admit before any extra collection or resource expansion. Free hard limits stop rather than charge.",
    normalDay: normalDayBudget(), workflowRetentionDays: 3, sqlDailyCapBytes: 2000000, sqlGlobalReserveStopBytes: 4000000000,
    storageDailyReset: false, paidFallback: false };
}
