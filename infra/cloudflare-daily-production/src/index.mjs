// Cron-only dispatcher. Never collects prices, chooses an EOD date, or writes snapshots.
export const TARGET = Object.freeze({
  repository: "klkl789982-droid/stock-research",
  workflow: "daily-production.yml",
  ref: "main",
});
export const CRONS = Object.freeze([
  "55 9 * * MON-FRI", "25 11,13,15,17 * * MON-FRI",
]);
const API = `https://api.github.com/repos/${TARGET.repository}/actions/workflows/${TARGET.workflow}`;
const ACTIVE = new Set(["queued", "in_progress", "requested", "waiting", "pending"]);
const MAX_ATTEMPTS = 3;
const MAX_BACKOFF_MS = 30_000;

function retryDelay(response, attempt, now) {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter !== null) {
    const seconds = Number(retryAfter);
    const delay = Number.isFinite(seconds) ? seconds * 1_000 : Date.parse(retryAfter) - now();
    return Number.isFinite(delay) && delay >= 0 && delay <= MAX_BACKOFF_MS ? delay : null;
  }
  if (response.headers.get("x-ratelimit-remaining") === "0") {
    const reset = Number(response.headers.get("x-ratelimit-reset")) * 1_000 - now();
    return Number.isFinite(reset) && reset >= 0 && reset <= MAX_BACKOFF_MS ? reset : null;
  }
  return attempt * 1_000;
}

function httpReason(status, rateLimited) {
  if (rateLimited) return "GITHUB_RATE_LIMITED";
  if (status === 401) return "GITHUB_AUTHENTICATION_FAILED";
  if (status === 403) return "GITHUB_PERMISSION_DENIED";
  if (status === 404) return "GITHUB_NOT_FOUND";
  if (status === 422) return "GITHUB_DISPATCH_INVALID";
  return "GITHUB_HTTP_ERROR";
}

export function createWorker({
  fetchImpl = (...args) => fetch(...args),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  logger = (entry) => console.log(JSON.stringify(entry)),
  now = () => Date.now(),
  timeoutMs = 10_000,
} = {}) {
  // Best-effort same-isolate replay protection, NOT a distributed exactly-once lock.
  const invocations = new Map();

  async function run(controller, env) {
    const base = { component: "daily-eod-external-cron", cron: controller.cron, scheduledAt: new Date(controller.scheduledTime).toISOString() };
    const finish = (status, reason, extra = {}) => {
      const result = { ...base, status, reason, workflowStatus: "NOT_VERIFIED", publicationStatus: "NOT_VERIFIED", ...extra };
      logger(result);
      return result;
    };
    if (env.DISPATCH_ENABLED !== "true") return finish("SKIPPED", "DISPATCH_DISABLED");
    if (typeof env.GITHUB_ACTIONS_TOKEN !== "string" || !env.GITHUB_ACTIONS_TOKEN.trim()) return finish("FAILED", "SECRET_MISSING");
    const headers = {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${env.GITHUB_ACTIONS_TOKEN.trim()}`,
      "X-GitHub-Api-Version": "2026-03-10",
      "User-Agent": "Tight-Budget-Daily-EOD-Cron",
      "Content-Type": "application/json",
    };

    async function request(method, url, body, attempt) {
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), timeoutMs);
      try {
        const response = await fetchImpl(url, { method, headers, redirect: "error", signal: abort.signal, ...(body ? { body: JSON.stringify(body) } : {}) });
        const status = response.status;
        const rateLimited = status === 429 || (status === 403 && (response.headers.get("x-ratelimit-remaining") === "0" || response.headers.has("retry-after")));
        const transient = rateLimited || status >= 500;
        if (status !== 200 && status !== 204) {
          // Discard error bodies without logging them; release the outbound connection.
          await response.body?.cancel().catch(() => {});
          return { status, reason: httpReason(status, rateLimited), transient, rateLimited, delay: transient ? retryDelay(response, attempt, now) : null };
        }
        if (status === 204) return { status, data: null };
        try { return { status, data: await response.json() }; }
        catch { return { status, reason: "GITHUB_INVALID_RESPONSE" }; }
      } catch {
        return { status: 0, reason: abort.signal.aborted ? "GITHUB_TIMEOUT" : "GITHUB_NETWORK_ERROR", transient: true, delay: attempt * 1_000 };
      } finally {
        clearTimeout(timer);
      }
    }

    async function read(url, stage) {
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        const response = await request("GET", url, null, attempt);
        if (!response.transient || response.delay === null || attempt === MAX_ATTEMPTS) return response;
        logger({ ...base, status: "RETRY", stage, reason: response.reason, attempt, delayMs: response.delay });
        await sleep(response.delay);
      }
    }

    const workflow = await read(API, "WORKFLOW_PREFLIGHT");
    if (workflow.reason) return finish("FAILED", workflow.reason, { stage: "WORKFLOW_PREFLIGHT", httpStatus: workflow.status });
    if (workflow.data?.state !== "active" || workflow.data?.path !== `.github/workflows/${TARGET.workflow}`) return finish("FAILED", "WORKFLOW_NOT_ACTIVE_OR_INVALID");

    // Recheck active main runs before every explicitly rejected rate-limit retry.
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const runs = await read(`${API}/runs?branch=${TARGET.ref}&per_page=30`, "RUN_PREFLIGHT");
      if (runs.reason) return finish("FAILED", runs.reason, { stage: "RUN_PREFLIGHT", httpStatus: runs.status });
      if (!Array.isArray(runs.data?.workflow_runs) || !runs.data.workflow_runs.every((entry) => entry && Number.isSafeInteger(entry.id) && entry.id > 0 && typeof entry.head_branch === "string" && (entry.status === "completed" || ACTIVE.has(entry.status)))) return finish("FAILED", "GITHUB_INVALID_RESPONSE", { stage: "RUN_PREFLIGHT" });
      const active = runs.data.workflow_runs.find((entry) => entry.head_branch === TARGET.ref && ACTIVE.has(entry.status));
      if (active) return finish("SKIPPED", "WORKFLOW_ALREADY_ACTIVE", { runId: Number.isSafeInteger(active.id) ? active.id : null });

      // return_run_details is an API option, not a workflow input. Never send a date.
      const dispatched = await request("POST", `${API}/dispatches`, { ref: TARGET.ref, return_run_details: true }, attempt);
      const validRunId = Number.isSafeInteger(dispatched.data?.workflow_run_id) && dispatched.data.workflow_run_id > 0;
      if ((dispatched.status === 204 || (dispatched.status === 200 && validRunId)) && !dispatched.reason) return finish("DISPATCH_ACCEPTED", "REQUEST_ACCEPTED_NOT_WORKFLOW_SUCCESS", { attempt, httpStatus: dispatched.status, runId: validRunId ? dispatched.data.workflow_run_id : null });
      if (dispatched.rateLimited && dispatched.delay !== null && attempt < MAX_ATTEMPTS) {
        logger({ ...base, status: "RETRY", stage: "DISPATCH", reason: dispatched.reason, attempt, delayMs: dispatched.delay });
        await sleep(dispatched.delay);
        continue;
      }
      // POST is non-idempotent. A timeout/network/5xx/invalid 2xx may follow acceptance.
      // Do not blindly repeat it: later Cron slots recheck active runs and recover.
      const ambiguous = dispatched.status === 0 || dispatched.status >= 500 || (dispatched.status >= 200 && dispatched.status < 300);
      return finish(ambiguous ? "OUTCOME_UNKNOWN" : "FAILED", ambiguous ? "DISPATCH_OUTCOME_UNKNOWN" : dispatched.reason, { stage: "DISPATCH", httpStatus: dispatched.status, attempt });
    }
  }

  return {
    async scheduled(controller, env) {
      // Fixed known Cron values prevent untrusted controller/env data entering logs.
      if (!CRONS.includes(controller.cron) || !Number.isFinite(controller.scheduledTime) || controller.scheduledTime < 0 || controller.scheduledTime > 8.64e15) throw new Error("INVALID_SCHEDULE_EVENT");
      const key = `${controller.cron}:${controller.scheduledTime}`;
      if (invocations.has(key)) {
        logger({ component: "daily-eod-external-cron", status: "SKIPPED", reason: "SAME_ISOLATE_REPLAY", scheduledAt: new Date(controller.scheduledTime).toISOString() });
      } else {
        if (invocations.size >= 32) invocations.delete(invocations.keys().next().value);
        invocations.set(key, run(controller, env));
      }
      const result = await invocations.get(key);
      // Failed/uncertain dispatch must not turn the Cloudflare Cron event green.
      if (result.status === "FAILED" || result.status === "OUTCOME_UNKNOWN") throw new Error(result.reason);
      return result;
    },
    // No public or local HTTP endpoint is allowed to dispatch the workflow.
    async fetch() { return new Response("Not found", { status: 404 }); },
  };
}

export default createWorker();
