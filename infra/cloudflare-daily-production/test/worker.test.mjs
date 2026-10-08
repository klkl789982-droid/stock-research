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

function harness(responses, options = {}) {
  const requests = [], siteRequests = [], logs = [], sleeps = [];
  const siteDate = options.siteDate ?? "2026-10-07";
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
        if (url.includes("/api/top-stocks")) return Response.json({ rankingAsOfDate: siteDate, freshness: { freshnessStatus: "fresh" } });
        if (url.includes("/api/model-performance")) return Response.json({ latestEodReferenceDate: options.performanceDate ?? siteDate });
        return Response.json({ siteApiReferenceDate: siteDate, publicationStatus: options.publicationStatus ?? "published" });
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
  assert.equal(post.redirect, "error");
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

test("already published session skips dispatch only when all three public APIs agree", async () => {
  for (const publicationStatus of ["published", "unchanged"]) {
    const h = harness([workflow(), runs()], { siteDate: "2026-10-08", publicationStatus });
    const result = await h.worker.scheduled(event, env);
    assert.equal(result.reason, "SESSION_ALREADY_PUBLISHED");
    assert.equal(result.publicationStatus, "VERIFIED_EXISTING");
    assert.equal(result.workflowStatus, "NOT_VERIFIED");
    assert.equal(h.requests.filter((request) => request.method === "POST").length, 0);
    assert.equal(h.siteRequests.length, 3);
    for (const request of h.siteRequests) {
      assert.equal(request.cache, "no-store");
      assert.equal(request.redirect, "error");
      assert.ok(!JSON.stringify(request.headers).includes(testCredential));
      assert.ok(!Object.hasOwn(request.headers, "Authorization"));
    }
  }
});

test("old/future/staggered deployment or failed publication still requests the canonical probe", async () => {
  for (const options of [{}, { siteDate: "2026-10-09" }, { siteDate: "2026-10-08", performanceDate: "2026-10-07" }, { siteDate: "2026-10-08", publicationStatus: "failed" }]) {
    const h = harness([workflow(), runs(), accepted()], options);
    assert.equal((await h.worker.scheduled(event, env)).status, "DISPATCH_ACCEPTED");
    assert.deepEqual(JSON.parse(h.requests.at(-1).body), { ref: "main", return_run_details: true });
  }
});

test("site HTTP/JSON/network/timeout errors do not block recovery or leak exceptions", async () => {
  const hang = (init) => new Promise((resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error(testCredential)), { once: true }));
  for (const response of [new Response(testCredential, { status: 503 }), new Response(testCredential, { status: 200 }), new Error(testCredential), hang]) {
    const h = harness([workflow(), runs(), accepted()], { timeoutMs: 5, siteResponses: [response, Response.json({}), Response.json({})] });
    assert.equal((await h.worker.scheduled(event, env)).status, "DISPATCH_ACCEPTED");
    assert.equal(h.siteRequests.length, 3);
    assert.equal(h.logs.find((log) => log.stage === "PUBLICATION_PREFLIGHT").reason, "SITE_PUBLICATION_NOT_VERIFIED");
    assert.ok(!JSON.stringify(h.logs).includes(testCredential));
  }
});

test("one failed site API cancels remaining reads before proceeding to dispatch", async () => {
  let cancellations = 0;
  const pending = (init) => new Promise((resolve, reject) => init.signal.addEventListener("abort", () => {
    cancellations += 1;
    reject(new Error(testCredential));
  }, { once: true }));
  const h = harness([workflow(), runs(), accepted()], { siteResponses: [new Response(null, { status: 503 }), pending, pending] });
  assert.equal((await h.worker.scheduled(event, env)).status, "DISPATCH_ACCEPTED");
  assert.equal(cancellations, 2);
  assert.equal(h.siteRequests.length, 3);
  assert.ok(!JSON.stringify(h.logs).includes(testCredential));
});

test("overnight slots guard the prior KST session; delayed events always re-probe", async () => {
  const overnight = { cron: CRONS[0], scheduledTime: Date.parse("2026-10-09T17:40:00Z") };
  const h = harness([workflow(), runs()], { siteDate: "2026-10-09", now: () => overnight.scheduledTime });
  assert.equal((await h.worker.scheduled(overnight, env)).reason, "SESSION_ALREADY_PUBLISHED");
  const delayed = harness([workflow(), runs(), accepted()], { siteDate: "2026-10-08", now: () => event.scheduledTime + 30 * 60 * 1000 });
  assert.equal((await delayed.worker.scheduled(event, env)).status, "DISPATCH_ACCEPTED");
  assert.equal(delayed.siteRequests.length, 0);
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
