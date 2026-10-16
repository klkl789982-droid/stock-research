import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { createWorker, CRONS, PUBLICATION_SITE, TARGET } from "../src/index.mjs";

const testCredential = ["unit", "test", "not", "a", "PAT"].join("-");
const env = { DISPATCH_ENABLED: "true", GITHUB_TOKEN: testCredential };
const event = { cron: CRONS[0], scheduledTime: Date.parse("2026-10-08T06:40:00Z") };
const workflow = () => Response.json({ state: "active", path: `.github/workflows/${TARGET.workflow}` });
const runs = (workflow_runs = []) => Response.json({ workflow_runs });
const accepted = () => Response.json({ workflow_run_id: 12345, html_url: "https://untrusted.invalid/never-log-response" });

test("Cloudflare redirects are not followed, retried or allowed to forward credentials", async () => {
  for (const status of [301, 302, 307, 308]) {
    const f = harness([new Response(null, { status, headers: { Location: "https://untrusted.invalid" } })]);
    await assert.rejects(f.worker.scheduled(event, env), /GITHUB_HTTP_ERROR/u);
    assert.equal(f.requests.length, 1);
    assert.equal(f.requests[0].redirect, "manual"); assert.equal(f.sleeps.length, 0);
    assert.ok(!JSON.stringify(f.logs).includes(testCredential));
  }
});
const snapshotHash = "a".repeat(64);
const commitSha = "b".repeat(40);
const siteReadToken = "synthetic-site-read-token-".padEnd(48, "x");
const siteEnv = { ...env, TB_AUTOMATION_READ_TOKEN: siteReadToken };
const siteEndpoints = Object.freeze([
  "/api/top-stocks?model=A&limit=1",
  "/api/model-performance",
  "/api/home-dashboard?topN=5",
  "/api/daily-production-status",
]);

function publicationPayloads(options = {}) {
  const date = options.siteDate ?? "2026-10-07";
  const identity = { referenceDate: date, snapshotHash, commitSha };
  const common = { dataIdentity: identity, publicationReady: true };
  return {
    top: { ...common, rankingAsOfDate: date, freshness: { freshnessStatus: "fresh" } },
    performance: { ...common, latestEodReferenceDate: options.performanceDate ?? date },
    home: { ...common, referenceDate: date },
    operations: { ...common, siteApiReferenceDate: date, publicationStatus: options.publicationStatus ?? "published" },
    ...options.sitePayloads,
  };
}

function publicationEvidence(date = "2026-10-08") {
  const run = {
    id: 99, run_attempt: 1, head_sha: "c".repeat(40), head_branch: "main",
    repository: { full_name: TARGET.repository }, head_repository: { full_name: TARGET.repository },
    path: `.github/workflows/${TARGET.workflow}`, event: "schedule", actor: { login: "github-actions[bot]" },
    status: "completed", conclusion: "success", run_started_at: `${date}T06:00:00Z`,
  };
  const jobs = [{
    name: "publish", run_id: run.id, run_attempt: run.run_attempt, head_sha: run.head_sha,
    steps: [
      { name: "Verify Vercel deployment and production APIs", status: "completed", conclusion: "success", completed_at: `${date}T06:10:00Z` },
      { name: `Publication evidence v1 | VERIFIED | ${date} | ${snapshotHash} | ${commitSha} | NONE`, status: "completed", conclusion: "success", completed_at: `${date}T06:11:00Z` },
    ],
  }];
  return { run, jobs };
}

function publicationHarness(responses = [], options = {}) {
  const proof = options.proof ?? publicationEvidence(options.proofDate);
  return harness([workflow(), runs([proof.run]), Response.json({ jobs: proof.jobs }), ...responses], options);
}

function harness(responses, options = {}) {
  const requests = [], siteRequests = [], logs = [], sleeps = [];
  const payloads = publicationPayloads(options);
  const worker = createWorker({
    fetchImpl: async (url, init) => {
      if (url.startsWith(`${PUBLICATION_SITE}/`)) {
        siteRequests.push({ url, ...init });
        if (options.siteResponses) {
          const response = options.siteResponses.shift();
          assert.notEqual(response, undefined, "Unexpected site request in mock-only test");
          if (response instanceof Error) throw response;
          return typeof response === "function" ? response(init) : response;
        }
        const endpoint = url.slice(PUBLICATION_SITE.length);
        const index = siteEndpoints.indexOf(endpoint);
        assert.notEqual(index, -1, "Unexpected site endpoint in mock-only test");
        return Response.json(payloads[["top", "performance", "home", "operations"][index]]);
      }
      requests.push({ url, ...init });
      const response = responses.shift();
      assert.notEqual(response, undefined, "Unexpected outbound request in mock-only test");
      if (response instanceof Error) throw response;
      return typeof response === "function" ? response(init) : response;
    },
    logger: (entry) => logs.push(entry),
    sleep: async (ms) => sleeps.push(ms),
    now: () => event.scheduledTime,
    ...options,
  });
  return { worker, requests, siteRequests, logs, sleeps };
}

test("scheduled handler accepts a request, not workflow/publishing success; exact auth/body", async () => {
  const h = harness([workflow(), runs(), accepted()]);
  const result = await h.worker.scheduled(event, env);
  assert.equal(result.status, "DISPATCH_ACCEPTED");
  assert.equal(result.runId, 12345);
  assert.equal(result.workflowStatus, "NOT_VERIFIED");
  assert.equal(result.publicationStatus, "NOT_VERIFIED");
  assert.equal(h.requests.length, 3);
  const post = h.requests[2];
  assert.equal(post.url, "https://api.github.com/repos/klkl789982-droid/stock-research/actions/workflows/daily-production.yml/dispatches");
  assert.equal(post.method, "POST");
  assert.equal(post.headers.Authorization, `Bearer ${testCredential}`);
  assert.equal(post.headers.Accept, "application/vnd.github+json");
  assert.equal(post.headers["X-GitHub-Api-Version"], "2026-03-10");
  assert.equal(post.headers["Content-Type"], "application/json");
  assert.ok(post.headers["User-Agent"]);
  assert.equal(post.redirect, "manual");
  assert.deepEqual(JSON.parse(post.body), { ref: "main", return_run_details: true });
  assert.ok(!JSON.stringify(h.logs).includes(testCredential));
  assert.ok(!JSON.stringify(h.logs).includes("untrusted.invalid"));
});

test("204 compatibility: accepted but no known run ID", async () => {
  const h = harness([workflow(), runs(), new Response(null, { status: 204 })]);
  const result = await h.worker.scheduled(event, env);
  assert.equal(result.status, "DISPATCH_ACCEPTED");
  assert.equal(result.runId, null);
});

test("disabled-by-default and missing secret make no request", async () => {
  const disabled = harness([]);
  assert.equal((await disabled.worker.scheduled(event, {})).reason, "DISPATCH_DISABLED");
  assert.equal(disabled.requests.length, 0);
  assert.equal(disabled.siteRequests.length, 0);
  for (const secret of [undefined, "", "   "]) {
    const h = harness([]);
    await assert.rejects(h.worker.scheduled(event, { DISPATCH_ENABLED: "true", GITHUB_TOKEN: secret }), /SECRET_MISSING/u);
    assert.equal(h.requests.length, 0);
  }
});

test("auth/permission/not-found/invalid input errors are not retried or leaked", async () => {
  for (const status of [401, 403, 404, 422]) {
    const h = harness([workflow(), runs(), new Response(`${testCredential} private error body`, { status })]);
    await assert.rejects(h.worker.scheduled(event, env), /^Error: GITHUB_/u);
    assert.equal(h.requests.filter((request) => request.method === "POST").length, 1);
    assert.equal(h.sleeps.length, 0);
    assert.ok(!JSON.stringify(h.logs).includes(testCredential));
    assert.equal(h.logs.at(-1).status, "FAILED");
  }
  const h = harness([new Response(testCredential, { status: 401 })]);
  await assert.rejects(h.worker.scheduled(event, env), /GITHUB_AUTHENTICATION_FAILED/u);
  assert.equal(h.requests.length, 1);
});

test("disabled or wrong workflow cannot dispatch", async () => {
  for (const data of [{ state: "disabled_manually", path: ".github/workflows/daily-production.yml" }, { state: "active", path: ".github/workflows/intraday-model-top.yml" }]) {
    const h = harness([Response.json(data)]);
    await assert.rejects(h.worker.scheduled(event, env), /WORKFLOW_NOT_ACTIVE_OR_INVALID/u);
    assert.equal(h.requests.length, 1);
  }
});

test("existing native scheduled/dispatch active runs are skipped", async () => {
  for (const status of ["queued", "in_progress", "requested", "waiting", "pending"]) {
    const h = harness([workflow(), runs([{ id: 99, head_branch: "main", status, event: "schedule" }])]);
    const result = await h.worker.scheduled(event, env);
    assert.equal(result.reason, "WORKFLOW_ALREADY_ACTIVE");
    assert.equal(result.workflowStatus, "NOT_VERIFIED");
    assert.equal(h.requests.length, 2);
  }
  const h = harness([workflow(), runs([{ id: 99, head_branch: "other", status: "in_progress" }]), accepted()]);
  assert.equal((await h.worker.scheduled(event, env)).status, "DISPATCH_ACCEPTED");
});

test("same-isolate concurrent delivery/replay sends one POST", async () => {
  const h = harness([workflow(), runs(), accepted()]);
  const results = await Promise.all([h.worker.scheduled(event, env), h.worker.scheduled(event, env)]);
  assert.deepEqual(results[0], results[1]);
  await h.worker.scheduled(event, env);
  assert.equal(h.requests.filter((request) => request.method === "POST").length, 1);
  assert.ok(h.logs.some((log) => log.reason === "SAME_ISOLATE_REPLAY"));
});

test("already published session skips dispatch only when exact proof and all four authenticated APIs agree", async () => {
  for (const publicationStatus of ["published", "unchanged"]) {
    const h = publicationHarness([], { siteDate: "2026-10-08", publicationStatus });
    const result = await h.worker.scheduled(event, siteEnv);
    assert.equal(result.reason, "SESSION_ALREADY_PUBLISHED");
    assert.equal(result.publicationStatus, "VERIFIED_EXISTING");
    assert.equal(result.workflowStatus, "NOT_VERIFIED");
    assert.equal(h.requests.length, 3);
    assert.equal(h.requests[2].url, `https://api.github.com/repos/${TARGET.repository}/actions/runs/99/attempts/1/jobs?per_page=100`);
    assert.equal(h.requests.filter((request) => request.method === "POST").length, 0);
    assert.deepEqual(h.siteRequests.map((request) => request.url), siteEndpoints.map((endpoint) => `${PUBLICATION_SITE}${endpoint}`));
    for (const request of h.siteRequests) {
      assert.equal(request.method ?? "GET", "GET");
      assert.equal(request.cache, "no-store");
      assert.equal(request.redirect, "manual");
      assert.equal(request.headers.Accept, "application/json");
      assert.equal(request.headers.Authorization, `Bearer ${siteReadToken}`);
      assert.ok(!JSON.stringify(request.headers).includes(testCredential));
    }
    for (const request of h.requests) {
      assert.equal(request.headers.Authorization, `Bearer ${testCredential}`);
      assert.ok(!JSON.stringify(request).includes(siteReadToken));
    }
    assert.ok(!JSON.stringify(h.logs).includes(testCredential));
    assert.ok(!JSON.stringify(h.logs).includes(siteReadToken));
  }
});

test("old/future/staggered deployment or unready publication still requests the canonical probe", async () => {
  const failedOperations = { ...publicationPayloads({ siteDate: "2026-10-08", publicationStatus: "failed" }).operations, publicationReady: false };
  for (const options of [{}, { siteDate: "2026-10-09" }, { siteDate: "2026-10-08", performanceDate: "2026-10-07" }, { siteDate: "2026-10-08", sitePayloads: { operations: failedOperations } }]) {
    const h = publicationHarness([accepted()], options);
    const result = await h.worker.scheduled(event, siteEnv);
    assert.equal(result.status, "DISPATCH_ACCEPTED");
    assert.equal(result.publicationStatus, "NOT_VERIFIED");
    assert.equal(h.siteRequests.length, 4);
    assert.deepEqual(JSON.parse(h.requests.at(-1).body), { ref: "main", return_run_details: true });
  }
});

test("every site API must match proven date, hash, commit and readiness; unchanged cannot bypass proof", async () => {
  const payloads = publicationPayloads({ siteDate: "2026-10-08", publicationStatus: "unchanged" });
  const dateFields = { top: "rankingAsOfDate", performance: "latestEodReferenceDate", home: "referenceDate", operations: "siteApiReferenceDate" };
  for (const [endpoint, payload] of Object.entries(payloads)) {
    for (const invalid of [
      { ...payload, [dateFields[endpoint]]: "2026-10-07" },
      { ...payload, dataIdentity: null },
      { ...payload, dataIdentity: { ...payload.dataIdentity, referenceDate: "2026-10-07" } },
      { ...payload, dataIdentity: { ...payload.dataIdentity, snapshotHash: "d".repeat(64) } },
      { ...payload, dataIdentity: { ...payload.dataIdentity, commitSha: "e".repeat(40) } },
      { ...payload, publicationReady: false },
      { ...payload, publicationReady: "true" },
      { ...payload, publicationReady: undefined },
    ]) {
      const h = publicationHarness([accepted()], { siteDate: "2026-10-08", sitePayloads: { [endpoint]: invalid } });
      const result = await h.worker.scheduled(event, siteEnv);
      assert.equal(result.status, "DISPATCH_ACCEPTED", `${endpoint} must reject ${JSON.stringify(invalid)}`);
      assert.equal(result.publicationStatus, "NOT_VERIFIED");
      assert.equal(h.siteRequests.length, 4);
      assert.equal(h.requests.filter((request) => request.method === "POST").length, 1);
    }
  }
  // All four can agree on a different snapshot/commit and still fail the external proof.
  for (const key of ["snapshotHash", "commitSha"]) {
    const mismatched = Object.fromEntries(Object.entries(payloads).map(([name, payload]) => [name, {
      ...payload, dataIdentity: { ...payload.dataIdentity, [key]: "f".repeat(key === "snapshotHash" ? 64 : 40) },
    }]));
    const h = publicationHarness([accepted()], { siteDate: "2026-10-08", sitePayloads: mismatched });
    assert.equal((await h.worker.scheduled(event, siteEnv)).status, "DISPATCH_ACCEPTED");
    assert.equal(h.siteRequests.length, 4);
  }
});

test("missing or malformed site authentication cannot block dispatch or use ambient credentials", async () => {
  const original = process.env.TB_AUTOMATION_READ_TOKEN;
  process.env.TB_AUTOMATION_READ_TOKEN = "ambient-token-must-never-be-used-".padEnd(48, "y");
  try {
    for (const token of [undefined, null, "", "   ", "short", "x".repeat(129), "!".repeat(48)]) {
      const h = harness([workflow(), runs([publicationEvidence().run]), accepted()], { siteDate: "2026-10-08" });
      assert.equal((await h.worker.scheduled(event, { ...env, TB_AUTOMATION_READ_TOKEN: token })).status, "DISPATCH_ACCEPTED");
      assert.equal(h.siteRequests.length, 0);
      assert.equal(h.requests.length, 3, "Missing site auth must not make proof-job requests");
      assert.equal(h.logs.find((log) => log.stage === "PUBLICATION_PREFLIGHT").reason, "SITE_AUTH_UNAVAILABLE");
      assert.ok(!JSON.stringify(h.requests).includes(process.env.TB_AUTOMATION_READ_TOKEN));
      assert.ok(!JSON.stringify(h.logs).includes(process.env.TB_AUTOMATION_READ_TOKEN));
    }
  } finally {
    if (original === undefined) delete process.env.TB_AUTOMATION_READ_TOKEN;
    else process.env.TB_AUTOMATION_READ_TOKEN = original;
  }
});

test("missing, untrusted or failed completed runs provide no publication proof", async () => {
  const proof = publicationEvidence();
  const invalidRuns = [
    [],
    [{ id: 99, status: "completed", head_branch: "main" }],
    [{ ...proof.run, conclusion: "failure" }],
    [{ ...proof.run, actor: { login: "untrusted" } }],
    [{ ...proof.run, head_repository: { full_name: "untrusted/fork" } }],
    [{ ...proof.run, repository: { full_name: "untrusted/repository" } }],
    [{ ...proof.run, event: "push" }],
    [{ ...proof.run, head_branch: "other" }],
    [{ ...proof.run, path: ".github/workflows/intraday-model-top-official-signal.yml" }],
  ];
  for (const entries of invalidRuns) {
    const h = harness([workflow(), runs(entries), accepted()], { siteDate: "2026-10-08" });
    const result = await h.worker.scheduled(event, siteEnv);
    assert.equal(result.status, "DISPATCH_ACCEPTED");
    assert.equal(result.publicationStatus, "NOT_VERIFIED");
    assert.equal(h.siteRequests.length, 0);
    assert.equal(h.requests.length, 3);
    assert.equal(h.logs.find((log) => log.stage === "PUBLICATION_PREFLIGHT").reason, "PUBLICATION_EVIDENCE_UNAVAILABLE");
  }
});

test("malformed, failed, stale or future job proof never starts site verification", async () => {
  const proof = publicationEvidence();
  const job = proof.jobs[0], verifier = job.steps[0], marker = job.steps[1];
  const variants = [
    { ...proof, jobs: [] },
    { ...proof, jobs: null },
    { ...proof, jobs: [null] },
    { ...proof, jobs: [{ ...job, steps: {} }] },
    { ...proof, jobs: [{ ...job, steps: [null] }] },
    { ...proof, jobs: [{ ...job, steps: [{ name: {} }] }] },
    { ...proof, jobs: [{ ...job, head_sha: "d".repeat(40) }] },
    { ...proof, jobs: [{ ...job, run_attempt: 2 }] },
    { ...proof, jobs: [{ ...job, steps: [verifier] }] },
    { ...proof, jobs: [{ ...job, steps: [{ ...verifier, conclusion: "failure" }, marker] }] },
    { ...proof, jobs: [{ ...job, steps: [verifier, { ...marker, name: marker.name.replace("VERIFIED", "FAILED").replace("NONE", "SITE_COMMIT_MISMATCH") }] }] },
    { ...proof, jobs: [{ ...job, steps: [{ ...verifier, conclusion: "failure" }, { ...marker, name: marker.name.replace("VERIFIED", "FAILED").replace("NONE", "SITE_COMMIT_MISMATCH") }] }] },
    { ...proof, jobs: [{ ...job, steps: [verifier, marker, marker] }] },
    { ...proof, jobs: [{ ...job, steps: [marker] }] },
    { ...proof, jobs: [{ ...job, steps: [verifier, { ...marker, name: marker.name.replace(snapshotHash, "not-a-hash") }] }] },
    { ...proof, jobs: [{ ...job, steps: [verifier, { ...marker, name: marker.name.replace(commitSha, "not-a-commit") }] }] },
    { ...proof, jobs: [{ ...job, steps: [verifier, { ...marker, completed_at: "2026-10-08T07:00:00Z" }] }] },
    publicationEvidence("2026-10-07"),
    publicationEvidence("2026-10-09"),
  ];
  for (const variant of variants) {
    const h = publicationHarness([accepted()], { proof: variant, siteDate: "2026-10-08" });
    assert.equal((await h.worker.scheduled(event, siteEnv)).status, "DISPATCH_ACCEPTED");
    assert.equal(h.siteRequests.length, 0);
    assert.equal(h.requests.length, 4);
    assert.equal(h.logs.find((log) => log.stage === "PUBLICATION_PREFLIGHT").reason, "PUBLICATION_EVIDENCE_UNAVAILABLE");
  }
});

test("unavailable proof jobs recover with bounded GET retries and no site requests", async () => {
  const hang = (init) => new Promise((resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error(`${testCredential} ${siteReadToken}`)), { once: true }));
  const cases = [
    ...[401, 403, 404, 422].map((status) => ({ responses: [new Response(`${testCredential} ${siteReadToken}`, { status })], delays: [] })),
    { responses: [new Response(testCredential, { headers: { "Content-Type": "application/json" } })], delays: [] },
    { responses: [Response.json({})], delays: [] },
    { responses: Array.from({ length: 3 }, () => new Response(`${testCredential} ${siteReadToken}`, { status: 503 })), delays: [1000, 2000] },
    { responses: Array.from({ length: 3 }, () => new Error(`${testCredential} ${siteReadToken}`)), delays: [1000, 2000] },
    { responses: [hang, hang, hang], delays: [1000, 2000] },
  ];
  for (const { responses, delays } of cases) {
    const count = responses.length;
    const h = harness([workflow(), runs([publicationEvidence().run]), ...responses, accepted()], { timeoutMs: 5 });
    const result = await h.worker.scheduled(event, siteEnv);
    assert.equal(result.status, "DISPATCH_ACCEPTED");
    assert.equal(result.publicationStatus, "NOT_VERIFIED");
    assert.equal(h.siteRequests.length, 0);
    assert.equal(h.requests.length, count + 3);
    assert.equal(h.requests.filter((request) => request.method === "POST").length, 1);
    assert.deepEqual(h.sleeps, delays);
    assert.equal(h.logs.find((log) => log.stage === "PUBLICATION_PREFLIGHT").reason, "PUBLICATION_EVIDENCE_UNAVAILABLE");
    assert.ok(!JSON.stringify(h.logs).includes(testCredential));
    assert.ok(!JSON.stringify(h.logs).includes(siteReadToken));
  }
});

test("only the newest eligible run supplies proof, without searching older successes after a failed proof", async () => {
  const newest = { ...publicationEvidence().run, id: 101, event: "workflow_dispatch" };
  const h = harness([workflow(), runs([newest, publicationEvidence().run]), Response.json({ jobs: [] }), accepted()], { siteDate: "2026-10-08" });
  assert.equal((await h.worker.scheduled(event, siteEnv)).status, "DISPATCH_ACCEPTED");
  assert.equal(h.siteRequests.length, 0);
  assert.equal(h.requests.length, 4);
  assert.equal(h.requests[2].url, `https://api.github.com/repos/${TARGET.repository}/actions/runs/101/attempts/1/jobs?per_page=100`);
});

test("site HTTP/JSON/network/timeout errors do not block recovery or leak exceptions", async () => {
  const hang = (init) => new Promise((resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error(testCredential)), { once: true }));
  for (const response of [
    ...[401, 403, 503, 302].map((status) => new Response(`${testCredential} ${siteReadToken}`, { status })),
    new Response(testCredential, { status: 200 }),
    new Response(testCredential, { status: 200, headers: { "Content-Type": "application/json" } }),
    new Error(`${testCredential} ${siteReadToken}`), hang,
  ]) {
    const h = publicationHarness([accepted()], { timeoutMs: 5, siteResponses: [response, Response.json({}), Response.json({}), Response.json({})] });
    const result = await h.worker.scheduled(event, siteEnv);
    assert.equal(result.status, "DISPATCH_ACCEPTED");
    assert.equal(result.publicationStatus, "NOT_VERIFIED");
    assert.equal(h.siteRequests.length, 4);
    assert.equal(h.requests.filter((request) => request.method === "POST").length, 1);
    assert.equal(h.logs.find((log) => log.stage === "PUBLICATION_PREFLIGHT").reason, "SITE_PUBLICATION_NOT_VERIFIED");
    assert.ok(!JSON.stringify(h.logs).includes(testCredential));
    assert.ok(!JSON.stringify(h.logs).includes(siteReadToken));
    assert.equal(h.sleeps.length, 0);
  }
});

test("one failed site API cancels remaining reads before proceeding to dispatch", async () => {
  let cancellations = 0;
  const pending = (init) => new Promise((resolve, reject) => init.signal.addEventListener("abort", () => {
    cancellations += 1;
    reject(new Error(testCredential));
  }, { once: true }));
  const h = publicationHarness([() => {
    assert.equal(cancellations, 3, "Every sibling site read is cancelled before the dispatch POST");
    return accepted();
  }], { siteResponses: [new Response(null, { status: 503 }), pending, pending, pending] });
  assert.equal((await h.worker.scheduled(event, siteEnv)).status, "DISPATCH_ACCEPTED");
  assert.equal(cancellations, 3);
  assert.equal(h.siteRequests.length, 4);
  assert.ok(h.siteRequests.every((request) => request.signal.aborted));
  assert.ok(!JSON.stringify(h.logs).includes(testCredential));
  assert.ok(!JSON.stringify(h.logs).includes(siteReadToken));
});

test("overnight slots guard the prior KST session; delayed events always re-probe", async () => {
  const overnight = { cron: CRONS[0], scheduledTime: Date.parse("2026-10-09T17:40:00Z") };
  const h = publicationHarness([], { siteDate: "2026-10-09", proofDate: "2026-10-09", now: () => overnight.scheduledTime });
  assert.equal((await h.worker.scheduled(overnight, siteEnv)).reason, "SESSION_ALREADY_PUBLISHED");
  assert.equal(h.siteRequests.length, 4);
  assert.equal(h.requests.filter((request) => request.method === "POST").length, 0);
  for (const delay of [30 * 60 * 1000, 31 * 60 * 1000]) {
    const delayed = harness([workflow(), runs([publicationEvidence().run]), accepted()], { siteDate: "2026-10-08", now: () => event.scheduledTime + delay });
    assert.equal((await delayed.worker.scheduled(event, siteEnv)).status, "DISPATCH_ACCEPTED");
    assert.equal(delayed.siteRequests.length, 0);
    assert.equal(delayed.requests.length, 3, "Delayed events also skip old proof-job reads");
  }
  const withinWindow = publicationHarness([], { siteDate: "2026-10-08", now: () => event.scheduledTime + 30 * 60 * 1000 - 1 });
  assert.equal((await withinWindow.worker.scheduled(event, siteEnv)).reason, "SESSION_ALREADY_PUBLISHED");
});

test("GET temporary HTTP/network failure retries with bounded backoff", async () => {
  const h = harness([new Response(testCredential, { status: 503 }), new Error(`${testCredential} network`), workflow(), runs(), accepted()]);
  assert.equal((await h.worker.scheduled(event, env)).status, "DISPATCH_ACCEPTED");
  assert.deepEqual(h.sleeps, [1000, 2000]);
  assert.ok(!JSON.stringify(h.logs).includes(testCredential));
  const exhausted = harness(Array.from({ length: 3 }, () => new Response(testCredential, { status: 502 })));
  await assert.rejects(exhausted.worker.scheduled(event, env), /GITHUB_HTTP_ERROR/u);
  assert.equal(exhausted.requests.length, 3);
  assert.deepEqual(exhausted.sleeps, [1000, 2000]);
});

test("GET timeout retries at most three times", async () => {
  const hang = (init) => new Promise((resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error(testCredential)), { once: true }));
  const h = harness([hang, hang, hang], { timeoutMs: 5 });
  await assert.rejects(h.worker.scheduled(event, env), /GITHUB_TIMEOUT/u);
  assert.equal(h.requests.length, 3);
  assert.deepEqual(h.sleeps, [1000, 2000]);
});

test("explicitly rejected POST rate limit retries, preflighting runs again", async () => {
  for (const status of [429, 403]) {
    const h = harness([workflow(), runs(), new Response(testCredential, { status, headers: { "retry-after": "2" } }), runs(), accepted()]);
    assert.equal((await h.worker.scheduled(event, env)).status, "DISPATCH_ACCEPTED");
    assert.deepEqual(h.sleeps, [2000]);
    assert.deepEqual(h.requests.map((request) => request.method), ["GET", "GET", "POST", "GET", "POST"]);
  }
  const becameActive = harness([workflow(), runs(), new Response(null, { status: 429 }), runs([{ id: 2, head_branch: "main", status: "queued" }])]);
  assert.equal((await becameActive.worker.scheduled(event, env)).reason, "WORKFLOW_ALREADY_ACTIVE");
  assert.equal(becameActive.requests.filter((request) => request.method === "POST").length, 1);
});

test("long/invalid rate-limit delay defers to later Cron; repeated 429 is bounded", async () => {
  for (const retryAfter of ["3600", "invalid", "-1"]) {
    const h = harness([workflow(), runs(), new Response(null, { status: 429, headers: { "retry-after": retryAfter } })]);
    await assert.rejects(h.worker.scheduled(event, env), /GITHUB_RATE_LIMITED/u);
    assert.equal(h.requests.length, 3);
    assert.equal(h.sleeps.length, 0);
  }
  const h = harness([workflow(), runs(), new Response(null, { status: 429 }), runs(), new Response(null, { status: 429 }), runs(), new Response(null, { status: 429 })]);
  await assert.rejects(h.worker.scheduled(event, env), /GITHUB_RATE_LIMITED/u);
  assert.equal(h.requests.filter((request) => request.method === "POST").length, 3);
  assert.deepEqual(h.sleeps, [1000, 2000]);
});

test("ambiguous POST timeout/network/5xx/invalid body is NOT blindly retried", async () => {
  const hang = (init) => new Promise((resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error(testCredential)), { once: true }));
  for (const response of [new Error(testCredential), new Response(testCredential, { status: 503 }), new Response("not-json", { status: 200 }), Response.json({}), Response.json({ workflow_run_id: -1 }), Response.json({ workflow_run_id: "123" }), hang]) {
    const h = harness([workflow(), runs(), response], { timeoutMs: 5 });
    await assert.rejects(h.worker.scheduled(event, env), /DISPATCH_OUTCOME_UNKNOWN/u);
    await assert.rejects(h.worker.scheduled(event, env), /DISPATCH_OUTCOME_UNKNOWN/u);
    assert.equal(h.requests.filter((request) => request.method === "POST").length, 1);
    assert.equal(h.logs.find((log) => log.status === "OUTCOME_UNKNOWN").workflowStatus, "NOT_VERIFIED");
    assert.equal(h.sleeps.length, 0);
    assert.ok(!JSON.stringify(h.logs).includes(testCredential));
  }
});

test("malformed preflight response fails closed", async () => {
  for (const response of [new Response("not-json", { status: 200 }), Response.json({ workflow_runs: null }), Response.json({ workflow_runs: [null] })]) {
    const h = harness([workflow(), response]);
    await assert.rejects(h.worker.scheduled(event, env), /GITHUB_INVALID_RESPONSE/u);
    assert.equal(h.requests.length, 2);
  }
});

test("missed earlier Cron is recovered by later slot without date injection", async () => {
  const h = harness([workflow(), runs(), accepted()]);
  // No event delivered for the first slot; the next slot is an independent invocation.
  const nextSlot = { cron: CRONS[0], scheduledTime: Date.parse("2026-10-08T07:10:00Z") };
  const result = await h.worker.scheduled(nextSlot, env);
  assert.equal(result.status, "DISPATCH_ACCEPTED");
  assert.ok(!Object.hasOwn(JSON.parse(h.requests.at(-1).body), "inputs"));
  assert.ok(!h.requests.at(-1).body.includes("2026-10"));
});

test("UTC to KST, Cloudflare weekday semantics, overnight and Friday boundaries", async () => {
  const config = JSON.parse(await fs.readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
  assert.deepEqual(config.triggers.crons, CRONS);
  assert.equal(CRONS.length, 1, "28 half-hour slots use one account-level Cron Trigger");
  const timestamps = [];
  for (const cron of CRONS) {
    const [minute, hour, day, month, weekdays] = cron.split(" ");
    assert.equal(day, "*"); assert.equal(month, "*");
    assert.equal(weekdays, "MON-FRI", "Cloudflare 1-5 means Sun-Thu, unlike GitHub");
    const [first, last] = hour.split("-").map(Number);
    for (let selectedHour = first; selectedHour <= last; selectedHour += 1) {
      for (const selectedMinute of minute.split(",").map(Number)) {
        timestamps.push(Date.UTC(2026, 9, 8, selectedHour, selectedMinute));
      }
    }
  }
  assert.equal(timestamps.length, 28);
  assert.equal(new Set(timestamps).size, 28, "No overlapping Cron slots");
  const kst = timestamps.map((time) => new Date(time + 9 * 60 * 60 * 1000).toISOString());
  assert.equal(kst[0].slice(0, 16), "2026-10-08T13:10");
  assert.equal(kst[5].slice(0, 16), "2026-10-08T15:40", "First current-day post-close check");
  assert.equal(kst.at(-1).slice(0, 16), "2026-10-09T02:40");
  for (let index = 1; index < timestamps.length; index += 1) assert.equal(timestamps[index] - timestamps[index - 1], 30 * 60 * 1000);
  assert.equal(new Date(Date.UTC(2026, 9, 9, 17, 40) + 9 * 60 * 60 * 1000).getUTCDay(), 6, "Friday UTC overnight runs Saturday KST");
  assert.equal(config.vars.DISPATCH_ENABLED, "false");
  assert.equal(config.workers_dev, false);
  assert.equal(config.preview_urls, false);
  assert.equal(config.name, "tight-budget-eod-scheduler", "Deploy only to the existing user-created Worker");
  assert.deepEqual(config.secrets.required, ["GITHUB_TOKEN"]);
  assert.ok(!Object.hasOwn(config.vars, "GITHUB_TOKEN"));
});

test("existing workflow has zero inputs, same main concurrency, no cancellation/force push", async () => {
  const source = await fs.readFile(new URL("../../../.github/workflows/daily-production.yml", import.meta.url), "utf8");
  assert.match(source, /workflow_dispatch:\s*\r?\n\r?\nconcurrency:/u);
  assert.match(source, /group: daily-production-\$\{\{ github.ref \}\}/u);
  assert.match(source, /cancel-in-progress: false/u);
  assert.match(source, /git rebase origin\/main/u);
  assert.match(source, /git push origin HEAD:main/u);
  assert.doesNotMatch(source, /git push --force/u);
  assert.match(source, /status \}\}" = "CANDIDATE_VALIDATED"/u);
  assert.match(source, /verify-daily-production-deployment\.mjs/u);
});

test("HTTP cannot dispatch; invalid events cannot make requests", async () => {
  const h = harness([]);
  assert.equal((await h.worker.fetch(new Request("https://test.invalid/dispatch", { method: "POST" }), env)).status, 404);
  for (const controller of [{ ...event, cron: "untrusted" }, { ...event, scheduledTime: NaN }, { ...event, scheduledTime: 9e20 }]) {
    await assert.rejects(h.worker.scheduled(controller, env), /INVALID_SCHEDULE_EVENT/u);
  }
  assert.equal(h.requests.length, 0);
});
