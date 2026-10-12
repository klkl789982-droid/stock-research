import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, randomUUID } from "node:crypto";
import { createLocalExecutionStore } from "./store.mjs";
import { createKisSource } from "./kis-source.mjs";
import { createExecutor, clockKst, safeReason } from "./engine.mjs";
import { repositoryInputs } from "./runtime.mjs";
import { startPrivateApi } from "./api.mjs";
import { publishLiveSignal } from "./publisher.mjs";

const root = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const option = (key) => process.argv.find((arg) => arg.startsWith(`--${key}=`))?.slice(key.length + 3);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function main() {
  const command = option("mode") ?? "shadow", stateDir = option("state-dir");
  if (!["shadow", "daemon", "live", "verify"].includes(command) || !stateDir || !path.isAbsolute(stateDir)) throw new Error("EXECUTOR_ARGUMENT_INVALID");
  const store = createLocalExecutionStore(stateDir, { repositoryRoot: root });
  const source = command === "verify" ? null : createKisSource({ credentials: { appKey: process.env.KIS_APP_KEY, appSecret: process.env.KIS_APP_SECRET } });
  const inputs = repositoryInputs(root, { remote: command === "daemon" });
  const executor = createExecutor({ store, source, ...inputs, onProgress: (value) => console.log(JSON.stringify({ event: "collectionProgress", ...value })),
    publish: process.env.LIVE_EXECUTOR_PUBLISH_ENABLED === "true" ? (signal) => publishLiveSignal({ signal, checkoutDir: process.env.LIVE_EXECUTOR_PUBLISH_CHECKOUT }) : null });
  if (command === "daemon") {
    await inputs.verifyFormula();
    console.log(JSON.stringify({ event: "executorStarted", scheduler: "localPersistentProcess", mode: "LIVE_PRIVATE_STORAGE", collectionWindow: "14:30:00-14:35:00 KST", publicationEnabled: process.env.LIVE_EXECUTOR_PUBLISH_ENABLED === "true" }));
    let stopping = false;
    process.on("SIGINT", () => { stopping = true; }); process.on("SIGTERM", () => { stopping = true; });
    // Persistent checkpoints make process restarts safe. The host must remain awake.
    await store.withLock("daemon", async () => {
      let lastHeartbeat = 0;
      while (!stopping) {
        const clock = clockKst(Date.now());
        let result = null;
        try {
          if (clock.time >= "14:10:00") result = await executor.advance({ mode: "live", date: clock.date });
          // Older publication retries cannot delay the time-critical preparation/collection.
          if (clock.time < "14:00:00" || clock.time > "14:40:00") {
            for (const date of (await store.read("live/outbox.json"))?.dates ?? []) {
              if (date !== clock.date) await executor.advance({ mode: "live", date });
            }
          }
          if (Date.now() - lastHeartbeat >= 60000) {
            await store.writeMutable("live/daemon-status.json", { heartbeatAt: new Date().toISOString(), scheduler: "localPersistentProcess", result, publicationEnabled: process.env.LIVE_EXECUTOR_PUBLISH_ENABLED === "true" });
            lastHeartbeat = Date.now();
          }
        } catch (error) { console.log(JSON.stringify({ event: "executorFailed", reason: safeReason(error), at: new Date().toISOString() })); }
        await wait(clock.time >= "14:29:00" && clock.time <= "14:35:00" ? 250 : 10000);
      }
    });
    return;
  }
  const mode = command === "live" ? "live" : "shadow";
  if (command !== "verify") {
    const date = clockKst(Date.now()).date;
    const runId = mode === "live" ? date : option("run-id") ?? randomUUID();
    const result = await executor.advance({ mode, date, runId });
    console.log(JSON.stringify({ event: "executionResult", mode, date, runId, ...result, requests: source.getMetrics() }));
    if (result.status !== "STORED") { process.exitCode = 1; return; }
  }
  // Actual HTTP readback in a fresh store instance. Token is ephemeral, never logged.
  const readStore = createLocalExecutionStore(stateDir, { repositoryRoot: root });
  const token = randomBytes(32).toString("hex");
  const api = await startPrivateApi({ store: readStore, mode, token });
  try {
    const unauthorized = await fetch(`${api.url}/top`);
    if (unauthorized.status !== 401) throw new Error("EXECUTOR_API_AUTH_REGRESSION");
    const counts = {};
    let observationType, contentHash;
    for (const model of ["A", "B", "C", "D"]) {
      const response = await fetch(`${api.url}/top?model=${model}&limit=5`, { headers: { Authorization: `Bearer ${token}` } });
      if (!response.ok) throw new Error("EXECUTOR_API_READBACK_FAILED");
      const body = await response.json(); counts[model] = body.records.length; observationType = body.observationType; contentHash = body.contentHash;
    }
    console.log(JSON.stringify({ event: "authenticatedApiVerified", mode, observationType, contentHash, topCounts: counts, unauthorizedStatus: unauthorized.status, sourcePricesReturned: false }));
  } finally { await api.close(); }
}
await main().catch((error) => { console.error(JSON.stringify({ event: "executorError", reason: safeReason(error) })); process.exitCode = 1; });
