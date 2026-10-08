import assert from "node:assert/strict";
import { waitForDailyProductionDeployment } from "../lib/daily-production-deployment-verifier.mjs";

const jsonResponse = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

function deploymentFetch(sequence) {
  let round = 0;
  return async (url) => {
    const state = sequence[Math.min(round, sequence.length - 1)];
    if (url.includes("/api/top-stocks")) return jsonResponse({ rankingAsOfDate: state.date, freshness: { freshnessStatus: state.freshness ?? "fresh" } });
    if (url.includes("/api/model-performance")) return jsonResponse({ latestEodReferenceDate: state.date });
    if (url.includes("/api/daily-production-status")) {
      round += 1;
      return jsonResponse({ siteApiReferenceDate: state.date, publicationStatus: state.publicationStatus ?? "published" });
    }
    return jsonResponse({}, 404);
  };
}

const delayed = await waitForDailyProductionDeployment({
  siteUrl: "https://example.test",
  expectedReferenceDate: "2026-10-07",
  fetchImpl: deploymentFetch([{ date: "2026-10-06" }, { date: "2026-10-07" }]),
  sleep: async () => {}, maxAttempts: 3, delayMs: 0, now: () => "2026-10-08T00:00:00.000Z",
});
assert.equal(delayed.status, "VERIFIED", "Vercel 배포 지연 뒤 API가 최신 기준일을 반환하면 성공합니다.");
assert.equal(delayed.attemptCount, 2);

const failed = await waitForDailyProductionDeployment({
  siteUrl: "https://example.test",
  expectedReferenceDate: "2026-10-07",
  fetchImpl: deploymentFetch([{ date: "2026-10-06" }]),
  sleep: async () => {}, maxAttempts: 2, delayMs: 0, now: () => "2026-10-08T00:00:00.000Z",
});
assert.equal(failed.status, "FAILED", "Vercel/API가 끝까지 오래된 기준일이면 workflow를 실패시켜야 합니다.");
assert.equal(failed.reason, "REFERENCE_DATE_NOT_DEPLOYED");

let networkAttempts = 0;
const recoveredNetwork = await waitForDailyProductionDeployment({
  siteUrl: "https://example.test",
  expectedReferenceDate: "2026-10-07",
  fetchImpl: async (url) => {
    networkAttempts += 1;
    if (networkAttempts <= 3) throw new TypeError("fetch failed");
    return deploymentFetch([{ date: "2026-10-07" }])(url);
  },
  sleep: async () => {}, maxAttempts: 2, delayMs: 0, now: () => "2026-10-08T00:00:00.000Z",
});
assert.equal(recoveredNetwork.status, "VERIFIED", "일시적 배포/API 네트워크 오류는 제한된 재확인으로 복구합니다.");

console.log("daily production deployment verifier tests passed");
