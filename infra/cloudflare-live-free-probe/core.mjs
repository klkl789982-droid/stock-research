import { calculateIntradayModelTopScores, hashIntradayModelTop } from "../../lib/intraday-model-top-official-signal.mjs";
import { mergeProvisionalCandle } from "../../lib/intraday-model-b-official-signal.mjs";
import { OFFICIAL_SIGNAL_TIME, OFFICIAL_SIGNAL_WINDOW_END } from "../../lib/intraday-model-top-time-policy.mjs";

export const VERSIONS = Object.freeze(["A-v1", "B-v1", "C-v1", "D-v1"]);
export const SPACING_MS = 200;
// A DO fetch traverses runtime hops too. Leave headroom under the observed
// 50-subrequest invocation ceiling; never increase the Free-plan quota.
export const SHARD_SIZE = 8;
export async function fetchWithoutRedirects(input, init = {}, fetchImpl = fetch) {
  const response = await fetchImpl(input, { ...init, redirect: "manual" });
  if (!Number.isInteger(response.status) || response.status < 100 || response.status > 599) {
    await response.body?.cancel(); throw new Error("PROBE_HTTP_STATUS_UNVERIFIED");
  }
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel(); throw new Error("PROBE_REDIRECT_REJECTED");
  }
  return response;
}
export function verifyObservationWindow(date, evidence) {
  const start = Date.parse(`${date}T${OFFICIAL_SIGNAL_TIME}+09:00`), end = Date.parse(`${date}T${OFFICIAL_SIGNAL_WINDOW_END}+09:00`);
  const requested = Date.parse(evidence?.requestedAt), received = Date.parse(evidence?.receivedAt);
  const observed = Date.parse(`${evidence?.asOfDate}T${evidence?.asOfTime}+09:00`);
  if (![start, end, requested, received, observed].every(Number.isFinite) || evidence.asOfDate !== date
    || requested < start || received > end || requested > received || observed < start || observed > end || observed > received) throw new Error("PROBE_OBSERVATION_WINDOW_REJECTED");
  return evidence; // Never relabel a late response or overwrite its exchange time.
}
export function fixture(index) {
  if (!Number.isInteger(index) || index < 0 || index >= 553) throw new Error("PROBE_INDEX_INVALID");
  // Generated mathematical fixtures only: no market history, ticker or KIS data.
  const rows = Array.from({ length: 260 }, (_, i) => {
    const date = new Date(Date.UTC(2020, 0, 1) - i * 86400000).toISOString().slice(0, 10).replaceAll("-", "");
    const close = 2000 + index * 7 + (260 - i) * 2 + Math.round(Math.sin(i / 4 + index) * 15);
    return [date, close - 5, close + 10, close - 10, close, 100000 + (260 - i) * 100];
  });
  const previous = rows[0][4];
  return { rows, quote: { source: "SYNTHETIC_ONLY", asOfDate: "2020-01-02", asOfTime: "14:00:01", receivedAt: "2020-01-02T05:00:01.000Z",
    open: previous + 1, high: previous + 25, low: previous - 5, price: previous + 20, volume: 160000, change: 20, rate: 20 / previous * 100 } };
}
export function calculateFixture(index) {
  const { rows, quote } = fixture(index);
  const result = calculateIntradayModelTopScores(mergeProvisionalCandle(rows, quote), quote);
  if (!VERSIONS.every(version => Number.isFinite(result.scores[version]))) throw new Error("PROBE_SCORE_INVALID");
  return { index, scores: result.scores };
}
export function summarize(records) {
  const sorted = [...records].sort((a, b) => a.index - b.index);
  if (new Set(sorted.map(row => row.index)).size !== sorted.length) throw new Error("PROBE_DUPLICATE_RECORD");
  const top5 = Object.fromEntries(VERSIONS.map(version => [version, [...sorted].sort((a, b) => b.scores[version] - a.scores[version] || a.index - b.index)
    .slice(0, 5).map((row, i) => ({ index: row.index, rank: i + 1, score: row.scores[version] }))]));
  return { count: sorted.length, scoresHash: hashIntradayModelTop(sorted), top5, top5Hash: hashIntradayModelTop(top5) };
}
export function shards(count, size = SHARD_SIZE) {
  if (!Number.isInteger(count) || count < 1 || count > 553 || !Number.isInteger(size) || size < 1 || size > SHARD_SIZE) throw new Error("PROBE_PLAN_INVALID");
  return Array.from({ length: Math.ceil(count / size) }, (_, shard) => ({ start: shard * size, count: Math.min(size, count - shard * size) }));
}
export function budget({ eligible = 508, universe = 553, retryRequests = 102, prewarmSteps = 50, eodSteps = 0 } = {}) {
  shards(eligible); shards(universe);
  if (eligible > universe || [retryRequests, prewarmSteps, eodSteps].some(value => !Number.isInteger(value) || value < 0)) throw new Error("PROBE_BUDGET_INVALID");
  const normal = eligible * 2 + 4, upperRequests = normal + retryRequests;
  // One durable Workflow step per eight-symbol broker batch, plus deliberately
  // generous prewarm/control/recovery allowance. Retry requests are NOT license
  // to reset a 14:05 deadline. EOD keeps its existing non-LIVE Actions route.
  const steps = Math.ceil(eligible / SHARD_SIZE) + prewarmSteps + eodSteps + 10;
  return { eligible, universe, workflowShards: Math.ceil(eligible / SHARD_SIZE), collectionRequests: normal,
    upperRequests, rateFloorSeconds: normal / 5, retryFloorSeconds: upperRequests / 5,
    workflowSteps: steps, remainingDailySteps: 3000 - steps,
    oldPerSymbolStepUpperBound: eligible + steps,
    workflowPeakActiveIncludingCoordinator: Math.ceil(eligible / SHARD_SIZE) + 1,
    workflowDailyLimit: 3000, subrequestsPerShard: SHARD_SIZE * 2,
    assumedSeedBytes: 6500000, conservativeThreeDaySeedBytes: 6500000 * 3,
    brokerRequestsIncludingControl: upperRequests + 100,
    brokerConservativeSqlReads: (upperRequests + 100) * 10,
    brokerConservativeSqlWrites: (upperRequests + 100) * 5,
    brokerActiveGBSecondsForSixMinutes: .128 * 360,
    retainedWorkflowUpperBoundBytes: 100000000,
    brokerStatePerTradingDayUpperBoundBytes: 2000000,
    sourceHistoryRetentionPolicy: "UNAPPROVED_NOT_ACTIVATED",
    eodPath: "EXISTING_PUBLIC_REPO_STANDARD_ACTIONS_NOT_LIVE_COLLECTION",
    productionReady: false };
}
