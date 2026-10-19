import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { superviseChild, supervisorRecorder, withManagedHostOwnership } from "./host.mjs";
import { createLocalExecutionStore } from "./store.mjs";
import { buildWindowsTask } from "./windows-task.mjs";
import { spawn } from "node:child_process";
import { enforceParentLease } from "./parent-lease.mjs";
import { EventEmitter } from "node:events";

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

test("a duplicate scheduled launch succeeds only for the verified live lock owner and never launches another collector", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tb-duplicate-host-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = createLocalExecutionStore(directory), at = Date.now(); let launches = 0;
  await store.writeMutable("live/supervisor.json", { status: "RUNNING", hostPid: process.pid, pid: process.pid, startedAt: new Date(at - 1000).toISOString() });
  await store.writeMutable("live/daemon-status.json", { heartbeatAt: new Date(at).toISOString(), apiAvailable: true });
  await store.withLock("host", async () => {
    const result = await withManagedHostOwnership(store, async () => { launches++; }, { now: () => at });
    assert.equal(result.status, "ALREADY_RUNNING"); assert.equal(result.existingHostPid, process.pid);
    assert.equal(result.observationCreated, false); assert.equal(launches, 0);
    const lock = JSON.parse(await readFile(path.join(directory, ".locks/host.json"), "utf8"));
    assert.equal(lock.pid, process.pid, "the original lock is not stolen/released");
    await assert.rejects(withManagedHostOwnership(store, () => { launches++; }, { now: () => at + 420001 }), /HEALTH_UNVERIFIED/u);
    await assert.rejects(withManagedHostOwnership(store, () => { launches++; }, { now: () => at, isAlive: () => false }), /HEALTH_UNVERIFIED/u);
  });
  assert.equal(launches, 0);
});

test("an unexplained lock, future heartbeat or different owner is not hidden as a successful duplicate", async () => {
  const at = Date.now(), prior = { status: "RUNNING", hostPid: 123, pid: 124, startedAt: new Date(at - 1000).toISOString() };
  for (const mutation of [v => { v.error.ownerPid = 456; }, v => { delete v.error.ownerPid; }, v => { v.daemon.heartbeatAt = new Date(at + 1).toISOString(); }, v => { v.daemon.apiAvailable = false; }]) {
    const data = { error: { code: "LIVE_STORE_LOCKED", ownerPid: 123 }, daemon: { heartbeatAt: new Date(at).toISOString(), apiAvailable: true } };
    mutation(data);
    const store = { async withLock() { throw data.error; }, async read(key) { return key.endsWith("supervisor.json") ? prior : data.daemon; } };
    await assert.rejects(withManagedHostOwnership(store, () => assert.fail("no duplicate launch"), { now: () => at, isAlive: () => true }), /HEALTH_UNVERIFIED/u);
  }
});

test("real child fatal IPC reports the fixed reason only; extra sensitive fields never enter diagnostics", async () => {
  const diagnostics = [], marker = "synthetic-private-field-do-not-log";
  const script = `process.send({type:'EXECUTOR_DIAGNOSTIC',event:'executorError',reason:'MODEL_FORMULA_INTEGRITY_FAILED',password:${JSON.stringify(marker)}});setInterval(()=>{},1000);`;
  const result = await superviseChild({ command: process.execPath, args: ["-e", script], env: process.env, maxRestarts: 0,
    onDiagnostic: async value => { diagnostics.push(value); } });
  assert.equal(result.status, "EXHAUSTED");
  assert.equal(result.reason, "MODEL_FORMULA_INTEGRITY_FAILED");
  assert.ok(Object.hasOwn(result, "childExitSignal"), "OS termination signal must not be lost when exit code is null");
  assert.equal(diagnostics.length, 1);
  assert.equal(JSON.stringify(diagnostics).includes(marker), false);
});

test("a supervisor event-loop stall produces an explicit parent-lease expiry, with bounded recovery", { timeout: 15000 }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tb-lease-stall-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const childReason = path.join(directory, "expiry-reason");
  const moduleUrl = new URL("./parent-lease.mjs", import.meta.url).href;
  const script = `import {writeFileSync} from 'node:fs';import {enforceParentLease} from ${JSON.stringify(moduleUrl)};
    const send=process.send.bind(process);process.send=(m,cb)=>{if(m.reason==='PARENT_LEASE_EXPIRED')writeFileSync(${JSON.stringify(childReason)},m.reason);return send(m,cb);};enforceParentLease();
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
  assert.equal(result.status, "EXHAUSTED");
  // An already-closed pipe may be observed before the queued child diagnostic.
  // The independent child's own evidence, not parent callback ordering, proves expiry.
  assert.ok(["PARENT_LEASE_EXPIRED", "HOST_LEASE_LOST"].includes(result.reason));
  assert.equal(await readFile(childReason, "utf8"), "PARENT_LEASE_EXPIRED");
});

test("watchdog terminates an unresponsive actual child and records a safe code", async () => {
  const result = await superviseChild({ command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], env: process.env, maxRestarts: 0, healthIntervalMs: 100, terminateGraceMs: 100, health: async () => false });
  assert.equal(result.status, "EXHAUSTED"); assert.equal(result.reason, "HOST_HEARTBEAT_STALE");
});

test("standalone CLI is unaffected by the managed parent lifetime lease", () => {
  assert.equal(enforceParentLease({ channel: undefined }), false);
});

test("an expired timer drains an already queued IPC lease before stopping a live child", t => {
  const timeouts = [], immediates = [], exits = [], messages = [];
  t.mock.method(globalThis, "setInterval", () => ({ unref() {} }));
  t.mock.method(globalThis, "setTimeout", fn => { const timer = { fn, unref() { return this; } }; timeouts.push(timer); return timer; });
  t.mock.method(globalThis, "clearTimeout", () => {});
  t.mock.method(globalThis, "setImmediate", fn => { immediates.push(fn); return { unref() {} }; });
  const runtime = Object.assign(new EventEmitter(), { channel: {}, connected: true,
    exit: code => exits.push(code), send: (value, callback) => { messages.push(value); callback(); } });
  enforceParentLease(runtime);
  // libuv can service the overdue timer before the IPC poll callback after a
  // busy child resumes. No sleep, live processes, credentials or clock changes.
  timeouts[0].fn();
  runtime.emit("message", { type: "HOST_LEASE", nonce: messages[0].nonce, sentAtMs: Date.now() });
  for (const fn of immediates) fn();
  assert.deepEqual(exits, []);
});

test("one poll-phase drain does not forgive an actually absent parent", t => {
  const timeouts = [], immediates = [], diagnostics = [], exits = [];
  t.mock.method(globalThis, "setInterval", () => ({ unref() {} }));
  t.mock.method(globalThis, "setTimeout", fn => { const timer = { fn, unref() { return this; } }; timeouts.push(timer); return timer; });
  t.mock.method(globalThis, "clearTimeout", () => {});
  t.mock.method(globalThis, "setImmediate", fn => { immediates.push(fn); return { unref() {} }; });
  const runtime = Object.assign(new EventEmitter(), { channel: {}, connected: true,
    exit: code => exits.push(code), send: (value, callback) => { diagnostics.push(value); callback(); } });
  enforceParentLease(runtime);
  timeouts[0].fn();
  for (const fn of immediates) fn();
  assert.equal(exits[0], 1);
  assert.equal(diagnostics.find(r => r.type === "EXECUTOR_DIAGNOSTIC").reason, "PARENT_LEASE_EXPIRED");
});

test("one millisecond of cross-process future wall time cannot reject a fresh monotonic challenge", t => {
  const messages = [], exits = []; let now = 0;
  t.mock.method(Date, "now", () => 1000);
  t.mock.method(globalThis, "setInterval", () => ({ unref() {} }));
  t.mock.method(globalThis, "setTimeout", () => ({ unref() {} }));
  t.mock.method(globalThis, "clearTimeout", () => {});
  const runtime = Object.assign(new EventEmitter(), { channel: {}, connected: true,
    exit: code => exits.push(code), send: (value, callback) => { messages.push(value); callback(); } });
  enforceParentLease(runtime, { monotonicNow: () => now });
  now = 1;
  runtime.emit("message", { type: "HOST_LEASE", nonce: messages[0].nonce, sentAtMs: 1001 });
  const receipt = messages.find(m => m.type === "EXECUTOR_LEASE_RECEIPT");
  assert.equal(receipt.wireAgeMs, -1); assert.equal(receipt.accepted, true); assert.equal(receipt.roundTripMs, 1);
  assert.equal(receipt.futureCount, 1); assert.deepEqual(exits, []);
});

test("expired, missing and consumed nonces cannot refresh a dead parent's lease", t => {
  const timeouts = [], immediates = [], exits = [], messages = []; let now = 0;
  t.mock.method(globalThis, "setInterval", () => ({ unref() {} }));
  t.mock.method(globalThis, "setTimeout", fn => { const timer = { fn, unref() { return this; } }; timeouts.push(timer); return timer; });
  t.mock.method(globalThis, "clearTimeout", () => {});
  t.mock.method(globalThis, "setImmediate", fn => { immediates.push(fn); return { unref() {} }; });
  const runtime = Object.assign(new EventEmitter(), { channel: {}, connected: true,
    exit: code => exits.push(code), send: (value, callback) => { messages.push(value); callback(); } });
  enforceParentLease(runtime, { monotonicNow: () => now });
  const nonce = messages[0].nonce; now = 6000;
  timeouts[0].fn();
  runtime.emit("message", { type: "HOST_LEASE", nonce, sentAtMs: Date.now() });
  runtime.emit("message", { type: "HOST_LEASE", nonce, sentAtMs: Date.now() });
  runtime.emit("message", { type: "HOST_LEASE", sentAtMs: Date.now() });
  for (const fn of immediates) fn();
  assert.equal(exits[0], 1);
  const receipts = messages.filter(r => r.type === "EXECUTOR_LEASE_RECEIPT");
  assert.ok(receipts.every(r => r.accepted === false)); assert.equal(receipts.at(-1).staleCount, 1); assert.equal(receipts.at(-1).nonceRejectedCount, 2);
});

test("a real busy child accepts only a still-fresh one-use reply after synchronous work", { timeout: 10000 }, async t => {
  const moduleUrl = new URL("./parent-lease.mjs", import.meta.url).href;
  const script = `import {enforceParentLease} from ${JSON.stringify(moduleUrl)};
    enforceParentLease(process,{timeoutMs:1200});
    let began=false;
    process.on('message',m=>{if(m.type==='HOST_LEASE'&&!began){began=true;setTimeout(()=>{
      const until=Date.now()+800;while(Date.now()<until){};
      process.send({type:'WORK_FINISHED'});setTimeout(()=>process.exit(0),200);
    },100);}});`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true });
  child.on("message", m => { if (m.type === "EXECUTOR_LEASE_CHALLENGE" && child.connected) child.send({ type: "HOST_LEASE", nonce: m.nonce, sentAtMs: Date.now() }, () => {}); });
  t.after(() => child.kill("SIGKILL"));
  const result = await new Promise(resolve => child.once("exit", code => resolve(code)));
  assert.equal(result, 0, "a responsive supervisor must not lose its child solely to synchronous event-loop work");
});

test("healthy real IPC survives the former future-clock failure condition for longer than the unchanged five-second deadline", { timeout: 12000 }, async () => {
  const moduleUrl = new URL("./parent-lease.mjs", import.meta.url).href;
  const script = `import {enforceParentLease} from ${JSON.stringify(moduleUrl)};
    const realNow=Date.now;Date.now=()=>realNow()-6000;enforceParentLease();
    setTimeout(()=>process.exit(0),6500);setInterval(()=>{},1000);`;
  const receipts = [];
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true });
  child.on("message", m => {
    if (m.type === "EXECUTOR_LEASE_CHALLENGE" && child.connected) child.send({ type: "HOST_LEASE", nonce: m.nonce, sentAtMs: Date.now() }, () => {});
    if (m.type === "EXECUTOR_LEASE_RECEIPT") receipts.push(m);
  });
  const code = await new Promise(resolve => child.once("exit", resolve));
  assert.equal(code, 0); assert.ok(receipts.length >= 6);
  assert.ok(receipts.every(r => r.accepted && r.roundTripMs < 5000));
  assert.ok(receipts.at(-1).futureCount >= 6, "the old wireAge<0 rule would reject every lease");
});

test("abrupt supervisor death terminates its real managed child by lease expiry", { timeout: 15000 }, async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tb-parent-lease-"));
  const ready = path.join(directory, "child-ready"), ended = path.join(directory, "child-ended");
  const moduleUrl = new URL("./parent-lease.mjs", import.meta.url).href;
  const childScript = `import {writeFileSync} from 'node:fs';import {enforceParentLease} from ${JSON.stringify(moduleUrl)};enforceParentLease(process,{timeoutMs:500});process.on('exit',()=>writeFileSync(${JSON.stringify(ended)},'stopped'));writeFileSync(${JSON.stringify(ready)},String(process.pid));setInterval(()=>{},1000);`;
  const parentScript = `const {spawn}=require('node:child_process');const child=spawn(process.execPath,['--input-type=module','-e',${JSON.stringify(childScript)}],{stdio:['ignore','ignore','ignore','ipc'],windowsHide:true});child.on('message',m=>{if(m.type==='EXECUTOR_LEASE_CHALLENGE'&&child.connected)child.send({type:'HOST_LEASE',nonce:m.nonce,sentAtMs:Date.now()},()=>{});});`;
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
