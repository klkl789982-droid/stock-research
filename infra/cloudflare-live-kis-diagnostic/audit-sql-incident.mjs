import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { readAccountMetrics } from "./account-metrics.mjs";
const output = process.argv[2];
if (!output || !path.isAbsolute(output)) throw new Error("PRIVATE_OUTPUT_REQUIRED");
const name = "tight-budget-live-kis-diagnostic";
const token = /^oauth_token\s*=\s*"([^"]+)"/mu.exec(await fs.readFile(path.join(process.env.APPDATA, "xdg.config/.wrangler/config/default.toml"), "utf8"))?.[1];
const base = "https://api.cloudflare.com/client/v4/accounts/a270e8d00736b9adbeaab41945266c99";
async function read(route) {
  const r = await fetch(base + route, { headers: { Authorization: `Bearer ${token}` }, redirect: "error", signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`CLOUD_READ_${r.status}`);
  const j = await r.json(); if (!j.success) throw new Error("CLOUD_READ_INVALID"); return j;
}
try {
  const settings = (await read(`/workers/scripts/${name}/settings`)).result;
  const deployments = (await read(`/workers/scripts/${name}/deployments`)).result;
  const schedules = (await read(`/workers/scripts/${name}/schedules`)).result;
  const workers = (await read("/workers/scripts")).result;
  const workflows = (await read("/workflows")).result;
  const instances = [];
  for (const id of ["live-2026-10-20", "live-2026-10-20-batch64", "live-2026-10-20-relay06", "live-2026-10-20-relay08", "live-2026-10-20-relay10"]) {
    const j = await read(`/workflows/tight-budget-live-production/instances/${id}`);
    instances.push({ id, result: j.result });
  }
  const children = (await read("/workflows/tight-budget-live-production/instances?per_page=100"));
  const metrics = await readAccountMetrics({ token });
  const script = await fetch(`${base}/workers/scripts/${name}`, { headers: { Authorization: `Bearer ${token}` }, redirect: "error", signal: AbortSignal.timeout(20000) });
  if (!script.ok) throw new Error(`CLOUD_SOURCE_${script.status}`);
  const bytes = Buffer.from(await script.arrayBuffer());
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(path.join(output, "deployed-source.multipart"), bytes, { flag: "wx" });
  const evidence = { checkedAt: new Date().toISOString(), settings: {
    bindings: settings.bindings.map(b => b.type === "plain_text" && ["LIVE_PRODUCTION_ENABLED", "LIVE_PRODUCER", "LIVE_CUTOVER_RECEIPT_HASH", "DIAGNOSTIC_ONLY", "LIVE_ENABLED"].includes(b.name) ? b : { name: b.name, type: b.type, class_name: b.class_name, namespace_id: b.namespace_id }),
    compatibility_date: settings.compatibility_date, compatibility_flags: settings.compatibility_flags,
    observability: settings.observability }, deployments, schedules,
    workerNames: workers.map(w => w.id), workflowNames: workflows.map(w => w.name),
    instances, latestInstanceInventory: children, metrics,
    deployedSourceSha256: createHash("sha256").update(bytes).digest("hex"),
    kisCalls: 0, stateRpcCalls: 0, workflowCreated: false };
  await fs.writeFile(path.join(output, "read-only-before.json"), JSON.stringify(evidence, null, 2), { flag: "wx" });
  console.log(JSON.stringify({ status: "AUDIT_SAVED", output, deployments, schedules, metrics,
    instances: instances.map(x => ({ id: x.id, status: x.result.status, error: x.result.error, steps: x.result.steps?.map(s => ({ name: s.name, type: s.type, success: s.success, error: s.error, start: s.start, end: s.end })) })) }));
} catch (e) { console.error(JSON.stringify({ status: "BLOCKED", code: /^(?:CLOUD_|ACCOUNT_)[A-Z_0-9]+$/u.test(e.message) ? e.message : "CLOUD_AUDIT_FAILED" })); process.exitCode = 1; }
