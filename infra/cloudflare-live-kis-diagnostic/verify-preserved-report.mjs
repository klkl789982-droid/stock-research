import { fileURLToPath } from "node:url";
import path from "node:path";
import { createHash } from "node:crypto";
import { writerEnvironment } from "../live-executor/writer-environment.mjs";
import { createKisEodPrivateStore } from "../../lib/kis-eod-private-store.mjs";

// Existing off-hours aggregate only. No KIS endpoint, source prices, normal
// delivery head, credential discovery, or Cloudflare Workflow invocation.
const key = "cloud-isolated-tests/reports/actual553-20261019i.json";
const expected = "12ee9deec4cdcdefa2b895a62bfa018c319482c61480752189cef06ed26f937e";
export async function verifyPreservedReport(store) {
  await store.verifyPrivateRepository();
  const before = await store.read(key);
  if (!before || before.contentHash !== expected || createHash("sha256").update(before.bytes).digest("hex") !== expected
    || before.value.namespace !== "cloud-kis-off-hours-diagnostic-v1" || before.value.publicationEligible !== false
    || before.value.sourcePricesIncluded !== false || before.value.eligibleForLive !== false) throw new Error("PRESERVED_REPORT_INVALID");
  const duplicate = await store.writeImmutable(key, before.value);
  const after = await store.read(key);
  if (duplicate.status !== "ALREADY_STORED" || duplicate.contentHash !== expected || after?.contentHash !== expected
    || after.bytes !== before.bytes) throw new Error("PRESERVED_REPORT_CHANGED");
  return { status: "PRESERVED_REPORT_VERIFIED", hash: expected, duplicate: duplicate.status,
    kisRequests: 0, cloudflareWorkflowSteps: 0, operationalPointerChanged: false,
    observationType: "OFF_HOURS_DIAGNOSTIC", publicationEligible: false };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const env = await writerEnvironment();
    if (!env.PRIVATE_LIVE_DELIVERY_WRITE_TOKEN) throw new Error("APPROVED_WRITER_UNAVAILABLE");
    const store = createKisEodPrivateStore({ repository: "klkl789982-droid/tight-budget-private-data", token: env.PRIVATE_LIVE_DELIVERY_WRITE_TOKEN });
    console.log(JSON.stringify(await verifyPreservedReport(store)));
  } catch (error) {
    const reason = /^[A-Z][A-Z0-9_]+$/u.test(error?.code ?? error?.message ?? "") ? error.code ?? error.message : "PRESERVED_REPORT_CHECK_FAILED";
    console.error(JSON.stringify({ status: "BLOCKED", reason })); process.exitCode = 1;
  }
}
