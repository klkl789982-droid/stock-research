import { inspectLiveProductionDeployment } from "../lib/daily-production-deployment-verifier.mjs";
import { readFile } from "node:fs/promises";
import { isCurrentIntradayModelTopSignal } from "../lib/intraday-model-top-official-signal.mjs";
import { CURRENT_LIVE_PROFILE } from "../lib/intraday-model-top-time-policy.mjs";
const date = process.argv.find((arg) => arg.startsWith("--date="))?.slice(7);
if (!/^\d{4}-\d{2}-\d{2}$/u.test(date ?? "")) throw new Error("LIVE_PUBLICATION_DATE_REQUIRED");
const expected = JSON.parse(await readFile(`data/intraday-signals/model-top/${date}/${CURRENT_LIVE_PROFILE.slot}.json`, "utf8"));
if (!isCurrentIntradayModelTopSignal(expected) || expected.signalDate !== date || expected.status !== "READY") throw new Error("LIVE_PUBLICATION_IDENTITY_INVALID");
if (!process.env.TB_AUTOMATION_READ_TOKEN) throw new Error("AUTOMATION_READ_TOKEN_UNAVAILABLE");
let verified = false, reason = "LIVE_DEPLOYMENT_PENDING";
for (let attempt = 1; attempt <= 24; attempt += 1) {
  try {
    verified = await inspectLiveProductionDeployment({ siteUrl: "https://stock-research-chi.vercel.app", expectedSignalDate: date, expectedContentHash: expected.contentHash });
    if (verified) break;
  } catch (error) {
    reason = /^HTTP_\d+$/u.test(error?.message ?? "") ? error.message : "LIVE_DEPLOYMENT_UNAVAILABLE";
    if (["HTTP_401", "HTTP_403"].includes(reason)) break;
  }
  if (attempt < 24) await new Promise((resolve) => setTimeout(resolve, 15000));
}
console.log(`LIVE_PUBLICATION_RESULT_JSON=${JSON.stringify({ status: verified ? "VERIFIED" : "FAILED", expectedSignalDate: date, publicationVerifiedAt: verified ? new Date().toISOString() : null, checkedAt: new Date().toISOString(), reason: verified ? null : reason })}`);
if (!verified) process.exitCode = 1;
