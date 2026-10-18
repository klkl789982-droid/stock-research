import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { superviseChild, supervisorRecorder } from "./host.mjs";
import { createLocalExecutionStore } from "./store.mjs";
import { buildWindowsTask } from "./windows-task.mjs";
import { spawn } from "node:child_process";
import { enforceParentLease } from "./parent-lease.mjs";

const task = { root: "C:\\Users\\operator\\Tight Budget", nodePath: "C:\\Program Files\\nodejs\\node.exe", powershellPath: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", stateDir: "C:\\Users\\operator\\AppData\\Local\\TightBudget\\live-executor", userSid: "S-1-5-21-123-456-789-1002", date: "2026-10-12" };

test("task has fixed KST daily prewarm, logon recovery, least privilege and hidden execution", () => {
  const definition = buildWindowsTask(task);
  assert.equal(Date.parse("2026-10-12T13:40:00+09:00"), Date.parse("2026-10-12T04:40:00Z"));
  for (const expected of ["2026-10-12T13:40:00+09:00", "<DaysInterval>1</DaysInterval>", "<LogonTrigger>", "<LogonType>InteractiveToken</LogonType>", "<RunLevel>LeastPrivilege</RunLevel>", "<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>", "<StartWhenAvailable>true</StartWhenAvailable>", "<WakeToRun>true</WakeToRun>", "<Count>3</Count>", "<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>", "-WindowStyle Hidden", "launch-hidden.ps1"]) assert.ok(definition.xml.includes(expected), expected);
  assert.equal(definition.publicationEnabled, false);
  assert.ok(definition.xml.includes("<Priority>4</Priority>"), "normal CPU/I/O/memory priority, not a low-priority background task");
  assert.ok(definition.xml.includes("2026-10-12T13:59:00+09:00"), "a stopped host gets one final pre-observation recovery opportunity");
  assert.equal((definition.xml.match(/<CalendarTrigger>/gu) ?? []).length, 2);
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

test("restart evidence survives RUNNING updates and a fresh supervisor session", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tb-supervisor-journal-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = createLocalExecutionStore(directory);
  const first = supervisorRecorder(store, { sessionId: "synthetic-session-1" });
  await first.onStatus({ status: "RESTART_WAIT", restartCount: 1, reason: "HOST_HEARTBEAT_STALE", childExitCode: 1 });
  await first.onStatus({ status: "RUNNING", restartCount: 1, pid: 123 });
  assert.equal((await store.read("live/supervisor.json")).lastFailure.reason, "HOST_HEARTBEAT_STALE");
  await first.onDiagnostic({ event: "executorFailed", reason: "CLOCK_REFERENCE_UNAVAILABLE" });
  assert.equal((await store.read("live/supervisor.json")).status, "RUNNING");
  const original = await store.read("live/supervisor-events/synthetic-session-1/000001.json");
  await supervisorRecorder(store, { sessionId: "synthetic-session-2" }).onStatus({ status: "STARTING", restartCount: 0 });
  assert.deepEqual(await store.read("live/supervisor-events/synthetic-session-1/000001.json"), original);
});

test("real child fatal IPC reports the fixed reason only; extra sensitive fields never enter diagnostics", async () => {
  const diagnostics = [], marker = "synthetic-private-field-do-not-log";
  const script = `process.send({type:'EXECUTOR_DIAGNOSTIC',event:'executorError',reason:'MODEL_FORMULA_INTEGRITY_FAILED',password:${JSON.stringify(marker)}});setInterval(()=>{},1000);`;
  const result = await superviseChild({ command: process.execPath, args: ["-e", script], env: process.env, maxRestarts: 0,
    onDiagnostic: async value => { diagnostics.push(value); } });
  assert.equal(result.status, "EXHAUSTED");
  assert.equal(result.reason, "MODEL_FORMULA_INTEGRITY_FAILED");
  assert.equal(diagnostics.length, 1);
  assert.equal(JSON.stringify(diagnostics).includes(marker), false);
});

test("a supervisor event-loop stall produces an explicit parent-lease expiry, with bounded recovery", { timeout: 15000 }, async () => {
  const moduleUrl = new URL("./parent-lease.mjs", import.meta.url).href;
  const script = `import {enforceParentLease} from ${JSON.stringify(moduleUrl)};enforceParentLease();
    process.send({type:'EXECUTOR_DIAGNOSTIC',event:'executorFailed',reason:'FIXTURE_READY'});setInterval(()=>{},1000);`;
  const result = await superviseChild({ command: process.execPath, args: ["--input-type=module", "-e", script], env: process.env, maxRestarts: 0,
    onDiagnostic: async value => {
      if (value.reason === "FIXTURE_READY") {
        // The real child is independent. Stall only this isolated test parent,
        // not the operating task or the user's clock/processes.
        await new Promise(resolve => setTimeout(resolve, 1500));
        const until = Date.now() + 6500; while (Date.now() < until) { /* test CPU stall */ }
      }
    } });
  assert.equal(result.status, "EXHAUSTED"); assert.equal(result.reason, "PARENT_LEASE_EXPIRED");
});

test("watchdog terminates an unresponsive actual child and records a safe code", async () => {
  const result = await superviseChild({ command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], env: process.env, maxRestarts: 0, healthIntervalMs: 100, terminateGraceMs: 100, health: async () => false });
  assert.equal(result.status, "EXHAUSTED"); assert.equal(result.reason, "HOST_HEARTBEAT_STALE");
});

test("standalone CLI is unaffected by the managed parent lifetime lease", () => {
  assert.equal(enforceParentLease({ channel: undefined }), false);
});

test("a real busy child drains already-arrived parent leases before declaring its live parent lost", { timeout: 10000 }, async t => {
  const moduleUrl = new URL("./parent-lease.mjs", import.meta.url).href;
  const script = `import {enforceParentLease} from ${JSON.stringify(moduleUrl)};
    enforceParentLease(process,{timeoutMs:500});
    let began=false;
    process.on('message',m=>{if(m.type==='HOST_LEASE'&&!began){began=true;setTimeout(()=>{
      const until=Date.now()+800;while(Date.now()<until){};
      process.send({type:'WORK_FINISHED'});setTimeout(()=>process.exit(0),200);
    },100);}});`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true });
  const timer = setInterval(() => { if (child.connected) child.send({ type: "HOST_LEASE" }, () => {}); }, 50);
  t.after(() => { clearInterval(timer); child.kill("SIGKILL"); });
  const result = await new Promise(resolve => child.once("exit", code => resolve(code)));
  assert.equal(result, 0, "a responsive supervisor must not lose its child solely to synchronous event-loop work");
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
