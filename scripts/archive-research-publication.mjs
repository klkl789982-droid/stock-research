import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { kisEodPrivateStoreFromEnv } from "../lib/kis-eod-private-store.mjs";
import { archiveResearchPublication } from "../lib/research-publication-receipts.mjs";

// No credential or raw response is logged. This can run only after the existing production site verifier.
try {
  if (process.env.GITHUB_REPOSITORY !== "klkl789982-droid/stock-research" || process.env.GITHUB_REF !== "refs/heads/main" ||
    process.env.GITHUB_WORKFLOW !== "Daily production data" || process.env.GITHUB_JOB !== "publish") throw new Error();
  const receipt = JSON.parse(await readFile(join(process.env.RUNNER_TEMP, "daily-deployment-verification.json"), "utf8"));
  console.log("RESEARCH_PUBLICATION_RECEIPT", await archiveResearchPublication(receipt, kisEodPrivateStoreFromEnv(), {
    runId: Number(process.env.GITHUB_RUN_ID), runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT),
  }));
} catch {
  console.error("RESEARCH_PUBLICATION_RECEIPT_UNAVAILABLE");
  process.exitCode = 1;
}
