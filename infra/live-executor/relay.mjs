import path from "node:path";
import { createLocalExecutionStore } from "./store.mjs";
import { enqueueStoredSiteDelivery, retrySiteDeliveries, privateSiteWriter } from "./site-delivery-agent.mjs";
const directory = process.argv.find(value => value.startsWith("--state-dir="))?.slice(12);
try {
  if (!directory || !path.isAbsolute(directory) || process.argv.slice(2).some(value => !value.startsWith("--state-dir=") && !["--queue", "--send"].includes(value))) throw new Error("SITE_RELAY_ARGUMENT_INVALID");
  const store = createLocalExecutionStore(directory);
  const writer = process.argv.includes("--send") ? privateSiteWriter() : null;
  if (process.argv.includes("--send") && !writer) throw new Error("SITE_RELAY_SEND_NOT_ENABLED");
  const queued = process.argv.includes("--queue") ? await enqueueStoredSiteDelivery(store) : null;
  const queue = await store.read("live/site-delivery-queue.json") ?? { keys: [] };
  const results = writer ? await retrySiteDeliveries(store, writer) : [];
  console.log(JSON.stringify({ status: writer ? "RELAY_ATTEMPTED" : "INSPECTED_NO_NETWORK", pendingCount: queue.keys.length, queued, results, collectedPrices: false, websiteVerified: false }));
  if (results.some(result => result.status === "FAILED")) process.exitCode = 1;
} catch (error) {
  console.error(JSON.stringify({ status: "BLOCKED", reason: /^[A-Z][A-Z0-9_]{2,95}$/u.test(error?.message ?? "") ? error.message : "SITE_RELAY_FAILED" })); process.exitCode = 1;
}
