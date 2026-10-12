import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { requestKisWithTransientRetry } from "../lib/kis-intraday-collector.mjs";
import { liveSchedulerMetadata, liveStatusLabel, liveAttemptStatus } from "../lib/intraday-model-top-time-policy.mjs";

test("LIVE retries rate limits once, preserves old callers and never retries auth failures", async () => {
  for (const [status, retryRateLimit, expected] of [[429, true, 2], [429, false, 1], [401, true, 1], [403, true, 1], [503, true, 2]]) {
    let calls = 0;
    const result = await requestKisWithTransientRetry({ retryRateLimit, request: async () => { calls++; return { ok: false, status }; }, wait: async () => {} });
    assert.equal(result.status, status); assert.equal(calls, expected);
  }
  let calls = 0;
  assert.equal((await requestKisWithTransientRetry({ retryRateLimit: true, request: async () => ++calls === 1 ? { status: 429 } : { ok: true }, wait: async () => {} })).ok, true);
  // If a retry crosses the real window, the guard error is never retried again.
  calls = 0;
  await assert.rejects(requestKisWithTransientRetry({ retryRateLimit: true, request: async () => { if (++calls === 1) return { status: 503 }; throw new Error("QUOTE_COLLECTION_WINDOW_EXPIRED"); }, wait: async () => {} }), /QUOTE_COLLECTION_WINDOW_EXPIRED/u);
  assert.equal(calls, 2);
});
test("metadata is diagnostic only; no fabricated nominal time or secret reflection", () => {
  const env = { INTRADAY_TRIGGER_TYPE: "workflow_dispatch", INTRADAY_TRIGGER_SOURCE: "cloudflare-live-prewarm", INTRADAY_SCHEDULED_AT: "2026-10-12T05:12:00Z" };
  const actual = "2026-10-12T05:13:07Z";
  const result = liveSchedulerMetadata(env, actual);
  assert.equal(result.schedulerToScriptDelayMs, 67000);
  assert.equal(result.scriptStartedAt, actual); assert.equal(result.runnerFirstStepAt, null);
  assert.equal(liveSchedulerMetadata({ ...env, INTRADAY_RUNNER_FIRST_STEP_AT: "2026-10-12T05:13:00Z" }, actual).runnerFirstStepAt, "2026-10-12T05:13:00.000Z");
  assert.equal(liveSchedulerMetadata({ ...env, INTRADAY_SCHEDULED_AT: "secret-fixture" }, actual).scheduledAt, null);
  assert.equal(liveSchedulerMetadata({ ...env, INTRADAY_SCHEDULED_AT: "2026-10-12T05:20:00Z" }, actual).scheduledAt, null);
  assert.equal(liveSchedulerMetadata({ INTRADAY_TRIGGER_TYPE: "schedule" }, actual).scheduledAt, null);
});
test("separate failure stages retain previous good pointer; no false publication time", () => {
  const good = { status: "READY", signalDate: "2026-10-08", signalPath: "fixture", collectionCompletedAt: "2026-10-08T05:34:00Z" };
  for (const [stage, label] of [["collection", "수집 실패"], ["validation", "검증 실패"], ["storage", "저장 실패"], ["publication", "게시 실패"]]) {
    const result = liveAttemptStatus(good, { status: "FAILED", failureStage: stage, signalDate: "2026-10-12" });
    assert.equal(result.lastGood.signalPath, "fixture"); assert.equal(result.lastSuccessAt, good.collectionCompletedAt);
    assert.equal(liveStatusLabel(result), label); assert.equal(result.publicationVerifiedAt, undefined);
  }
});
test("only diagnostic state changes; immutable create-only and quote window remain enforced", async () => {
  const runner = await readFile(new URL("./run-intraday-model-top-official-signal.mjs", import.meta.url), "utf8");
  assert.match(runner, /flag: "wx"/u);
  assert.match(runner, /INTRADAY_MODEL_TOP_STATUS_WRITE_FAILED/u);
  assert.match(runner, /LIVE_OPERATION_TIMING_JSON/u);
  assert.match(runner, /formatDate\(actual\) !== signalDate/u);
  assert.match(runner, /finally\(\(\) => console\.log/u);
  const workflow = await readFile(new URL("../.github/workflows/intraday-model-top-official-signal.yml", import.meta.url), "utf8");
  assert.match(workflow, /LIVE_STAGE_PATH_REJECTED/u);
  assert.match(workflow, /LIVE_GITHUB_PUBLISHED_AT/u);
  assert.match(workflow, /TB_AUTOMATION_READ_TOKEN: \$\{\{ secrets\.TB_AUTOMATION_READ_TOKEN \}\}/u);
  assert.doesNotMatch(workflow, /git push.*--force/u);
  const topPanel = await readFile(new URL("../components/TopStocksPanel.tsx", import.meta.url), "utf8");
  const home = await readFile(new URL("../components/HomeDashboard.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(topPanel, /오늘 Official Signal 생성에 실패/u);
  assert.match(topPanel, /실제 시도일/u);
  assert.match(home, /상태 기준일.*liveStatus\?\.signalDate/u);
});
