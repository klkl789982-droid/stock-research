import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, randomUUID } from "node:crypto";
import { createLocalExecutionStore } from "./store.mjs";
import { createKisSource } from "./kis-source.mjs";
import { createExecutor, clockKst, safeReason } from "./engine.mjs";
import { repositoryInputs } from "./runtime.mjs";
import { startPrivateApi } from "./api.mjs";
import { publishLiveSignal } from "./publisher.mjs";
import { privateApiToken } from "./private-token.mjs";
import { verifyPrivateQuery } from "./verify-query.mjs";
import { enforceParentLease } from "./parent-lease.mjs";
import { recordTop5SwingBatch } from "./swing-records.mjs";

enforceParentLease();

const root = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const option = (key) => process.argv.find((arg) => arg.startsWith(`--${key}=`))?.slice(key.length + 3);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function main() {
  const command = option("mode") ?? "shadow", stateDir = option("state-dir");
  if (!["shadow", "daemon", "live", "verify", "serve", "prepare"].includes(command) || !stateDir || !path.isAbsolute(stateDir)) throw new Error("EXECUTOR_ARGUMENT_INVALID");
  const store = createLocalExecutionStore(stateDir, { repositoryRoot: root });
  const apiMode = option("api-mode") ?? (command === "daemon" || command === "live" ? "live" : "shadow");
  const port = Number(option("api-port") ?? 4318);
  if (!["live", "shadow"].includes(apiMode) || (command === "daemon" && apiMode !== "live") || !Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("EXECUTOR_ARGUMENT_INVALID");
  if (command === "serve") {
    const token = await privateApiToken(stateDir);
    const api = await startPrivateApi({ store, mode: apiMode, token, port });
    console.log(JSON.stringify({ event: "privateApiStarted", mode: apiMode, address: api.url, collectionEnabled: false }));
    try { await new Promise((resolve) => { process.once("SIGINT", resolve); process.once("SIGTERM", resolve); }); }
    finally { await api.close(); }
    return;
  }
  const source = command === "verify" ? null : createKisSource({ credentials: { appKey: process.env.KIS_APP_KEY, appSecret: process.env.KIS_APP_SECRET } });
  const inputs = repositoryInputs(root, { remote: ["daemon", "prepare"].includes(command) });
  const executor = createExecutor({ store, source, ...inputs, onProgress: (value) => console.log(JSON.stringify({ event: "collectionProgress", ...value })),
    recordSwing: (signal) => recordTop5SwingBatch({ stateDir, signal, repositoryRoot: root }),
    publish: process.env.LIVE_EXECUTOR_PUBLISH_ENABLED === "true" ? (signal) => publishLiveSignal({ signal, checkoutDir: process.env.LIVE_EXECUTOR_PUBLISH_CHECKOUT }) : null });
  if (command === "prepare") {
    const prepared = await executor.prepare("live", clockKst(Date.now()).date);
    console.log(JSON.stringify({ event: "preparationVerified", date: prepared.date, preparedAt: prepared.preparedAt, universeCount: prepared.universeCount, eligibleCount: prepared.eligibleCount, clockEvidence: prepared.clockEvidence, requests: source.getMetrics(), observationCreated: false }));
    return;
  }
  if (command === "daemon") {
    await inputs.verifyFormula();
    console.log(JSON.stringify({ event: "executorStarted", scheduler: "localPersistentProcess", mode: "LIVE_PRIVATE_STORAGE", collectionWindow: "14:00:00-14:05:00 KST", publicationEnabled: process.env.LIVE_EXECUTOR_PUBLISH_ENABLED === "true" }));
    let stopping = false;
    process.on("SIGINT", () => { stopping = true; }); process.on("SIGTERM", () => { stopping = true; });
    // Persistent checkpoints make process restarts safe. The host must remain awake.
    await store.withLock("daemon", async () => {
      const token = await privateApiToken(stateDir);
      const api = await startPrivateApi({ store, mode: "live", token, port });
      let lastHeartbeat = 0, lastVerifiedHash = (await store.read("live/query-verification.json"))?.contentHash;
      await store.writeMutable("live/daemon-status.json", { heartbeatAt: new Date().toISOString(), scheduler: "localPersistentProcess", result: null, apiAvailable: true, publicationEnabled: process.env.LIVE_EXECUTOR_PUBLISH_ENABLED === "true" });
      lastHeartbeat = Date.now();
      let checkedClockDate = null, clockAttempts = 0, clockAttemptDate = null, nextClockCheck = 0;
      try { while (!stopping) {
        const clock = clockKst(Date.now());
        let result = null;
        try {
          if (clockAttemptDate !== clock.date) { clockAttemptDate = clock.date; clockAttempts = 0; nextClockCheck = 0; }
          if (clock.time >= "13:59:00" && clock.time <= "14:05:00" && checkedClockDate !== clock.date) {
            if (clockAttempts >= 3 || Date.now() < nextClockCheck) { await wait(1000); continue; }
            clockAttempts += 1; nextClockCheck = Date.now() + 60000;
            try {
              const evidence = await inputs.verifyClock();
              await store.writeMutable("live/clock-status.json", { ...evidence, status: "VERIFIED", date: clock.date });
              checkedClockDate = clock.date;
            } catch (error) {
              await store.writeMutable("live/clock-status.json", { status: "FAILED", date: clock.date, reason: safeReason(error), checkedAt: new Date().toISOString(), attempts: clockAttempts });
              throw error;
            }
          }
          if (clock.time >= "13:40:00") result = await executor.advance({ mode: "live", date: clock.date });
          if (result?.status === "STORED" && result.contentHash !== lastVerifiedHash) {
            const verification = await verifyPrivateQuery({ api, token, mode: "live", store });
            lastVerifiedHash = verification.contentHash;
          }
          // Older publication retries cannot delay the time-critical preparation/collection.
          if (clock.time < "13:30:00" || clock.time > "14:10:00") {
            for (const date of (await store.read("live/outbox.json"))?.dates ?? []) {
              if (date !== clock.date) await executor.advance({ mode: "live", date });
            }
          }
          if (Date.now() - lastHeartbeat >= 60000) {
            await store.writeMutable("live/daemon-status.json", { heartbeatAt: new Date().toISOString(), scheduler: "localPersistentProcess", result, apiAvailable: true, publicationEnabled: process.env.LIVE_EXECUTOR_PUBLISH_ENABLED === "true" });
            lastHeartbeat = Date.now();
          }
        } catch (error) { console.log(JSON.stringify({ event: "executorFailed", reason: safeReason(error), at: new Date().toISOString() })); }
        await wait(clock.time >= "13:59:00" && clock.time <= "14:05:00" ? 250 : 10000);
      } } finally { await api.close(); }
    });
    return;
  }
  const mode = command === "verify" ? apiMode : command === "live" ? "live" : "shadow";
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
    console.log(JSON.stringify({ event: "authenticatedApiVerified", ...await verifyPrivateQuery({ api, token, mode, store: readStore }) }));
  } finally { await api.close(); }
}
await main().catch((error) => { console.error(JSON.stringify({ event: "executorError", reason: safeReason(error) })); process.exitCode = 1; });
