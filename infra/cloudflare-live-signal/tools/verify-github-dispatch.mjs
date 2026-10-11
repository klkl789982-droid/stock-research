// Approval-only remote-preview tool, NOT a production entrypoint.
// Start while production is disabled; pass APPROVE_DRY_RUN_DISPATCH=true explicitly.
// Send exactly one POST /verify-github-dispatch-dry-run, then stop the preview.
import { verifyGitHubReadonly } from "./verify-github-readonly.mjs";
const TARGET = "https://api.github.com/repos/klkl789982-droid/stock-research/actions/workflows/intraday-model-top-official-signal.yml/dispatches";

export async function verifyDryRunDispatch(env, { fetchImpl = fetch, now = Date.now } = {}) {
  const result = (status, reason = null, extra = {}) => ({ status, reason, mode: "dry-run", workflowResult: "NOT_VERIFIED", liveObservationCreated: false, ...extra });
  if (env.APPROVE_DRY_RUN_DISPATCH !== "true") return result("BLOCKED", "EXPLICIT_APPROVAL_REQUIRED");
  const check = await verifyGitHubReadonly(env, { fetchImpl });
  if (check.status !== "READ_ONLY_VERIFIED") return result("BLOCKED", check.reason);
  if (check.activeMainRuns !== 0) return result("SKIPPED", "WORKFLOW_ACTIVE");
  const requestedAt = new Date(now()).toISOString();
  try {
    const response = await fetchImpl(TARGET, {
      method: "POST", redirect: "manual", signal: AbortSignal.timeout(10000),
      headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: "application/vnd.github+json", "Content-Type": "application/json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "Tight-Budget-Live-Dispatch-Verification" },
      body: JSON.stringify({ ref: "main", inputs: { mode: "dry-run", trigger_source: "cloudflare-live-dispatch-verification" } }),
    });
    return response.status === 204
      ? result("DISPATCH_ACCEPTED", null, { requestedAt, httpStatus: 204 })
      : result("FAILED", `DISPATCH_HTTP_${response.status}`, { requestedAt, httpStatus: response.status });
  } catch {
    // A timed-out POST may have succeeded. Inspect GitHub before any further request.
    return result("UNKNOWN", "REQUEST_OUTCOME_UNCONFIRMED", { requestedAt });
  }
}

// Suppresses accidental reloads within the preview isolate, not a distributed lock.
let verification;
const diagnostic = { async fetch(request, env) {
  const url = new URL(request.url);
  if (request.method !== "POST" || url.pathname !== "/verify-github-dispatch-dry-run" || url.search) return new Response(null, { status: 404 });
  verification ??= verifyDryRunDispatch(env);
  return Response.json(await verification, { headers: { "Cache-Control": "no-store" } });
} };
export default diagnostic;
