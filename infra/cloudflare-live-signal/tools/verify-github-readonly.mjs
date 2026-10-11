// Diagnostic ONLY: wrangler dev tools/verify-github-readonly.mjs --remote
// --config wrangler.jsonc --ip 127.0.0.1. Never deploy this as the scheduler.
// Remote preview inherits the deployed secret server-side; no local token is needed.
const REPOSITORY = "klkl789982-droid/stock-research";
const WORKFLOW = "intraday-model-top-official-signal.yml";
const REPO_API = `https://api.github.com/repos/${REPOSITORY}`;
const WORKFLOW_API = `${REPO_API}/actions/workflows/${WORKFLOW}`;
const RUN_STATES = ["completed", "queued", "in_progress", "requested", "waiting", "pending"];

export async function verifyGitHubReadonly(env, { fetchImpl = fetch } = {}) {
  const report = {
    status: "FAILED", reason: null, credentialPresent: Boolean(env.GITHUB_TOKEN),
    authentication: "NOT_VERIFIED", repositoryRead: "NOT_VERIFIED",
    workflowRead: "NOT_VERIFIED", runListRead: "NOT_VERIFIED",
    dispatchEnabled: env.DISPATCH_ENABLED === "true", dispatchAttempted: false,
    dispatchWritePermission: "NOT_VERIFIED_READ_ONLY", checks: [],
  };
  const fail = (reason) => ({ ...report, reason });
  if (env.DISPATCH_ENABLED !== "false") return fail("REQUIRES_DISABLED_DISPATCH");
  if (!env.GITHUB_TOKEN) return fail("CREDENTIAL_UNAVAILABLE");
  const headers = {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "Tight-Budget-Live-Readonly-Verification",
  };
  // Fixed GET destinations; no redirects, mutations, body/error logging or retries.
  const endpoints = [
    ["authentication", "https://api.github.com/user"], ["repository", REPO_API],
    ["workflow", WORKFLOW_API], ["runs", `${WORKFLOW_API}/runs?branch=main&per_page=30`],
  ];
  for (const [check, url] of endpoints) {
    let response, body;
    try {
      response = await fetchImpl(url, { method: "GET", headers, redirect: "manual", signal: AbortSignal.timeout(10000) });
      report.checks.push({ check, httpStatus: response.status });
      if (!response.ok) return fail(`${check.toUpperCase()}_HTTP_${response.status}`);
      body = await response.json();
    } catch { return fail(`${check.toUpperCase()}_UNAVAILABLE`); }
    if (check === "authentication") {
      if (!Number.isInteger(body?.id) || body.id <= 0) return fail("AUTHENTICATION_INVALID_RESPONSE");
      report.authentication = "VERIFIED";
    } else if (check === "repository") {
      if (body?.full_name !== REPOSITORY || body?.default_branch !== "main") return fail("REPOSITORY_TARGET_MISMATCH");
      report.repositoryRead = "VERIFIED";
    } else if (check === "workflow") {
      if (body?.path !== `.github/workflows/${WORKFLOW}` || body?.state !== "active") return fail("WORKFLOW_TARGET_OR_STATE_INVALID");
      report.workflowRead = "VERIFIED";
    } else {
      if (!Array.isArray(body?.workflow_runs) || body.workflow_runs.some((run) => !RUN_STATES.includes(run?.status))) return fail("RUN_CHECK_INVALID");
      report.runListRead = "VERIFIED";
      report.activeMainRuns = body.workflow_runs.filter((run) => run.head_branch === "main" && run.status !== "completed").length;
    }
  }
  return { ...report, status: "READ_ONLY_VERIFIED" };
}

// Authenticated, temporary Wrangler preview, not a production HTTP route.
// Cache per preview isolate so reloads do not repeat authenticated requests.
let verification;
const diagnostic = { async fetch(request, env) {
  const url = new URL(request.url);
  if (request.method !== "GET" || url.pathname !== "/verify-github-readonly" || url.search) return new Response(null, { status: 404 });
  verification ??= verifyGitHubReadonly(env);
  return Response.json(await verification, { headers: { "Cache-Control": "no-store" } });
} };
export default diagnostic;
