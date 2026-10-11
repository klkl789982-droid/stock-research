import assert from "node:assert/strict";
import test from "node:test";
import { CRONS, dispatchLivePrewarm } from "../src/index.mjs";
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
  assert.equal(calls.length, 2); assert.deepEqual(JSON.parse(calls[1].init.body), { ref: "main", inputs: { mode: "live" } });
  assert.equal(result.status, "DISPATCH_ACCEPTED_NOT_OBSERVATION_SUCCESS");
});
test("active run, late event, HTTP/auth error, ambiguous POST", async () => {
  for (const status of ["queued", "in_progress"]) assert.equal((await dispatchLivePrewarm(event, env, { now: () => time, fetchImpl: async () => Response.json({ workflow_runs: [{ status, head_branch: "main" }] }) })).reason, "WORKFLOW_ACTIVE");
  assert.equal((await dispatchLivePrewarm(event, env, { now: () => time + 3600000 })).reason, "PREWARM_WINDOW_MISSED");
  assert.equal((await dispatchLivePrewarm(event, env, { now: () => time, fetchImpl: async () => new Response(null, { status: 403 }) })).reason, "RUN_CHECK_HTTP_403");
  let calls = 0;
  const result = await dispatchLivePrewarm(event, env, { now: () => time, fetchImpl: async () => { if (++calls === 1) return Response.json({ workflow_runs: [] }); throw new Error("fixture-token"); } });
  assert.equal(calls, 2); assert.equal(result.status, "UNKNOWN"); assert.doesNotMatch(JSON.stringify(result), /fixture-token/u);
});
