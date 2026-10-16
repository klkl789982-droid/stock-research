import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { superviseChild } from "./host.mjs";
import { buildWindowsTask } from "./windows-task.mjs";
import { spawn } from "node:child_process";
import { enforceParentLease } from "./parent-lease.mjs";

const task = { root: "C:\\Users\\operator\\Tight Budget", nodePath: "C:\\Program Files\\nodejs\\node.exe", powershellPath: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", stateDir: "C:\\Users\\operator\\AppData\\Local\\TightBudget\\live-executor", userSid: "S-1-5-21-123-456-789-1002", date: "2026-10-12" };

test("task has fixed KST daily prewarm, logon recovery, least privilege and hidden execution", () => {
  const definition = buildWindowsTask(task);
  assert.equal(Date.parse("2026-10-12T13:40:00+09:00"), Date.parse("2026-10-12T04:40:00Z"));
  for (const expected of ["2026-10-12T13:40:00+09:00", "<DaysInterval>1</DaysInterval>", "<LogonTrigger>", "<LogonType>InteractiveToken</LogonType>", "<RunLevel>LeastPrivilege</RunLevel>", "<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>", "<StartWhenAvailable>true</StartWhenAvailable>", "<WakeToRun>true</WakeToRun>", "<Count>3</Count>", "<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>", "-WindowStyle Hidden", "launch-hidden.ps1"]) assert.ok(definition.xml.includes(expected), expected);
  assert.equal(definition.publicationEnabled, false);
  assert.doesNotMatch(definition.xml, /ExecutionPolicy|GITHUB_TOKEN|KIS_APP|<Password>/u);
  assert.equal(buildWindowsTask({ ...task, root: task.root.toLowerCase(), stateDir: task.stateDir.toLowerCase() }).marker, definition.marker);
  assert.notEqual(buildWindowsTask({ ...task, stateDir: "C:\\private-other" }).marker, definition.marker);
});

test("task rejects source/public storage, relative paths and untrusted launch executables", () => {
  for (const stateDir of [task.root, `${task.root}\\state`, "C:\\public\\state", "C:\\", "relative"]) assert.throws(() => buildWindowsTask({ ...task, stateDir }), /TASK_/u);
  assert.throws(() => buildWindowsTask({ ...task, nodePath: "C:\\tools\\cmd.exe" }), /EXECUTABLE_INVALID/u);
  assert.throws(() => buildWindowsTask({ ...task, root: 'C:\\bad"path' }), /WINDOWS_PATH_REQUIRED/u);
});

test("actual child failure restarts a real process, then an explicit stop terminates it", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tb-host-restart-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const counter = path.join(directory, "launch-count");
  const controller = new AbortController(), statuses = [];
  const script = `const fs=require('node:fs'); const file=process.argv[1]; const n=Number(fs.existsSync(file)?fs.readFileSync(file,'utf8'):0)+1;fs.writeFileSync(file,String(n));if(n===1)process.exit(7);setInterval(()=>{},1000);`;
  const running = superviseChild({ command: process.execPath, args: ["-e", script, counter], cwd: directory, env: process.env, signal: controller.signal, restartDelayMs: 10, terminateGraceMs: 100,
    onStatus: async (status) => {
      statuses.push(status);
      if (status.status !== "RUNNING" || status.restartCount !== 1) return;
      // spawn is not application readiness; wait for the fixture's explicit receipt.
      for (let attempt = 0; attempt < 100; attempt++) {
        if (await readFile(counter, "utf8") === "2") { controller.abort(); return; }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      controller.abort(); throw new Error("TEST_CHILD_STARTUP_TIMEOUT");
    } });
  const result = await running;
  assert.equal(result.status, "STOPPED"); assert.equal(result.restartCount, 1);
  assert.equal(await readFile(counter, "utf8"), "2");
  assert.equal(statuses.filter((value) => value.status === "RUNNING").length, 2);
  assert.ok(statuses.some((value) => value.status === "RESTART_WAIT" && value.childExitCode === 7));
});

test("a permanently failing actual child exhausts a finite restart budget", async () => {
  const statuses = [];
  const result = await superviseChild({ command: process.execPath, args: ["-e", "process.exit(9)"], env: process.env, maxRestarts: 2, restartDelayMs: 1, onStatus: async (status) => { statuses.push(status); } });
  assert.equal(result.status, "EXHAUSTED"); assert.equal(result.restartCount, 2); assert.equal(result.childExitCode, 9);
  assert.equal(statuses.filter((value) => value.status === "STARTING").length, 3);
});

test("watchdog terminates an unresponsive actual child and records a safe code", async () => {
  const result = await superviseChild({ command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], env: process.env, maxRestarts: 0, healthIntervalMs: 100, terminateGraceMs: 100, health: async () => false });
  assert.equal(result.status, "EXHAUSTED"); assert.equal(result.reason, "HOST_HEARTBEAT_STALE");
});

test("standalone CLI is unaffected by the managed parent lifetime lease", () => {
  assert.equal(enforceParentLease({ channel: undefined }), false);
});

test("abrupt supervisor death terminates its real managed child by lease expiry", { timeout: 15000 }, async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tb-parent-lease-"));
  const ready = path.join(directory, "child-ready"), ended = path.join(directory, "child-ended");
  const moduleUrl = new URL("./parent-lease.mjs", import.meta.url).href;
  const childScript = `import {writeFileSync} from 'node:fs';import {enforceParentLease} from ${JSON.stringify(moduleUrl)};enforceParentLease(process,{timeoutMs:500});process.on('exit',()=>writeFileSync(${JSON.stringify(ended)},'stopped'));writeFileSync(${JSON.stringify(ready)},String(process.pid));setInterval(()=>{},1000);`;
  const parentScript = `const {spawn}=require('node:child_process');const child=spawn(process.execPath,['--input-type=module','-e',${JSON.stringify(childScript)}],{stdio:['ignore','ignore','ignore','ipc'],windowsHide:true});setInterval(()=>{if(child.connected)child.send({type:'HOST_LEASE'},()=>{});},100);`;
  const parent = spawn(process.execPath, ["-e", parentScript], { stdio: "ignore", windowsHide: true });
  let childPid;
  t.after(async () => {
    parent.kill("SIGKILL");
    if (childPid) { try { process.kill(childPid, "SIGKILL"); } catch {} }
    await rm(directory, { recursive: true, force: true });
  });
  const waitForFile = async (file) => {
    for (let n = 0; n < 100; n += 1) {
      try { return await readFile(file, "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("TEST_CHILD_LEASE_TIMEOUT");
  };
  childPid = Number(await waitForFile(ready));
  assert.ok(Number.isInteger(childPid) && childPid > 0);
  parent.kill("SIGKILL");
  // Windows may terminate a child without its JS exit handler being delivered.
  // Verify the operating-system process is gone, not a graceful-exit marker.
  let gone = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { process.kill(childPid, 0); } catch (error) { if (error.code !== "ESRCH") throw error; gone = true; break; }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(gone, true, "managed child must not survive its supervisor");
});
