import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { hostConfiguration, supervisorRecorder } from "./host.mjs";
import { inspectServer, verifyServerStorage } from "./server-preflight.mjs";
import { createLocalExecutionStore } from "./store.mjs";

const execute = promisify(execFile);
async function sandbox(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "tb-server-migration-"));
  t.after(async () => {
    assert.ok(directory.startsWith(`${path.resolve(os.tmpdir())}${path.sep}tb-server-migration-`));
    await fs.rm(directory, { recursive: true, force: true });
  });
  return directory;
}

test("server uses an external Secret file and actual supervisor kind without changing Windows defaults", () => {
  const root = path.resolve("fixture-checkout"), envFile = path.join(os.tmpdir(), "private", "live.env");
  assert.equal(hostConfiguration(root, {}).envFile, path.join(root, ".env.local"));
  assert.deepEqual(hostConfiguration(root, { LIVE_EXECUTOR_ENV_FILE: envFile, LIVE_EXECUTOR_SUPERVISOR_KIND: "systemd" }), { envFile, scheduler: "systemd" });
  for (const bad of ["relative.env", `${envFile}\nprivate`, `${envFile}\0private`]) assert.throws(() => hostConfiguration(root, { LIVE_EXECUTOR_ENV_FILE: bad }), /HOST_ENV_FILE_INVALID/u);
  assert.throws(() => hostConfiguration(root, { LIVE_EXECUTOR_SUPERVISOR_KIND: "arbitrary" }), /HOST_SUPERVISOR_KIND_INVALID/u);
});

test("server journal records systemd rather than claiming a Windows task owns Linux", async t => {
  const store = createLocalExecutionStore(await sandbox(t));
  await supervisorRecorder(store, { scheduler: "systemd" }).onStatus({ status: "RUNNING", restartCount: 0 });
  assert.equal((await store.read("live/supervisor.json")).scheduler, "systemd");
});

test("server storage preflight is synthetic, create-only, single-owner and readable after process restart", async t => {
  const directory = await sandbox(t), store = createLocalExecutionStore(directory);
  const old = { signalDate: "2026-10-12", contentHash: "a".repeat(64), artifactKey: "live/archive/result.json" };
  await store.writeMutable("live/latest.json", old);
  const result = await verifyServerStorage(directory);
  assert.equal(result.status, "VERIFIED"); assert.equal(result.operationalPointerChanged, false);
  assert.equal(result.conflictBlocked, true); assert.equal(result.duplicateOwnerBlocked, true);
  const files = await fs.readdir(path.join(directory, "shadow/server-preflight"));
  assert.equal(files.length, 1);
  const moduleUrl = new URL("./store.mjs", import.meta.url).href;
  const script = `import {createLocalExecutionStore} from ${JSON.stringify(moduleUrl)};const s=createLocalExecutionStore(process.argv[1]);const v=await s.read(process.argv[2]);if(v.type!=="SYNTHETIC_SERVER_STORAGE_PREFLIGHT"||v.marketData!==false)process.exit(1);console.log("REOPENED_HASH_VERIFIED");`;
  const child = await execute(process.execPath, ["--input-type=module", "-e", script, directory, `shadow/server-preflight/${files[0]}`], { windowsHide: true });
  assert.match(child.stdout, /REOPENED_HASH_VERIFIED/u);
  assert.deepEqual(await store.read("live/latest.json"), old);
});

test("preflight never calls a supplier implicitly and never declares PC-off operation proven", async t => {
  const directory = await sandbox(t), envFile = path.join(directory, "live.env"), writerFile = path.join(directory, "writer.env");
  await fs.writeFile(envFile, "KIS_APP_KEY=synthetic_key\nKIS_APP_SECRET=synthetic_secret\n", { mode: 0o600 });
  await fs.writeFile(writerFile, "PRIVATE_LIVE_DELIVERY_WRITE_TOKEN=synthetic_writer\n", { mode: 0o600 });
  const result = await inspectServer({ stateDir: directory, root: path.join(directory, "checkout"), platform: "win32", env: {
    LIVE_EXECUTOR_ENV_FILE: envFile, PRIVATE_LIVE_DELIVERY_WRITER_ENV_FILE: writerFile,
  }, fetchImpl: async () => { throw new Error("UNEXPECTED_NETWORK"); } });
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.checks[0].reason, "SERVER_LINUX_RUNTIME_REQUIRED");
  assert.equal(result.productionActivated, false); assert.equal(result.pcOffOperationVerified, false);
  assert.equal(result.networkChecked, false); assert.equal(result.kisAuthenticationChecked, false);
  assert.doesNotMatch(JSON.stringify(result), /synthetic_key|synthetic_secret|synthetic_writer/u);
  assert.equal(result.checks.find(row => row.name === "externalKisSecretFile").status, "PASS");
  assert.equal(result.checks.find(row => row.name === "externalWriterSecretFile").status, "PASS");
});

test("Linux service stages disabled, keeps local state private, bounds restarts and kills all children", async () => {
  const read = filename => fs.readFile(new URL(filename, import.meta.url), "utf8");
  const unit = await read("./tight-budget-live.service.example");
  for (const fragment of ["ConditionPathExists=/etc/tight-budget/server-cutover-approved", "User=tightbudget", "Group=tightbudget", "LoadCredential=live.env:", "LoadCredential=writer.env:",
    "Environment=LIVE_EXECUTOR_ENV_FILE=%d/live.env", "Environment=PRIVATE_LIVE_DELIVERY_WRITER_ENV_FILE=%d/writer.env", "host.mjs --state-dir=/var/lib/tight-budget-live",
    "StateDirectoryMode=0700", "UMask=0077", "KillMode=control-group", "Restart=on-failure", "StartLimitBurst=5", "ProtectSystem=strict", "ReadWritePaths=/var/lib/tight-budget-live /opt/tight-budget/.git"]) assert.ok(unit.includes(fragment), fragment);
  assert.doesNotMatch(unit, /EnvironmentFile=|KIS_APP_KEY=|KIS_APP_SECRET=|WRITE_TOKEN=|0\.0\.0\.0|run\.mjs --mode=daemon/u);
  const timer = await read("./tight-budget-live-recovery.timer.example");
  assert.match(timer, /13:35:00 Asia\/Seoul/u); assert.match(timer, /13:58:00 Asia\/Seoul/u);
  assert.match(timer, /Persistent=false/u); assert.match(timer, /RandomizedDelaySec=0/u);
  const recovery = await read("./tight-budget-live-recovery.service.example");
  assert.match(recovery, /ConditionPathExists=.*server-cutover-approved/u);
  assert.match(recovery, /ExecStart=\/usr\/bin\/systemctl start tight-budget-live\.service/u);
  assert.doesNotMatch(recovery, /restart|reset-failed|rm /u);
  const preflight = await read("./tight-budget-live-preflight.service.example");
  assert.match(preflight, /LoadCredential=live.env:/u);
  assert.match(preflight, /--storage-check --network-check --kis-calendar=today/u);
  assert.match(preflight, /verify-writer\.mjs/u);
  assert.doesNotMatch(preflight, /--mode=live|--mode=daemon|host\.mjs|\[Install\]/u);
});
