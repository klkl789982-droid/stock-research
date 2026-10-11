// Independent, approval-gated prewarm trigger. No prices or signal writes.
export const CRONS = ["12,22 5 * * MON-FRI"]; // 14:12 / 14:22 KST
const API = "https://api.github.com/repos/klkl789982-droid/stock-research/actions/workflows/intraday-model-top-official-signal.yml";
const validSlot = (event, nowMs) => {
  const scheduled = new Date(event.scheduledTime);
  return CRONS.includes(event.cron) && Number.isFinite(scheduled.getTime()) && Number.isFinite(nowMs)
    && ![0, 6].includes(scheduled.getUTCDay()) && scheduled.getUTCHours() === 5
    && [12, 22].includes(scheduled.getUTCMinutes()) && scheduled.getUTCSeconds() === 0
    && nowMs >= scheduled.getTime() && nowMs - scheduled.getTime() <= 120000;
};
export async function dispatchLivePrewarm(event, env, { fetchImpl = fetch, now = Date.now, wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  const started = now();
  const scheduledAt = Number.isFinite(event.scheduledTime) ? new Date(event.scheduledTime).toISOString() : null;
  const timing = { scheduledAt, workerStartedAt: new Date(started).toISOString(), schedulerDelayMs: scheduledAt ? started - event.scheduledTime : null,
    dispatchRequestedAt: null, dispatchRespondedAt: null };
  const result = (status, reason = null) => ({ status, reason, ...timing, workflowResult: "NOT_VERIFIED", publicationResult: "NOT_VERIFIED" });
  if (env.DISPATCH_ENABLED !== "true") return result("DISABLED");
  if (!env.GITHUB_TOKEN) return result("FAILED", "CREDENTIAL_UNAVAILABLE");
  if (!validSlot(event, started)) return result("SKIPPED", "PREWARM_WINDOW_MISSED");
  const headers = { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: "application/vnd.github+json", "Content-Type": "application/json", "User-Agent": "Tight-Budget-Live-Prewarm" };
  try {
    let response;
    // Read-only checks may retry once. A possibly accepted POST must never retry blindly.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try { response = await fetchImpl(`${API}/runs?branch=main&per_page=30`, { headers, redirect: "manual", signal: AbortSignal.timeout(10000) }); }
      catch { if (attempt === 1) return result("FAILED", "RUN_CHECK_UNAVAILABLE"); }
      if (response && (response.ok || (response.status !== 429 && response.status < 500) || attempt === 1)) break;
      await wait(1000);
    }
    if (!response?.ok) return result("FAILED", `RUN_CHECK_HTTP_${response?.status ?? "UNAVAILABLE"}`);
    const runs = (await response.json()).workflow_runs;
    if (!Array.isArray(runs) || runs.some((run) => !["completed", "queued", "in_progress", "requested", "waiting", "pending"].includes(run?.status))) return result("FAILED", "RUN_CHECK_INVALID");
    if (runs.some((run) => run.head_branch === "main" && run.status !== "completed")) return result("SKIPPED", "WORKFLOW_ACTIVE");
    if (!validSlot(event, now())) return result("SKIPPED", "PREWARM_WINDOW_MISSED");
    timing.dispatchRequestedAt = new Date(now()).toISOString();
    const dispatched = await fetchImpl(`${API}/dispatches`, { method: "POST", headers, body: JSON.stringify({ ref: "main", inputs: { mode: "live", scheduled_at: scheduledAt, trigger_source: "cloudflare-live-prewarm" } }), redirect: "manual", signal: AbortSignal.timeout(10000) });
    timing.dispatchRespondedAt = new Date(now()).toISOString();
    return dispatched.status === 204 ? result("DISPATCH_ACCEPTED_NOT_OBSERVATION_SUCCESS") : result("FAILED", `DISPATCH_HTTP_${dispatched.status}`);
  } catch { return timing.dispatchRequestedAt ? result("UNKNOWN", "REQUEST_OUTCOME_UNCONFIRMED") : result("FAILED", "RUN_CHECK_INVALID"); }
}
// Isolate-local replay suppression only. GitHub concurrency and create-only artifacts
// remain the cross-isolate safety boundary; this is not an exactly-once guarantee.
const events = new Map();
export async function scheduledOnce(event, env, options = {}) {
  const nowMs = (options.now ?? Date.now)();
  for (const [key, item] of events) if (nowMs - item.started > 180000) events.delete(key);
  const key = `${event.cron}:${event.scheduledTime}`;
  if (!events.has(key)) events.set(key, { started: nowMs, promise: dispatchLivePrewarm(event, env, options) });
  return events.get(key).promise;
}
const worker = { async scheduled(event, env) {
  const result = await scheduledOnce(event, env);
  console.log(JSON.stringify(result)); // Fixed codes and timestamps only; no response bodies or secrets.
  if (["FAILED", "UNKNOWN"].includes(result.status)) throw new Error(result.reason);
} };
export default worker;
