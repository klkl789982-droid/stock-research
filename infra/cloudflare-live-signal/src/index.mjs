// Independent, approval-gated prewarm trigger. No prices or signal writes.
export const CRONS = ["12,22 5 * * MON-FRI"]; // 14:12 / 14:22 KST
const API = "https://api.github.com/repos/klkl789982-droid/stock-research/actions/workflows/intraday-model-top-official-signal.yml";
export async function dispatchLivePrewarm(event, env, { fetchImpl = fetch, now = Date.now } = {}) {
  if (env.DISPATCH_ENABLED !== "true") return { status: "DISABLED" };
  if (!env.GITHUB_TOKEN) return { status: "FAILED", reason: "CREDENTIAL_UNAVAILABLE" };
  const scheduled = new Date(event.scheduledTime), current = new Date(now());
  if (!CRONS.includes(event.cron) || !Number.isFinite(scheduled.getTime()) || Math.abs(current - scheduled) > 120000
    || [0, 6].includes(current.getUTCDay()) || current.getUTCHours() !== 5 || current.getUTCMinutes() < 10 || current.getUTCMinutes() > 25) return { status: "SKIPPED", reason: "PREWARM_WINDOW_MISSED" };
  const headers = { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: "application/vnd.github+json", "Content-Type": "application/json", "User-Agent": "Tight-Budget-Live-Prewarm" };
  try {
    const response = await fetchImpl(`${API}/runs?branch=main&per_page=30`, { headers, redirect: "error", signal: AbortSignal.timeout(10000) });
    if (!response.ok) return { status: "FAILED", reason: `RUN_CHECK_HTTP_${response.status}` };
    const runs = (await response.json()).workflow_runs;
    if (!Array.isArray(runs) || runs.some((run) => !["completed", "queued", "in_progress", "requested", "waiting", "pending"].includes(run?.status))) return { status: "FAILED", reason: "RUN_CHECK_INVALID" };
    if (runs.some((run) => run.head_branch === "main" && run.status !== "completed")) return { status: "SKIPPED", reason: "WORKFLOW_ACTIVE" };
    const result = await fetchImpl(`${API}/dispatches`, { method: "POST", headers, body: JSON.stringify({ ref: "main", inputs: { mode: "live" } }), redirect: "error", signal: AbortSignal.timeout(10000) });
    // An ambiguous POST response must not cause an unbounded duplicate dispatch.
    return result.status === 204 ? { status: "DISPATCH_ACCEPTED_NOT_OBSERVATION_SUCCESS" } : { status: "FAILED", reason: `DISPATCH_HTTP_${result.status}` };
  } catch { return { status: "UNKNOWN", reason: "REQUEST_OUTCOME_UNCONFIRMED" }; }
}
const worker = { async scheduled(event, env) { console.log(JSON.stringify(await dispatchLivePrewarm(event, env))); } };
export default worker;
