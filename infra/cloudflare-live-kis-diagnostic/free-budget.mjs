// Offline planning only: never treats rounded/delayed account analytics as an
// authoritative admission token and never assumes a future reset has occurred.
export const FREE_LIMITS = Object.freeze({ workflowSteps: 3000, workerRequests: 100000,
  doRequests: 100000, durationGbSeconds: 13000, sqlRowsRead: 5000000, sqlRowsWritten: 100000,
  storageBytes: 5000000000, workflowStorageGbMonths: 1 });
export const PC_AND_EOD_RESERVE = Object.freeze({ workflowSteps: 0, workerRequests: 1000,
  doRequests: 0, durationGbSeconds: 0, sqlRowsRead: 0, sqlRowsWritten: 0, storageBytes: 0, workflowStorageGbMonths: 0 });
// Conservative planning allocation, NOT a measured per-run guarantee or an
// account-wide enforced counter. Includes an allowance for bounded retries.
export const CLOUD_LIVE_CANDIDATE = Object.freeze({ workflowSteps: 200, workerRequests: 2000,
  doRequests: 12000, durationGbSeconds: 8000, sqlRowsRead: 3800000, sqlRowsWritten: 80000,
  storageBytes: 8000000, workflowStorageGbMonths: 0.001 });
export function nextUtcReset(nowMs) {
  return new Date(Math.floor(nowMs / 86400000) * 86400000 + 86400000).toISOString();
}
export function reviewFreeBudget({ snapshot, nowMs, reserve = PC_AND_EOD_RESERVE, candidate = CLOUD_LIVE_CANDIDATE }) {
  const reasons = [], remaining = {};
  if (!Number.isFinite(nowMs) || !Number.isFinite(Date.parse(snapshot?.observedAt))) throw new Error("BUDGET_SNAPSHOT_INVALID");
  const today = new Date(nowMs).toISOString().slice(0, 10);
  if (snapshot.utcDay !== today) reasons.push("FRESH_POST_RESET_SNAPSHOT_REQUIRED");
  if (snapshot.exact !== true || snapshot.aggregationLagMs !== 0) reasons.push("ROUNDED_OR_DELAYED_ACCOUNT_ANALYTICS");
  if (nowMs - Date.parse(snapshot.observedAt) > 600000 || nowMs < Date.parse(snapshot.observedAt)) reasons.push("ACCOUNT_SNAPSHOT_STALE");
  for (const [name, limit] of Object.entries(FREE_LIMITS)) {
    const used = snapshot.upperBound?.[name], held = reserve[name], planned = candidate[name];
    if (![used, held, planned].every(value => Number.isFinite(value) && value >= 0)) { reasons.push(`BUDGET_UNKNOWN_${name}`); continue; }
    remaining[name] = Math.max(0, limit - used - held);
    if (used + held + planned > limit) reasons.push(`BUDGET_INSUFFICIENT_${name}`);
  }
  return { status: reasons.length ? "BLOCKED" : "PLANNING_FITS", reasons, remainingAfterOperationalReserve: remaining,
    nextWorkersAndDoUtcReset: nextUtcReset(nowMs), storageResetsDaily: false, paidFallback: false,
    // Passing an offline estimate alone never authorizes an actual full run.
    actualCollectionAuthorized: false };
}
