import assert from "node:assert/strict";
import { CURRENT_LIVE_PROFILE } from "../lib/intraday-model-top-time-policy.mjs";
import { waitForDailyProductionDeployment, inspectLiveProductionDeployment } from "../lib/daily-production-deployment-verifier.mjs";

const expectedSnapshotHash = "a".repeat(64), expectedCommitSha = "b".repeat(40);
const identity = (date, state = {}) => ({ referenceDate: date, snapshotHash: state.hash ?? expectedSnapshotHash, commitSha: state.commit ?? expectedCommitSha });
const jsonResponse = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

function deploymentFetch(sequence) {
  let round = 0;
  return async (url) => {
    const state = sequence[Math.min(round, sequence.length - 1)];
    if (url.includes("/api/top-stocks")) return jsonResponse({ rankingAsOfDate: state.date, freshness: { freshnessStatus: state.freshness ?? "fresh" }, dataIdentity: identity(state.date, state), publicationReady: true });
    if (url.includes("/api/model-performance")) return jsonResponse({ latestEodReferenceDate: state.date, dataIdentity: identity(state.date, state), publicationReady: true });
    if (url.includes("/api/home-dashboard")) return jsonResponse({ referenceDate: state.date, dataIdentity: identity(state.date, state), publicationReady: state.homeReady ?? true });
    if (url.includes("/api/daily-production-status")) {
      round += 1;
      return jsonResponse({ siteApiReferenceDate: state.date, dataIdentity: identity(state.date, state), publicationReady: true, publicationStatus: state.publicationStatus ?? "published" });
    }
    return jsonResponse({}, 404);
  };
}

const delayed = await waitForDailyProductionDeployment({
  siteUrl: "https://example.test",
  expectedReferenceDate: "2026-10-07", expectedSnapshotHash, expectedCommitSha,
  fetchImpl: deploymentFetch([{ date: "2026-10-06" }, { date: "2026-10-07" }]),
  sleep: async () => {}, maxAttempts: 3, delayMs: 0, now: () => "2026-10-08T00:00:00.000Z",
});
assert.equal(delayed.status, "VERIFIED", "Vercel 배포 지연 뒤 API가 최신 기준일을 반환하면 성공합니다.");
assert.equal(delayed.attemptCount, 2);

const failed = await waitForDailyProductionDeployment({
  siteUrl: "https://example.test",
  expectedReferenceDate: "2026-10-07", expectedSnapshotHash, expectedCommitSha,
  fetchImpl: deploymentFetch([{ date: "2026-10-06" }]),
  sleep: async () => {}, maxAttempts: 2, delayMs: 0, now: () => "2026-10-08T00:00:00.000Z",
});
assert.equal(failed.status, "FAILED", "Vercel/API가 끝까지 오래된 기준일이면 workflow를 실패시켜야 합니다.");
assert.equal(failed.reason, "REFERENCE_DATE_NOT_DEPLOYED");

let networkAttempts = 0;
const recoveredNetwork = await waitForDailyProductionDeployment({
  siteUrl: "https://example.test",
  expectedReferenceDate: "2026-10-07", expectedSnapshotHash, expectedCommitSha,
  fetchImpl: async (url) => {
    networkAttempts += 1;
    if (networkAttempts <= 4) throw new TypeError("fetch failed");
    return deploymentFetch([{ date: "2026-10-07" }])(url);
  },
  sleep: async () => {}, maxAttempts: 2, delayMs: 0, now: () => "2026-10-08T00:00:00.000Z",
});
assert.equal(recoveredNetwork.status, "VERIFIED", "일시적 배포/API 네트워크 오류는 제한된 재확인으로 복구합니다.");

const unauthorized = await waitForDailyProductionDeployment({ siteUrl: "https://example.test", expectedReferenceDate: "2026-10-07", expectedSnapshotHash, expectedCommitSha, fetchImpl: async () => jsonResponse({}, 401), sleep: async () => { throw new Error("auth must not retry"); } });
assert.equal(unauthorized.attemptCount, 1); assert.equal(unauthorized.reason, "HTTP_401");
for (const [date, type, expected] of [["2026-10-08", "LIVE_OBSERVATION", true], ["2026-10-07", "LIVE_OBSERVATION", false], ["2026-10-08", "TEST_FIXTURE", false]]) {
  assert.equal(await inspectLiveProductionDeployment({ siteUrl: "https://example.test", expectedSignalDate: "2026-10-08", expectedContentHash: expectedSnapshotHash, fetchImpl: async () => jsonResponse({ signalDate: date, observationType: type, archived: false, officialSignalTime: CURRENT_LIVE_PROFILE.signalTime, signalVersion: CURRENT_LIVE_PROFILE.signalVersion, observationPolicyId: CURRENT_LIVE_PROFILE.policyId, contentHash: expectedSnapshotHash, signalPath: `data/intraday-signals/model-top/${date}/1400.json`, collectionStartedAt: "2026-10-08T05:00:00Z", collectionCompletedAt: "2026-10-08T05:04:00Z" }) }), expected);
}
for (const [state, reason] of [[{ date: "2026-10-07", hash: "c".repeat(64) }, "SNAPSHOT_HASH_MISMATCH"], [{ date: "2026-10-07", commit: "d".repeat(40) }, "SITE_COMMIT_MISMATCH"], [{ date: "2026-10-07", homeReady: false }, "SITE_SUMMARY_UNAVAILABLE"]]) {
  const result = await waitForDailyProductionDeployment({ siteUrl: "https://example.test", expectedReferenceDate: "2026-10-07", expectedSnapshotHash, expectedCommitSha, fetchImpl: deploymentFetch([state]), maxAttempts: 1 });
  assert.equal(result.status, "FAILED"); assert.equal(result.reason, reason); assert.equal(result.verifiedAt, null); assert.ok(result.checkedAt);
}
for (const status of [401, 403]) {
  const result = await waitForDailyProductionDeployment({ siteUrl: "https://example.test", expectedReferenceDate: "2026-10-07", expectedSnapshotHash, expectedCommitSha, fetchImpl: async () => jsonResponse({}, status), maxAttempts: 2 });
  assert.equal(result.reason, `HTTP_${status}`); assert.equal(result.attemptCount, 1);
}
const timeout = await waitForDailyProductionDeployment({ siteUrl: "https://example.test", expectedReferenceDate: "2026-10-07", expectedSnapshotHash, expectedCommitSha, fetchImpl: async () => { throw new DOMException("private diagnostic", "TimeoutError"); }, maxAttempts: 1 });
assert.equal(timeout.reason, "REQUEST_TIMEOUT");
const missing = await waitForDailyProductionDeployment({ siteUrl: "https://example.test", expectedReferenceDate: "2026-10-07", fetchImpl: async () => { throw new Error("must not fetch"); }, maxAttempts: 2 });
assert.equal(missing.reason, "EXPECTED_IDENTITY_MISSING"); assert.equal(missing.attemptCount, 1);
const future = await waitForDailyProductionDeployment({ siteUrl: "https://example.test", expectedReferenceDate: "2099-10-07", expectedSnapshotHash, expectedCommitSha, fetchImpl: async () => { throw new Error("future must not fetch"); }, maxAttempts: 1 });
assert.equal(future.status, "FAILED"); assert.equal(future.reason, "EXPECTED_IDENTITY_MISSING");
console.log("daily/LIVE production deployment verifier tests passed");
