import fs from "node:fs/promises";
import path from "node:path";
import { readAccountMetrics } from "./account-metrics.mjs";
const dir = process.argv[2]; if (!dir || !path.isAbsolute(dir)) throw new Error("PRIVATE_EVIDENCE_DIRECTORY_REQUIRED");
const token = /^oauth_token\s*=\s*"([^"]+)"/mu.exec(await fs.readFile(path.join(process.env.APPDATA, "xdg.config/.wrangler/config/default.toml"), "utf8"))?.[1];
const base = "https://api.cloudflare.com/client/v4/accounts/a270e8d00736b9adbeaab41945266c99/workflows/tight-budget-live-sql-replay/instances";
async function api(method, suffix = "", body) {
  const r = await fetch(base + suffix, { method, redirect: "error", signal: AbortSignal.timeout(20000),
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const j = await r.json(); if (!r.ok || !j.success) throw new Error(`SQL_CHECK_API_${r.status}`); return j.result;
}
try {
  const before = await readAccountMetrics({ token });
  const faultOnly = process.argv.includes("--fault-only"), finalOnly = process.argv.includes("--final-after-only") || faultOnly, reservedNativeWrites = faultOnly ? 1000 : finalOnly ? 22000 : 44000;
  if (before.sqlRowsWrittenReported + reservedNativeWrites + 15000 + 10000 > 100000 || before.sqlRowsReadReported + 300000 + 500000 > 5000000
    || before.doDurationRawMetric + 1000 + 1000 > 13000 || before.workflowAllOperationsReported + 110 > 3000
    || before.workflowStorageEvidence.positiveGrowthBytes * 2 / 1e9 + 0.05 >= 1
    || before.persistentSqlNamespacePeakBytes + 5000000 >= 4000000000) throw new Error("SQL_CHECK_FREE_BUDGET_BLOCKED");
  await fs.mkdir(dir, { recursive: true });
  const results = [];
  for (const mode of faultOnly ? ["fault"] : finalOnly ? ["after"] : ["before", "after"]) {
    const id = `sql-${mode}-20261020-${faultOnly ? "fixed" : finalOnly ? "final" : "v1"}`;
    const created = await api("POST", "", { instance_id: id, params: { mode } });
    if (created.id !== id) throw new Error("SQL_CHECK_FIXED_ID_NOT_APPLIED");
    let result;
    for (let n = 0; n < 20; n++) {
      result = await api("GET", `/${id}`);
      if (["complete", "errored", "terminated"].includes(result.status)) break;
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
    results.push({ id, created, result });
    await fs.writeFile(path.join(dir, `native-${mode}.json`), JSON.stringify(results.at(-1), null, 2), { flag: "wx" });
    console.log(JSON.stringify(results.at(-1)));
    if (result.status !== "complete") throw new Error("SQL_CHECK_WORKFLOW_FAILED");
    if (mode === "after" && (result.output?.completed !== 553 || result.output?.outbox !== true)) throw new Error("SQL_CHECK_FULL_SET_FAILED");
    if (mode === "fault" && (!result.output?.failedSqlCharged || !result.output?.frozenHashUnchanged || !result.output?.firstIssuanceUnchanged)) throw new Error("SQL_CHECK_REOPEN_FAILED");
  }
  await fs.writeFile(path.join(dir, "native-budget-and-results.json"), JSON.stringify({ before, reservedNativeWrites, otherEodReserve: 15000,
    lagWrittenReserve: 10000, limitsReset: "00:00 UTC / 09:00 KST; SQL storage does not reset", results }, null, 2), { flag: "wx" });
} catch (e) { console.error(JSON.stringify({ status: "BLOCKED", reason: /^[A-Z_0-9]+$/u.test(e.message) ? e.message : "SQL_CHECK_FAILED" })); process.exitCode = 1; }
