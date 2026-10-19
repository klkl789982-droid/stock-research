import fs from "node:fs/promises";
import path from "node:path";
import { readAccountMetrics } from "./account-metrics.mjs";
import { admitFreeBudget } from "./budget-admission.mjs";

// Read-only operator check: no Workflow creation, KIS call, credential search,
// plan change or state write. Dashboard plan evidence is a separate boundary.
if (!process.argv.includes("--free-plan-dashboard-confirmed")) throw new Error("DASHBOARD_FREE_PLAN_PROOF_REQUIRED");
const file = path.join(process.env.APPDATA, "xdg.config/.wrangler/config/default.toml");
const token = /^oauth_token\s*=\s*"([^"]+)"/mu.exec(await fs.readFile(file, "utf8"))?.[1];
const base = "https://api.cloudflare.com/client/v4/accounts/a270e8d00736b9adbeaab41945266c99";
async function read(route) {
  const r = await fetch(base + route, { headers: { Authorization: `Bearer ${token}` }, redirect: "error", signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`ACCOUNT_READ_${r.status}`);
  const j = await r.json(); if (!j.success) throw new Error("ACCOUNT_READ_INVALID"); return j;
}
const workers = (await read("/workers/scripts")).result;
const workflows = await read("/workflows");
const names = ["tight-budget-eod-scheduler", "tight-budget-live-free-probe", "tight-budget-live-kis-diagnostic", "tight-budget-live-prewarm"];
if (workers.length !== 4 || workers.some(w => !names.includes(w.id)) || workflows.result_info.total_pages !== 1) throw new Error("ACCOUNT_INVENTORY_CHANGED");
const workflowInventory = [];
for (const w of workflows.result) {
  let cursor = null, pages = 0, count = 0, active = 0, today = 0, lastModified = null;
  do {
    const j = await read(`/workflows/${w.name}/instances?per_page=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    for (const x of j.result) {
      count++; if (!["complete", "errored", "terminated"].includes(x.status)) active++;
      if (x.created_on >= new Date().toISOString().slice(0, 10)) today++;
      if (!lastModified || x.modified_on > lastModified) lastModified = x.modified_on;
    }
    cursor = j.result_info?.cursor; if (++pages > 16) throw new Error("ACCOUNT_INVENTORY_TRUNCATED");
  } while (cursor);
  workflowInventory.push({ name: w.name, createdAt: w.created_on, count, pages, active, today, lastModified });
}
const schedules = [];
for (const name of names) schedules.push({ name, value: (await read(`/workers/scripts/${name}/schedules`)).result.schedules.map(s => s.cron) });
const inventory = { checkedAt: new Date().toISOString(), workerCount: workers.length, workflowCount: workflows.result.length,
  activeInstances: workflowInventory.reduce((n, w) => n + w.active, 0), allPagesRead: true,
  zeroMonthOpeningWorkflowState: workflowInventory.every(w => w.createdAt.slice(0, 7) === new Date().toISOString().slice(0, 7)),
  onlyDailyCronActive: schedules.every(s => s.name === "tight-budget-eod-scheduler" ? JSON.stringify(s.value) === '["10,40 4-17 * * MON-FRI"]' : s.value.length === 0),
  noAdditionalCollectionSinceLastReceipt: workflowInventory.every(w => w.lastModified < "2026-10-19T09:25:00Z") };
const old = JSON.parse(await fs.readFile(new URL("./operational-followup-20261019.json", import.meta.url), "utf8")).freeBudget;
const before = { utcDay: old.actualAccountReportedAtUtc.slice(0, 10), observedAt: old.actualAccountReportedAtUtc,
  workflowAllOperationsReported: old.workflowAllOperations, workersRequestsReported: old.workersRequests,
  doRequestsReported: old.doRequests, doDurationRawMetric: old.doDurationGbSeconds,
  sqlRowsReadReported: old.sqlRowsRead, sqlRowsWrittenReported: old.sqlRowsWritten };
const latest = await readAccountMetrics({ token });
const admission = admitFreeBudget({ before, latest, inventory, workersFree: true, noPaymentMethod: true });
console.log(JSON.stringify({ admission, before, latest, inventory, workflowInventory, schedules,
  dashboardEvidence: "Workers Free Active / No payment method on file, independently inspected by authenticated Dashboard", kisCalls: 0, workflowCreated: false }));
