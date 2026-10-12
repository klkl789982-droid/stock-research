import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { createLocalExecutionStore } from "./store.mjs";

async function sandbox(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "tb-live-store-"));
  t.after(async () => {
    assert.ok(directory.startsWith(`${path.resolve(os.tmpdir())}${path.sep}tb-live-store-`));
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { directory, store: createLocalExecutionStore(directory) };
}

test("private state requires an absolute path outside the repository and public roots", () => {
  assert.throws(() => createLocalExecutionStore("state"), { code: "LIVE_STORE_ABSOLUTE_DIRECTORY_REQUIRED" });
  assert.throws(() => createLocalExecutionStore(path.resolve("infra/live-executor/state")), { code: "LIVE_STORE_DIRECTORY_NOT_PRIVATE" });
  assert.throws(() => createLocalExecutionStore(path.join(os.tmpdir(), "public", "state")), { code: "LIVE_STORE_DIRECTORY_NOT_PRIVATE" });
});
test("create-only storage verifies canonical hashes, deduplicates and preserves conflicts", async (t) => {
  const { store } = await sandbox(t);
  const first = await store.writeImmutable("shadow/2026-10-12/signal.json", { b: 2, a: 1 });
  assert.match(first.hash, /^[a-f0-9]{64}$/u);
  assert.equal(first.disposition, "created");
  assert.deepEqual(await store.writeImmutable("shadow/2026-10-12/signal.json", { a: 1, b: 2 }), { hash: first.hash, disposition: "existing" });
  await assert.rejects(store.writeImmutable("shadow/2026-10-12/signal.json", { a: 2 }), { code: "LIVE_STORE_IMMUTABLE_CONFLICT" });
  await assert.rejects(store.writeMutable("shadow/2026-10-12/signal.json", {}), { code: "LIVE_STORE_IMMUTABLE_CONFLICT" });
  assert.deepEqual(await store.read("shadow/2026-10-12/signal.json"), { a: 1, b: 2 });
});
test("hash corruption fails closed and an interrupted temporary file cannot appear as data", async (t) => {
  const { store, directory } = await sandbox(t);
  await store.writeImmutable("shadow/checkpoint.json", { ticker: "005930", privateFixture: true });
  const file = path.join(directory, "shadow/checkpoint.json"), envelope = JSON.parse(await fs.readFile(file, "utf8"));
  envelope.value.ticker = "000660";
  await fs.writeFile(file, JSON.stringify(envelope));
  await assert.rejects(store.read("shadow/checkpoint.json"), { code: "LIVE_STORE_HASH_MISMATCH" });
  await fs.writeFile(path.join(directory, "shadow/next.json.interrupted.tmp"), '{"partial":');
  assert.equal(await store.read("shadow/next.json"), null);
});
test("LIVE and shadow namespaces never alias; path escapes and unhashable values fail", async (t) => {
  const { store } = await sandbox(t);
  await store.writeImmutable("shadow/signal.json", { fixture: true });
  assert.equal(await store.read("live/signal.json"), null);
  for (const key of ["../x.json", "live/../shadow/x.json", "live//x.json", "data/x.json", "live/x.txt"])
    await assert.rejects(store.read(key), { code: "LIVE_STORE_KEY_INVALID" });
  for (const value of [{ price: NaN }, { missing: undefined }, { date: new Date() }])
    await assert.rejects(store.writeImmutable("shadow/invalid.json", value), { code: "LIVE_STORE_JSON_INVALID" });
});
test("mutable operational pointers update atomically while immutable inputs remain intact", async (t) => {
  const { store } = await sandbox(t);
  await store.writeImmutable("live/2026-10-12/signal.json", { fixture: true });
  await store.writeMutable("live/latest.json", { status: "READY", lastGood: "live/2026-10-12/signal.json" });
  assert.equal((await store.writeMutable("live/latest.json", { status: "FAILED", lastGood: "live/2026-10-12/signal.json" })).disposition, "updated");
  assert.equal((await store.read("live/latest.json")).lastGood, "live/2026-10-12/signal.json");
  assert.deepEqual(await store.read("live/2026-10-12/signal.json"), { fixture: true });
  await assert.rejects(store.writeImmutable("live/latest.json", {}), { code: "LIVE_STORE_IMMUTABLE_CONFLICT" });
});
test("parallel immutable creates cannot replace the winner", async (t) => {
  const { store } = await sandbox(t);
  const results = await Promise.allSettled([store.writeImmutable("shadow/race.json", { attempt: 1 }), store.writeImmutable("shadow/race.json", { attempt: 2 })]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.find((result) => result.status === "rejected").reason.code, "LIVE_STORE_IMMUTABLE_CONFLICT");
  assert.ok([1, 2].includes((await store.read("shadow/race.json")).attempt));
});
test("concurrent mutable and immutable creates cannot overwrite the installed object", async (t) => {
  const { store } = await sandbox(t);
  const results = await Promise.allSettled([store.writeImmutable("shadow/create-race.json", { kind: "signal" }), store.writeMutable("shadow/create-race.json", { kind: "pointer" })]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.find((result) => result.status === "rejected").reason.code, "LIVE_STORE_IMMUTABLE_CONFLICT");
  assert.ok(["signal", "pointer"].includes((await store.read("shadow/create-race.json")).kind));
});
test("cross-process lock blocks an alive owner and safely recovers a terminated owner", async (t) => {
  const { store, directory } = await sandbox(t);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let entered;
  const active = new Promise((resolve) => { entered = resolve; });
  const first = store.withLock("same-run", async () => { entered(); await gate; });
  await active;
  await assert.rejects(store.withLock("same-run", async () => {}), { code: "LIVE_STORE_LOCKED" });
  release(); await first;
  assert.equal(await store.withLock("same-run", async () => "released"), "released");
  const child = spawn(process.execPath, ["-e", "process.stdout.write('ready');setInterval(()=>{},1000)"], { stdio: ["ignore", "pipe", "ignore"] });
  await once(child.stdout, "data");
  const pid = child.pid;
  await fs.writeFile(path.join(directory, ".locks", "interrupted.json"), JSON.stringify({ pid, nonce: randomUUID(), createdAt: new Date().toISOString() }));
  await assert.rejects(store.withLock("interrupted", async () => {}), { code: "LIVE_STORE_LOCKED" });
  child.kill(); await once(child, "exit");
  assert.equal(await store.withLock("interrupted", async () => "recovered"), "recovered");
});
test("invalid lock metadata is never reclaimed and callback errors release ownership", async (t) => {
  const { store, directory } = await sandbox(t);
  await assert.rejects(store.withLock("callback", async () => { throw new Error("fixture error"); }), /fixture error/u);
  assert.equal(await store.withLock("callback", async () => true), true);
  await fs.writeFile(path.join(directory, ".locks", "invalid.json"), '{"pid":');
  await assert.rejects(store.withLock("invalid", async () => {}), { code: "LIVE_STORE_LOCK_REQUIRES_REVIEW" });
  assert.equal(await fs.readFile(path.join(directory, ".locks", "invalid.json"), "utf8"), '{"pid":');
});
test("symlink state paths cannot redirect private writes", async (t) => {
  const { directory } = await sandbox(t);
  const real = path.join(directory, "real"), link = path.join(directory, "link");
  await fs.mkdir(real);
  try { await fs.symlink(real, link, process.platform === "win32" ? "junction" : "dir"); }
  catch (error) { if (error.code === "EPERM") { t.skip("OS does not permit fixture symlinks"); return; } throw error; }
  const store = createLocalExecutionStore(link);
  await assert.rejects(store.writeImmutable("shadow/test.json", {}), { code: "LIVE_STORE_SYMLINK_REJECTED" });
});
