import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import diagnostic, { verifyGitHubReadonly } from "../tools/verify-github-readonly.mjs";
const env = { DISPATCH_ENABLED: "false", GITHUB_TOKEN: "fixture-secret-never-return" };
const payloads = [
  { id: 123, login: "not-returned" },
  { full_name: "klkl789982-droid/stock-research", default_branch: "main" },
  { path: ".github/workflows/intraday-model-top-official-signal.yml", state: "active" },
  { workflow_runs: [{ head_branch: "main", status: "in_progress" }] },
];
test("fixed authenticated GETs never imply dispatch write permission", async () => {
  const calls = [];
  const result = await verifyGitHubReadonly(env, { fetchImpl: async (url, init) => {
    calls.push(url);
    assert.equal(init.method, "GET"); assert.equal(init.redirect, "manual");
    assert.equal(init.headers.Authorization, `Bearer ${env.GITHUB_TOKEN}`);
    assert.equal(init.body, undefined); assert.ok(init.signal);
    return Response.json(payloads[calls.length - 1]);
  } });
  assert.deepEqual(calls, ["https://api.github.com/user", "https://api.github.com/repos/klkl789982-droid/stock-research", "https://api.github.com/repos/klkl789982-droid/stock-research/actions/workflows/intraday-model-top-official-signal.yml", "https://api.github.com/repos/klkl789982-droid/stock-research/actions/workflows/intraday-model-top-official-signal.yml/runs?branch=main&per_page=30"]);
  assert.equal(result.status, "READ_ONLY_VERIFIED"); assert.equal(result.activeMainRuns, 1);
  assert.equal(result.dispatchAttempted, false); assert.equal(result.dispatchWritePermission, "NOT_VERIFIED_READ_ONLY");
  assert.doesNotMatch(JSON.stringify(result), /fixture-secret|not-returned/u);
});
test("missing secret or non-disabled environment cannot access GitHub", async () => {
  for (const value of [{}, { GITHUB_TOKEN: env.GITHUB_TOKEN }, { ...env, DISPATCH_ENABLED: "true" }, { DISPATCH_ENABLED: "false" }]) {
    const result = await verifyGitHubReadonly(value, { fetchImpl: () => assert.fail("network forbidden") });
    assert.equal(result.status, "FAILED"); assert.equal(result.dispatchAttempted, false);
  }
});
test("HTTP errors and redirects fail without retry or response body leakage", async () => {
  for (const status of [301, 401, 403, 404, 429, 503]) {
    let calls = 0;
    const result = await verifyGitHubReadonly(env, { fetchImpl: async () => { calls++; return new Response(env.GITHUB_TOKEN, { status }); } });
    assert.equal(calls, 1); assert.equal(result.reason, `AUTHENTICATION_HTTP_${status}`);
    assert.doesNotMatch(JSON.stringify(result), /fixture-secret/u);
  }
});
test("invalid identity, wrong repo/branch, disabled workflow, unknown run fail closed", async () => {
  for (const [index, bad] of [[0, {}], [1, { ...payloads[1], default_branch: "other" }], [1, { ...payloads[1], full_name: "other/repo" }], [2, { ...payloads[2], state: "disabled_manually" }], [2, { ...payloads[2], path: ".github/workflows/daily-production.yml" }], [3, { workflow_runs: [{ status: "unknown" }] }]]) {
    let calls = 0;
    const result = await verifyGitHubReadonly(env, { fetchImpl: async () => Response.json(calls++ === index ? bad : payloads[calls - 1]) });
    assert.equal(result.status, "FAILED"); assert.equal(calls, index + 1);
  }
});
test("request and JSON exceptions are redacted", async () => {
  for (const fetchImpl of [async () => { throw new Error(env.GITHUB_TOKEN); }, async () => new Response(env.GITHUB_TOKEN)]) {
    const result = await verifyGitHubReadonly(env, { fetchImpl });
    assert.equal(result.reason, "AUTHENTICATION_UNAVAILABLE"); assert.doesNotMatch(JSON.stringify(result), /fixture-secret/u);
  }
});
test("diagnostic rejects arbitrary paths, query strings and methods", async () => {
  for (const [path, method] of [["/", "GET"], ["/verify-github-readonly?url=https://example.com", "GET"], ["/verify-github-readonly", "POST"]]) {
    assert.equal((await diagnostic.fetch(new Request(`http://localhost${path}`, { method }), env)).status, 404);
  }
});
test("diagnostic is not part of production scheduler", async () => {
  const config = JSON.parse(await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
  assert.equal(config.main, "src/index.mjs"); assert.equal(config.vars.DISPATCH_ENABLED, "true");
  assert.equal(config.workers_dev, false); assert.equal(config.preview_urls, false);
  const main = await readFile(new URL("../src/index.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(main, /verifyGitHubReadonly|verify-github-readonly/u);
});
