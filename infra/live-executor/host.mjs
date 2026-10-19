import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { createLocalExecutionStore } from "./store.mjs";
import { writerEnvironment } from "./writer-environment.mjs";

const repositoryRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const reasonFor = (error) => /^[A-Z][A-Z0-9_]{2,95}$/u.test(error?.message ?? "") ? error.message : "HOST_OPERATION_FAILED";
export function hostConfiguration(root, env = process.env) {
  const envFile = env.LIVE_EXECUTOR_ENV_FILE ?? path.join(root, ".env.local");
  if (!path.isAbsolute(envFile) || /[\0\r\n]/u.test(envFile)) throw new Error("HOST_ENV_FILE_INVALID");
  const scheduler = env.LIVE_EXECUTOR_SUPERVISOR_KIND ?? (process.platform === "win32" ? "windowsTaskScheduler" : "nodeProcessSupervisor");
  if (!["windowsTaskScheduler", "systemd", "nodeProcessSupervisor"].includes(scheduler)) throw new Error("HOST_SUPERVISOR_KIND_INVALID");
  return { envFile, scheduler };
}
export function supervisorRecorder(store, { sessionId = randomUUID(), now = () => new Date().toISOString(), scheduler = hostConfiguration(repositoryRoot).scheduler } = {}) {
  let sequence = 0, lastFailure = null, pending = Promise.resolve();
  const record = (value, updateStatus) => {
    const operation = pending.then(async () => {
      const checkedAt = now();
      const receipt = { ...value, sessionId, sequence: ++sequence, hostPid: process.pid, checkedAt, publicationEnabled: false, scheduler };
      await store.writeImmutable(`live/supervisor-events/${sessionId}/${String(sequence).padStart(6, "0")}.json`, receipt);
      if (["RESTART_WAIT", "EXHAUSTED"].includes(value.status)) lastFailure = { reason: value.reason, childExitCode: value.childExitCode, childExitSignal: value.childExitSignal ?? null, checkedAt };
      if (updateStatus) await store.writeMutable("live/supervisor.json", { ...receipt, lastFailure });
    });
    pending = operation.catch(() => {});
    return operation;
  };
  return { onStatus: value => record(value, true), onDiagnostic: value => record({ status: "CHILD_DIAGNOSTIC", ...value }, false) };
}
const wait = (ms, signal) => new Promise((resolve) => {
  if (signal?.aborted) { resolve(); return; }
  const complete = () => { clearTimeout(timer); signal?.removeEventListener("abort", complete); resolve(); };
  const timer = setTimeout(complete, ms);
  signal?.addEventListener("abort", complete, { once: true });
});

/** Fixed host calls this with run.mjs; test code injects isolated local child programs. */
export async function superviseChild({ command, args, cwd, env, signal, onStatus = async () => {}, health = null,
  onDiagnostic = async () => {},
  maxRestarts = 3, restartDelayMs = 30_000, healthIntervalMs = 10_000, terminateGraceMs = 10_000 }) {
  if (!Number.isInteger(maxRestarts) || maxRestarts < 0 || maxRestarts > 3) throw new Error("HOST_RESTART_LIMIT_INVALID");
  let restartCount = 0;
  let statusQueue = Promise.resolve();
  const emit = (value) => { statusQueue = statusQueue.then(() => onStatus(value)); return statusQueue; };
  while (!signal?.aborted) {
    const startedAt = new Date().toISOString();
    await emit({ status: "STARTING", restartCount, startedAt });
    let child, stopping = false, healthBusy = false, failure = null, forceTimer, leaseTimer;
    const reported = new Set();
    const outcome = await new Promise((resolve) => {
      let finished = false;
      const finish = (code, cause, exitSignal = null) => {
        if (finished) return;
        finished = true;
        clearInterval(healthTimer); clearInterval(leaseTimer); clearTimeout(forceTimer);
        signal?.removeEventListener("abort", terminate);
        resolve({ code, exitSignal, reason: failure ?? cause });
      };
      const terminate = () => {
        if (stopping) return;
        stopping = true;
        child?.kill("SIGTERM");
        forceTimer = setTimeout(() => child?.kill("SIGKILL"), terminateGraceMs);
      };
      const healthTimer = health ? setInterval(async () => {
        if (healthBusy || stopping) return;
        healthBusy = true;
        try {
          if (!await health({ startedAt, pid: child?.pid })) { failure = "HOST_HEARTBEAT_STALE"; terminate(); }
        } catch { failure = "HOST_HEALTH_CHECK_FAILED"; terminate(); }
        finally { healthBusy = false; }
      }, healthIntervalMs) : null;
      try {
        child = spawn(command, args, { cwd, env, windowsHide: true, shell: false, stdio: ["ignore", "ignore", "ignore", "ipc"] });
        leaseTimer = setInterval(() => {
          if (stopping || !child.connected) return;
          child.send({ type: "HOST_LEASE", sentAtMs: Date.now() }, (error) => { if (error && !stopping) { failure = "HOST_LEASE_LOST"; terminate(); } });
        }, 1000);
        child.once("error", () => finish(null, "HOST_CHILD_START_FAILED"));
        child.once("exit", (code, exitSignal) => { if (exitSignal) failure ??= "HOST_CHILD_SIGNALLED"; finish(code, code === 0 ? "HOST_CHILD_UNEXPECTED_EXIT" : "HOST_CHILD_FAILED", exitSignal); });
        child.on("message", message => {
          if (message?.type !== "EXECUTOR_DIAGNOSTIC" || !["executorFailed", "executorError"].includes(message.event)
            || !/^[A-Z][A-Z0-9_]{2,95}$/u.test(message.reason ?? "")) return;
          const key = `${message.event}:${message.reason}`;
          // Bound diagnostics per child; never persist stdout, response bodies,
          // credentials or arbitrary IPC fields supplied alongside the code.
          if (!reported.has(key) && reported.size < 32) {
            reported.add(key);
            const timing = Object.fromEntries(["leaseAgeMs", "timerDelayMs", "timeoutMs"].filter(k => Number.isFinite(message[k]) && message[k] >= 0 && message[k] <= 86400000).map(k => [k, message[k]]));
            Promise.resolve().then(() => onDiagnostic({ event: message.event, reason: message.reason, pid: child.pid, restartCount, ...timing }))
              .catch(() => { failure = "HOST_DIAGNOSTIC_WRITE_FAILED"; terminate(); });
          }
          if (message.event === "executorError") { failure = message.reason; terminate(); }
        });
        child.once("spawn", () => { emit({ status: "RUNNING", restartCount, startedAt, pid: child.pid, readiness: "PROCESS_ONLY" }).catch(() => { failure = "HOST_STATUS_WRITE_FAILED"; terminate(); }); });
        signal?.addEventListener("abort", terminate, { once: true });
        if (signal?.aborted) terminate();
      } catch { finish(null, "HOST_CHILD_START_FAILED"); }
    });
    if (signal?.aborted) {
      const result = { status: "STOPPED", restartCount, stoppedAt: new Date().toISOString(), reason: "HOST_STOP_REQUESTED", childExitCode: outcome.code, childExitSignal: outcome.exitSignal };
      await emit(result); return result;
    }
    if (restartCount >= maxRestarts) {
      const result = { status: "EXHAUSTED", restartCount, stoppedAt: new Date().toISOString(), reason: outcome.reason, childExitCode: outcome.code, childExitSignal: outcome.exitSignal };
      await emit(result); return result;
    }
    restartCount += 1;
    await emit({ status: "RESTART_WAIT", restartCount, reason: outcome.reason, childExitCode: outcome.code, childExitSignal: outcome.exitSignal, retryAt: new Date(Date.now() + restartDelayMs).toISOString() });
    await wait(restartDelayMs, signal);
  }
  const result = { status: "STOPPED", restartCount, stoppedAt: new Date().toISOString(), reason: "HOST_STOP_REQUESTED" };
  await emit(result); return result;
}

export async function withManagedHostOwnership(store, run, { now = Date.now, isAlive = pid => { process.kill(pid, 0); return true; } } = {}) {
  try { return await store.withLock("host", run); }
  catch (error) {
    if (error?.code !== "LIVE_STORE_LOCKED") throw error;
    const prior = await store.read("live/supervisor.json"), daemon = await store.read("live/daemon-status.json");
    const age = now() - Date.parse(daemon?.heartbeatAt), started = Date.parse(prior?.startedAt);
    if (!Number.isSafeInteger(error.ownerPid) || error.ownerPid !== prior?.hostPid || prior?.status !== "RUNNING"
      || daemon?.apiAvailable !== true || !Number.isFinite(age) || age < 0 || age > 420000
      || !Number.isFinite(started) || Date.parse(daemon.heartbeatAt) < started || !Number.isSafeInteger(prior.pid) || prior.pid < 1
      || !isAlive(prior.hostPid) || !isAlive(prior.pid)) throw new Error("HOST_ALREADY_RUNNING_HEALTH_UNVERIFIED");
    return { status: "ALREADY_RUNNING", reason: "EXISTING_HOST_AND_HEARTBEAT_VERIFIED", existingHostPid: prior.hostPid,
      heartbeatAt: daemon.heartbeatAt, observationCreated: false };
  }
}

export async function startManagedHost({ stateDir, signal, root = repositoryRoot }) {
  const { envFile, scheduler } = hostConfiguration(root), script = path.join(root, "infra/live-executor/run.mjs");
  if (!(await stat(envFile)).isFile() || !(await stat(script)).isFile()) throw new Error("HOST_REQUIRED_FILE_UNAVAILABLE");
  const store = createLocalExecutionStore(stateDir, { repositoryRoot: root });
  const recorder = supervisorRecorder(store, { scheduler });
  return withManagedHostOwnership(store, async () => {
  let deliveryEnv;
  try { deliveryEnv = await writerEnvironment(); }
  catch (error) {
    deliveryEnv = { PRIVATE_LIVE_DELIVERY_SEND_ENABLED: "false" };
    await store.writeMutable("live/site-relay-configuration.json", { status: "BLOCKED", reason: reasonFor(error), checkedAt: new Date().toISOString() });
  }
  return superviseChild({
    command: process.execPath, args: [`--env-file=${envFile}`, script, "--mode=daemon", `--state-dir=${stateDir}`], cwd: root,
    // Explicit inherited values take precedence over Node --env-file. No public publication from this host.
    env: { ...process.env, ...deliveryEnv, PRIVATE_LIVE_DELIVERY_READ_TOKEN: "", LIVE_EXECUTOR_PUBLISH_ENABLED: "false", LIVE_EXECUTOR_PUBLICATION_AUTHORIZED: "false" }, signal,
    ...recorder,
    health: async ({ startedAt }) => {
      const start = Date.parse(startedAt), now = Date.now();
      const status = await store.read("live/daemon-status.json");
      const heartbeat = Date.parse(status?.heartbeatAt);
      if (!Number.isFinite(heartbeat) || heartbeat < start) return now - start <= 120_000;
      // The collection itself can legitimately occupy the complete five-minute window.
      return now - heartbeat <= 420_000;
    },
  });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const stateDir = process.argv.find((arg) => arg.startsWith("--state-dir="))?.slice(12);
  const controller = new AbortController();
  process.on("SIGINT", () => controller.abort()); process.on("SIGTERM", () => controller.abort());
  await startManagedHost({ stateDir, signal: controller.signal }).then((result) => {
    console.log(JSON.stringify({ event: "hostStopped", ...result }));
    if (result.status === "EXHAUSTED") process.exitCode = 1;
  }).catch((error) => { console.error(JSON.stringify({ event: "hostFailed", reason: reasonFor(error) })); process.exitCode = 1; });
}
