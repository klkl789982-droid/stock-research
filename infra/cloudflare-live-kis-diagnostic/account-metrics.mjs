import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
const account = "a270e8d00736b9adbeaab41945266c99";
const query = `query Usage($a:string!,$s:Time,$e:Time,$month:Date,$storageFrom:Date){viewer{accounts(filter:{accountTag:$a}){
  dayWorkflows:workflowsAdaptiveGroups(limit:100,filter:{datetimeHour_geq:$s,datetimeHour_leq:$e}){count sum{stepCount} dimensions{eventType}}
  workers:workersInvocationsAdaptive(limit:1,filter:{datetime_geq:$s,datetime_leq:$e}){sum{requests}}
  doRequests:durableObjectsInvocationsAdaptiveGroups(limit:1,filter:{datetime_geq:$s,datetime_leq:$e}){sum{requests}}
  doCompute:durableObjectsPeriodicGroups(limit:1,filter:{datetime_geq:$s,datetime_leq:$e}){sum{duration rowsRead rowsWritten}}
  sql:durableObjectsSqlStorageGroups(limit:1000,filter:{date_geq:$storageFrom}){max{storedBytes} dimensions{namespaceId}}
  monthStorage:workflowsAdaptiveGroups(limit:1,filter:{date_geq:$month}){sum{storageRate}}
}}}`;
const metric = (groups, name) => Array.isArray(groups) && groups.length && groups.every(r => Number.isFinite(r.sum?.[name]) && r.sum[name] >= 0)
  ? groups.reduce((n, r) => n + r.sum[name], 0) : null;

export function summarizeAccountMetrics(payload, observedAt) {
  const now = Date.parse(observedAt), rows = payload?.data?.viewer?.accounts;
  if (!Number.isFinite(now) || !Array.isArray(rows) || rows.length !== 1 || payload.errors?.length) throw new Error("ACCOUNT_ANALYTICS_INVALID");
  const value = rows[0], peaks = new Map();
  for (const row of value.sql ?? []) {
    if (typeof row.dimensions?.namespaceId !== "string" || !Number.isFinite(row.max?.storedBytes) || row.max.storedBytes < 0) throw new Error("ACCOUNT_STORAGE_METRIC_INVALID");
    peaks.set(row.dimensions.namespaceId, Math.max(peaks.get(row.dimensions.namespaceId) ?? 0, row.max.storedBytes));
  }
  return { observedAt, utcDay: observedAt.slice(0, 10), source: "Cloudflare official GraphQL, account-wide UTC-day filter",
    workersRequestsReported: metric(value.workers, "requests"), doRequestsReported: metric(value.doRequests, "requests"),
    doDurationRawMetric: metric(value.doCompute, "duration"), sqlRowsReadReported: metric(value.doCompute, "rowsRead"), sqlRowsWrittenReported: metric(value.doCompute, "rowsWritten"),
    workflowDayEventGroups: value.dayWorkflows ?? null,
    persistentSqlNamespacePeakBytes: peaks.size && value.sql.length < 1000 ? [...peaks.values()].reduce((a, b) => a + b, 0) : null,
    workflowStorageGrowthRawMetric: metric(value.monthStorage, "storageRate"), workflowStorageMetricUnit: "UNVERIFIED_NOT_CONVERTED_TO_GB_MONTHS",
    aggregationLagMs: null, completeAdmissionProof: false, paidFallback: false,
    interpretation: "Empty telemetry is not proof of exact zero/remaining allowance. Storage is not a daily-reset counter. Include independent plan/inventory/lag and storage-unit proof before cutover." };
}

export async function readAccountMetrics({ token, now = new Date().toISOString(), fetchImpl = fetch }) {
  if (typeof token !== "string" || !token || !Number.isFinite(Date.parse(now))) throw new Error("ACCOUNT_ANALYTICS_AUTH_UNAVAILABLE");
  const date = now.slice(0, 10), storageFrom = new Date(Date.parse(`${date}T00:00:00Z`) - 3 * 86400000).toISOString().slice(0, 10);
  let response, payload;
  try {
    response = await fetchImpl("https://api.cloudflare.com/client/v4/graphql", { method: "POST", redirect: "error", signal: AbortSignal.timeout(15000),
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables: { a: account, s: `${date}T00:00:00Z`, e: now, month: `${date.slice(0, 7)}-01`, storageFrom } }) });
    payload = await response.json();
  } catch { throw new Error("ACCOUNT_ANALYTICS_UNAVAILABLE"); }
  if ([401, 403].includes(response.status)) throw new Error("ACCOUNT_ANALYTICS_NOT_AUTHORIZED");
  if (response.status === 429 || payload.errors?.some(e => e.extensions?.code === "budget")) throw new Error("ACCOUNT_ANALYTICS_RATE_LIMITED");
  if (!response.ok) throw new Error("ACCOUNT_ANALYTICS_UNAVAILABLE");
  return summarizeAccountMetrics(payload, now);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    // Reuse only the approved Wrangler login at its standard Windows path.
    // No credential search, new token, account override, or secret output.
    const file = path.join(process.env.APPDATA, "xdg.config", ".wrangler", "config", "default.toml");
    const token = /^oauth_token\s*=\s*"([^"]+)"/mu.exec(await fs.readFile(file, "utf8"))?.[1];
    console.log(JSON.stringify(await readAccountMetrics({ token })));
  } catch (e) { console.error(JSON.stringify({ status: "BLOCKED", reason: /^ACCOUNT_[A-Z_]+$/u.test(e?.message ?? "") ? e.message : "ACCOUNT_ANALYTICS_AUTH_UNAVAILABLE" })); process.exitCode = 1; }
}
