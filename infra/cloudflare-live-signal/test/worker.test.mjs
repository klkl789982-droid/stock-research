import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { CRONS, dispatchLivePrewarm, scheduledOnce } from "../src/index.mjs";
const time = Date.parse("2026-10-12T05:12:00Z"), event = { cron: CRONS[0], scheduledTime: time };
const env = { DISPATCH_ENABLED: "true", GITHUB_TOKEN: "fixture-token" };
test("disabled until approval", async () => assert.equal((await dispatchLivePrewarm(event, {})).status, "DISABLED"));
test("exact target, KST prewarm, mode and authorization", async () => {
  const calls = [];
  const result = await dispatchLivePrewarm(event, env, { now: () => time, fetchImpl: async (url, init) => {
    calls.push({ url, init }); assert.match(url, /intraday-model-top-official-signal\.yml/u);
    assert.equal(init.headers.Authorization, "Bearer fixture-token");
    return init.method === "POST" ? new Response(null, { status: 204 }) : Response.json({ workflow_runs: [] });
  } });
  assert.equal(calls.length, 2); assert.deepEqual(JSON.parse(calls[1].init.body), { ref: "main", inputs: { mode: "live", scheduled_at: new Date(time).toISOString(), trigger_source: "cloudflare-live-prewarm" } });
  assert.equal(result.status, "DISPATCH_ACCEPTED_NOT_OBSERVATION_SUCCESS");
  assert.equal(result.schedulerDelayMs, 0); assert.equal(result.workflowResult, "NOT_VERIFIED");
  assert.equal(result.publicationResult, "NOT_VERIFIED"); assert.equal(result.dispatchRespondedAt, new Date(time).toISOString());
});
test("UTC/KST, exact slots, weekend, future, missing credentials, wrong cron fail closed", async () => {
  for (const minute of [12, 22]) {
    const scheduledTime = Date.parse(`2026-10-12T05:${minute}:00Z`);
    assert.equal(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit" }).format(scheduledTime), `14:${minute}`);
    const value = await dispatchLivePrewarm({ ...event, scheduledTime }, env, { now: () => scheduledTime + 30000, fetchImpl: async (_, init) => init.method ? new Response(null, { status: 204 }) : Response.json({ workflow_runs: [] }) });
    assert.equal(value.schedulerDelayMs, 30000); assert.match(value.status, /^DISPATCH_ACCEPTED/u);
  }
  for (const stamp of ["2026-10-11T05:12:00Z", "2026-10-12T05:15:00Z"]) {
    assert.equal((await dispatchLivePrewarm({ ...event, scheduledTime: Date.parse(stamp) }, env, { now: () => Date.parse(stamp) })).reason, "PREWARM_WINDOW_MISSED");
  }
  assert.equal((await dispatchLivePrewarm(event, env, { now: () => time - 1 })).reason, "PREWARM_WINDOW_MISSED");
  assert.equal((await dispatchLivePrewarm({ ...event, cron: "* * * * *" }, env, { now: () => time })).reason, "PREWARM_WINDOW_MISSED");
  assert.equal((await dispatchLivePrewarm(event, { DISPATCH_ENABLED: "true" }, { now: () => time })).reason, "CREDENTIAL_UNAVAILABLE");
});
test("bounded read retries, distinct auth errors and no POST retries", async () => {
  for (const status of [401, 403, 429, 503]) {
    let calls = 0, sleeps = 0;
    const result = await dispatchLivePrewarm(event, env, { now: () => time, wait: async () => { sleeps++; }, fetchImpl: async () => { calls++; return new Response(null, { status }); } });
    assert.equal(result.reason, `RUN_CHECK_HTTP_${status}`);
    assert.equal(calls, [401, 403].includes(status) ? 1 : 2);
    assert.equal(sleeps, calls - 1);
  }
  let calls = 0;
  const result = await dispatchLivePrewarm(event, env, { now: () => time, wait: async () => {}, fetchImpl: async (_, init) => {
    calls++; return init.method === "POST" ? new Response(null, { status: 503 }) : Response.json({ workflow_runs: [] });
  } });
  assert.equal(calls, 2); assert.equal(result.reason, "DISPATCH_HTTP_503");
  let networkCalls = 0;
  assert.equal((await dispatchLivePrewarm(event, env, { now: () => time, wait: async () => {}, fetchImpl: async () => { networkCalls++; throw new Error("secret-fixture"); } })).reason, "RUN_CHECK_UNAVAILABLE");
  assert.equal(networkCalls, 2);
});
test("delay during read check expires; malformed or redirected reads never dispatch", async () => {
  let tick = time;
  const delayed = await dispatchLivePrewarm(event, env, { now: () => tick, fetchImpl: async () => { tick += 121000; return Response.json({ workflow_runs: [] }); } });
  assert.equal(delayed.reason, "PREWARM_WINDOW_MISSED"); assert.equal(delayed.dispatchRequestedAt, null);
  for (const response of [Response.json({ workflow_runs: [{}] }), new Response(null, { status: 302 }), Response.json({})]) {
    assert.equal((await dispatchLivePrewarm(event, env, { now: () => time, fetchImpl: async () => response })).status, "FAILED");
  }
});
test("same-isolate concurrent/replayed events coalesce; completed preflight is not a LIVE success", async () => {
  let calls = 0;
  const options = { now: () => time, fetchImpl: async (_, init) => {
    calls++; return init.method ? new Response(null, { status: 204 }) : Response.json({ workflow_runs: [{ status: "completed", head_branch: "main", conclusion: "success" }] });
  } };
  const results = await Promise.all([scheduledOnce(event, env, options), scheduledOnce(event, env, options)]);
  assert.equal(calls, 2); assert.deepEqual(results[0], results[1]);
  await scheduledOnce(event, env, options); assert.equal(calls, 2);
});
test("workflow compatibility, disabled deployment and isolated target", async () => {
  const text = await readFile(new URL("../../../.github/workflows/intraday-model-top-official-signal.yml", import.meta.url), "utf8");
  for (const key of ["mode:", "scheduled_at:", "trigger_source:", "cancel-in-progress: false", "Fail unsuccessful dry-run", "LIVE_STAGE_PATH_REJECTED"]) assert.ok(text.includes(key), key);
  const config = JSON.parse(await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
  assert.equal(config.name, "tight-budget-live-prewarm"); assert.equal(config.vars.DISPATCH_ENABLED, "false");
  assert.deepEqual(config.triggers.crons, CRONS); assert.equal(config.workers_dev, false);
});
test("active run, late event, HTTP/auth error, ambiguous POST", async () => {
  for (const status of ["queued", "in_progress"]) assert.equal((await dispatchLivePrewarm(event, env, { now: () => time, fetchImpl: async () => Response.json({ workflow_runs: [{ status, head_branch: "main" }] }) })).reason, "WORKFLOW_ACTIVE");
  assert.equal((await dispatchLivePrewarm(event, env, { now: () => time + 3600000 })).reason, "PREWARM_WINDOW_MISSED");
  assert.equal((await dispatchLivePrewarm(event, env, { now: () => time, fetchImpl: async () => new Response(null, { status: 403 }) })).reason, "RUN_CHECK_HTTP_403");
  let calls = 0;
  const result = await dispatchLivePrewarm(event, env, { now: () => time, fetchImpl: async () => { if (++calls === 1) return Response.json({ workflow_runs: [] }); throw new Error("fixture-token"); } });
  assert.equal(calls, 2); assert.equal(result.status, "UNKNOWN"); assert.doesNotMatch(JSON.stringify(result), /fixture-token/u);
});
