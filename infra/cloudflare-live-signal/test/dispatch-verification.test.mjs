import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import diagnostic, { verifyDryRunDispatch } from "../tools/verify-github-dispatch.mjs";
const env = { DISPATCH_ENABLED: "false", APPROVE_DRY_RUN_DISPATCH: "true", GITHUB_TOKEN: "fixture-only-token" };
const responses = [{ id: 1 }, { full_name: "klkl789982-droid/stock-research", default_branch: "main" }, { path: ".github/workflows/intraday-model-top-official-signal.yml", state: "active" }, { workflow_runs: [] }];
test("approved verification sends exactly one fixed dry-run POST, never live", async () => {
  const calls = [];
  const result = await verifyDryRunDispatch(env, { fetchImpl: async (url, init) => {
    calls.push({ url, init });
    if (init.method === "GET") return Response.json(responses[calls.length - 1]);
    assert.equal(url, "https://api.github.com/repos/klkl789982-droid/stock-research/actions/workflows/intraday-model-top-official-signal.yml/dispatches");
    assert.equal(init.headers.Authorization, "Bearer fixture-only-token"); assert.equal(init.redirect, "manual");
    assert.deepEqual(JSON.parse(init.body), { ref: "main", inputs: { mode: "dry-run", trigger_source: "cloudflare-live-dispatch-verification" } });
    return new Response(null, { status: 204 });
  } });
  assert.equal(calls.length, 5); assert.equal(result.status, "DISPATCH_ACCEPTED");
  assert.equal(result.workflowResult, "NOT_VERIFIED"); assert.equal(result.liveObservationCreated, false);
  assert.doesNotMatch(JSON.stringify(result), /fixture-only-token/u);
});
test("unapproved, enabled scheduler, unavailable credentials never dispatch", async () => {
  for (const value of [{ ...env, APPROVE_DRY_RUN_DISPATCH: "false" }, { ...env, DISPATCH_ENABLED: "true" }, { ...env, GITHUB_TOKEN: "" }]) {
    assert.equal((await verifyDryRunDispatch(value, { fetchImpl: () => assert.fail("network forbidden") })).status, "BLOCKED");
  }
});
test("active workflow prevents permission test from queuing another run", async () => {
  let calls = 0;
  const result = await verifyDryRunDispatch(env, { fetchImpl: async (_, init) => {
    assert.equal(init.method, "GET"); calls++;
    return Response.json(calls === 4 ? { workflow_runs: [{ head_branch: "main", status: "queued" }] } : responses[calls - 1]);
  } });
  assert.equal(result.reason, "WORKFLOW_ACTIVE"); assert.equal(calls, 4);
});
test("POST errors, redirects and ambiguous responses never retry or leak errors", async () => {
  for (const status of [302, 401, 403, 422, 429, 503, null]) {
    let calls = 0;
    const result = await verifyDryRunDispatch(env, { fetchImpl: async (_, init) => {
      calls++;
      if (init.method === "GET") return Response.json(responses[calls - 1]);
      if (status === null) throw new Error(env.GITHUB_TOKEN);
      return new Response(env.GITHUB_TOKEN, { status });
    } });
    assert.equal(calls, 5); assert.equal(result.status, status === null ? "UNKNOWN" : "FAILED");
    assert.doesNotMatch(JSON.stringify(result), /fixture-only-token/u);
  }
});
test("GET/browser loads cannot dispatch; verification is excluded from production", async () => {
  assert.equal((await diagnostic.fetch(new Request("http://localhost/verify-github-dispatch-dry-run"), env)).status, 404);
  const main = await readFile(new URL("../src/index.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(main, /verifyDryRunDispatch|verify-github-dispatch/u);
  const runner = await readFile(new URL("../../../scripts/run-intraday-model-top-official-signal.mjs", import.meta.url), "utf8");
  assert.ok(runner.indexOf('if (dryRun) {') < runner.indexOf('const credentials ='));
  const branch = runner.slice(runner.indexOf('if (dryRun) {'), runner.indexOf('if (preflight) {'));
  assert.match(branch, /return;/u); assert.match(branch, /liveObservationCreated: false/u);
  assert.doesNotMatch(branch, /writeLatest|client\.request|fs\.write/u);
});
