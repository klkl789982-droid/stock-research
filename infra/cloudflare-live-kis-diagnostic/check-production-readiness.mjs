import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { repositoryInputs } from "../live-executor/runtime.mjs";
import { normalDayBudget, PRODUCTION_BUDGET } from "./production-core.mjs";
const root = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const arg = name => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const now = Date.now(), today = new Date(now + 9 * 3600000).toISOString().slice(0, 10), blockers = [];
let input = null, snapshot = null;
if (new Date(now).toISOString().slice(0, 10) !== today) blockers.push("POST_0900_KST_ACCOUNT_RECHECK_REQUIRED");
try {
  const source = repositoryInputs(root, { remote: true }), seed = await source.loadSeed(today);
  input = { referenceDate: seed.requestedDate, contentHash: seed.contentHash };
  await source.verifySeedSession(seed, today);
} catch (e) { blockers.push(/^(?:LIVE_INPUT|SEED)_[A-Z0-9_]+$/u.test(e.message) ? e.message : "OFFICIAL_INPUT_CHECK_FAILED"); }
if (arg("snapshot")) {
  try {
    snapshot = JSON.parse(await fs.readFile(path.resolve(arg("snapshot")), "utf8"));
    if (snapshot.utcDay !== new Date(now).toISOString().slice(0, 10) || !Number.isFinite(Date.parse(snapshot.observedAt))
      || now < Date.parse(snapshot.observedAt) || now - Date.parse(snapshot.observedAt) > 900000) blockers.push("FRESH_ACCOUNT_SNAPSHOT_REQUIRED");
    if (snapshot.workersFree !== true || snapshot.inventoryVerified !== true || snapshot.storageVerified !== true) blockers.push("ACCOUNT_OR_STORAGE_UNVERIFIED");
    if (!Number.isFinite(snapshot.persistentSqlBytes) || snapshot.persistentSqlBytes < 0 || snapshot.persistentSqlBytes + PRODUCTION_BUDGET.retainedBytesPerDay >= 4000000000)
      blockers.push("PERSISTENT_STORAGE_BUDGET_UNVERIFIED");
    if (!Number.isFinite(snapshot.workflowStorageGbMonthsUpperBound) || snapshot.workflowStorageGbMonthsUpperBound < 0
      || snapshot.workflowStorageGbMonthsUpperBound + PRODUCTION_BUDGET.workflowStorageGbMonths >= 1) blockers.push("WORKFLOW_STORAGE_BUDGET_UNVERIFIED");
    for (const [k, budget] of Object.entries(normalDayBudget())) {
      if (!Number.isFinite(snapshot.upperBound?.[k]) || snapshot.upperBound[k] < 0 || snapshot.upperBound[k] + budget.total > budget.limit) blockers.push(`ACCOUNT_BUDGET_${k}`);
    }
  } catch { blockers.push("ACCOUNT_SNAPSHOT_INVALID"); }
} else blockers.push("ACCOUNT_SNAPSHOT_REQUIRED");
const evidence = JSON.parse(await fs.readFile(path.join(root, "infra/cloudflare-live-kis-diagnostic/actual-evidence.json"), "utf8"));
const full = evidence.actualFullUniverseBenchmark;
if (full.processedSymbols !== 553 || full.completeModels !== full.requiredEligibleModels || full.collectionSucceeded !== true) blockers.push("ACTUAL_FULL_ELIGIBLE_SET_NOT_VERIFIED");
if (evidence.verification.normalProductionRelayAndAuthenticatedHomeReadbackFromCloud !== "PASS") blockers.push("NORMAL_CLOUD_RELAY_AND_AUTHENTICATED_SITE_NOT_VERIFIED");
console.log(JSON.stringify({ status: blockers.length ? "BLOCKED" : "READY_FOR_TWO_PHASE_CUTOVER", checkedAt: new Date(now).toISOString(),
  todayKst: today, input, blockers, normalDayBudget: normalDayBudget(), retention: { dailyDoCapBytes: PRODUCTION_BUDGET.retainedBytesPerDay,
    globalReservedStopBytes: 4000000000, workflowStateDays: 3, deletesExistingImmutableRecords: false },
  sideEffects: { kisCalls: 0, collectionTriggered: false, pcTaskChanged: false, productionFlagsChanged: false } }));
process.exitCode = blockers.length ? 2 : 0;
