import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { parseEnv } from "node:util";
import { hostConfiguration } from "./host.mjs";
import { createLocalExecutionStore } from "./store.mjs";
import { writerEnvironment } from "./writer-environment.mjs";
import { createKisSource } from "./kis-source.mjs";
import { canonicalContentHash } from "../../lib/canonical-content-hash.mjs";
import { clockKst } from "./engine.mjs";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const inside = (name, root) => name === root || name.startsWith(`${root}${path.sep}`);
const safeReason = error => /^[A-Z][A-Z0-9_]{2,95}$/u.test(error?.message ?? "") ? error.message : "SERVER_PREFLIGHT_FAILED";

async function readPrivateFile(filename, root) {
  if (!filename || !path.isAbsolute(filename) || inside(path.resolve(filename), path.resolve(root))) throw new Error("SERVER_SECRET_PATH_NOT_PRIVATE");
  const info = await fs.lstat(filename);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 65536) throw new Error("SERVER_SECRET_FILE_INVALID");
  if (process.platform !== "win32" && ((info.mode & 0o077) !== 0 || ![0, process.getuid()].includes(info.uid))) throw new Error("SERVER_SECRET_PERMISSIONS_INVALID");
  return fs.readFile(filename, "utf8");
}

export async function verifyServerStorage(stateDir) {
  const store = createLocalExecutionStore(stateDir), key = `shadow/server-preflight/${randomUUID()}.json`;
  const previous = await store.read("live/latest.json");
  const fixture = { type: "SYNTHETIC_SERVER_STORAGE_PREFLIGHT", id: randomUUID(), marketData: false };
  const created = await store.writeImmutable(key, fixture);
  const duplicate = await store.writeImmutable(key, fixture);
  let conflictBlocked = false, duplicateOwnerBlocked = false;
  try { await store.writeImmutable(key, { ...fixture, type: "SYNTHETIC_CONFLICT" }); }
  catch (error) { if (error.code !== "LIVE_STORE_IMMUTABLE_CONFLICT") throw error; conflictBlocked = true; }
  const reopened = createLocalExecutionStore(stateDir);
  if (canonicalContentHash(await reopened.read(key)) !== canonicalContentHash(fixture)) throw new Error("SERVER_STORAGE_READBACK_MISMATCH");
  await store.withLock("server-preflight", async () => {
    try { await reopened.withLock("server-preflight", async () => {}); }
    catch (error) { if (error.code !== "LIVE_STORE_LOCKED") throw error; duplicateOwnerBlocked = true; }
  });
  if (!conflictBlocked || !duplicateOwnerBlocked || created.hash !== duplicate.hash || duplicate.disposition !== "existing"
    || JSON.stringify(await reopened.read("live/latest.json")) !== JSON.stringify(previous)) throw new Error("SERVER_STORAGE_SAFETY_CHECK_FAILED");
  return { status: "VERIFIED", namespace: "shadow/server-preflight", envelopeHash: created.hash,
    createReadHashVerified: true, duplicateOwnerBlocked, conflictBlocked, operationalPointerChanged: false };
}

export async function inspectServer({ stateDir, root = repositoryRoot, env = process.env, storageCheck = false, networkCheck = false, calendarDate = null,
  platform = process.platform, nodeMajor = Number(process.versions.node.split(".")[0]), fetchImpl = fetch } = {}) {
  const checks = [], details = {};
  async function check(name, operation) {
    try { const result = await operation(); checks.push({ name, status: "PASS" }); return result; }
    catch (error) { checks.push({ name, status: "BLOCKED", reason: safeReason(error) }); return null; }
  }
  await check("alwaysOnLinuxRuntime", async () => {
    if (platform !== "linux") throw new Error("SERVER_LINUX_RUNTIME_REQUIRED");
    if (nodeMajor < 22) throw new Error("SERVER_NODE_VERSION_UNSUPPORTED");
    if (typeof process.getuid === "function" && process.getuid() === 0) throw new Error("SERVER_NON_ROOT_USER_REQUIRED");
  });
  await check("privatePersistentFilesystem", async () => {
    createLocalExecutionStore(stateDir, { repositoryRoot: root });
    const info = await fs.lstat(stateDir);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("SERVER_STATE_DIRECTORY_INVALID");
    if (process.platform !== "win32" && (info.mode & 0o077) !== 0) throw new Error("SERVER_STATE_PERMISSIONS_INVALID");
    const disk = await fs.statfs(stateDir);
    details.availableDiskBytes = Number(disk.bavail) * Number(disk.bsize);
    details.totalMemoryBytes = os.totalmem();
    // Operational headroom, not a change to any market-data quality rule.
    if (details.availableDiskBytes < 2 * 1024 ** 3) throw new Error("SERVER_DISK_HEADROOM_LOW");
  });
  const credentials = await check("externalKisSecretFile", async () => {
    const { envFile } = hostConfiguration(root, env);
    const parsed = parseEnv(await readPrivateFile(envFile, root));
    if (!parsed.KIS_APP_KEY || !parsed.KIS_APP_SECRET) throw new Error("KIS_CREDENTIALS_MISSING");
    if (Object.keys(parsed).some(key => !["KIS_APP_KEY", "KIS_APP_SECRET"].includes(key))) throw new Error("SERVER_KIS_SECRET_SCOPE_INVALID");
    return { appKey: parsed.KIS_APP_KEY, appSecret: parsed.KIS_APP_SECRET };
  });
  await check("externalWriterSecretFile", async () => {
    const filename = env.PRIVATE_LIVE_DELIVERY_WRITER_ENV_FILE;
    await readPrivateFile(filename, root);
    const writer = await writerEnvironment({ PRIVATE_LIVE_DELIVERY_WRITER_ENV_FILE: filename });
    if (writer.PRIVATE_LIVE_DELIVERY_SEND_ENABLED !== "true") throw new Error("SITE_RELAY_WRITER_NOT_CONFIGURED");
  });
  if (storageCheck) details.storage = await check("createOnlyStorageAndSingleOwner", () => verifyServerStorage(stateDir));
  if (networkCheck) await check("outboundTls443And9443", async () => {
    for (const url of ["https://api.github.com/rate_limit", "https://openapi.koreainvestment.com:9443/"]) {
      const response = await fetchImpl(url, { method: "HEAD", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(10000) });
      await response.body?.cancel();
      // Root 404/401 proves TLS reachability only, never API authentication.
      if (response.status < 100 || response.status >= 600) throw new Error("SERVER_TLS_RESPONSE_INVALID");
    }
  });
  if (calendarDate) await check("actualKisAuthenticationAndCalendar", async () => {
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(calendarDate) || !credentials) throw new Error("SERVER_KIS_PREFLIGHT_ARGUMENT_INVALID");
    const source = createKisSource({ credentials, fetchImpl });
    const calendar = await source.calendar(calendarDate);
    if (typeof calendar.isTradingDay !== "boolean") throw new Error("TRADING_CALENDAR_UNAVAILABLE");
    details.calendar = { date: calendarDate, isTradingDay: calendar.isTradingDay, requests: source.getMetrics().requests };
  });
  return { status: checks.every(row => row.status === "PASS") ? "CONFIGURATION_READY" : "BLOCKED", checks, ...details,
    storageChecked: storageCheck, networkChecked: networkCheck, kisAuthenticationChecked: Boolean(calendarDate),
    productionActivated: false, pcOffOperationVerified: false, realObservationCreated: false };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.some(arg => !/^--state-dir=.+$/u.test(arg) && !/^--kis-calendar=(?:\d{4}-\d{2}-\d{2}|today)$/u.test(arg) && !["--storage-check", "--network-check"].includes(arg))
      || new Set(args.map(arg => arg.split("=")[0])).size !== args.length) throw new Error("SERVER_PREFLIGHT_ARGUMENT_INVALID");
    const calendar = args.find(arg => arg.startsWith("--kis-calendar="))?.slice(15);
    const result = await inspectServer({ stateDir: args.find(arg => arg.startsWith("--state-dir="))?.slice(12),
      calendarDate: calendar === "today" ? clockKst(Date.now()).date : calendar, storageCheck: args.includes("--storage-check"), networkCheck: args.includes("--network-check") });
    console.log(JSON.stringify(result)); if (result.status !== "CONFIGURATION_READY") process.exitCode = 1;
  } catch (error) { console.error(JSON.stringify({ status: "BLOCKED", reason: safeReason(error), productionActivated: false })); process.exitCode = 1; }
}
