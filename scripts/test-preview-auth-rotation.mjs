import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { preparePreviewRotation } from "./prepare-preview-auth-rotation.mjs";
import { authConfig, createAdminAuth } from "../lib/admin-auth.mjs";
import { memoryAuthStore } from "./auth-test-support.mjs";
const password = "Synthetic-preview-only-2026";
const folder = async () => mkdtemp(path.join(tmpdir(), "tb-preview-rotation-test-"));
const read = async dir => ({ TB_ADMIN_PASSWORD_HASH: await readFile(path.join(dir, "TB_ADMIN_PASSWORD_HASH.secret"), "utf8"),
  TB_SESSION_SECRET: await readFile(path.join(dir, "TB_SESSION_SECRET.secret"), "utf8") });
const config = values => authConfig({ ...values, TB_ADMIN_USERNAME: "synthetic-preview", TB_AUTH_ORIGIN: "https://preview.invalid",
  TB_AUTH_REDIS_URL: "https://redis.invalid", TB_AUTH_REDIS_TOKEN: "synthetic-no-network" });
test("new private values use the unchanged server scrypt/session contract and revoke old sessions", async () => {
  const one = await folder(), two = await folder();
  await preparePreviewRotation(one, password, password); await preparePreviewRotation(two, password, password);
  const a = await read(one), b = await read(two);
  assert.notEqual(a.TB_ADMIN_PASSWORD_HASH, b.TB_ADMIN_PASSWORD_HASH); assert.notEqual(a.TB_SESSION_SECRET, b.TB_SESSION_SECRET);
  const store = memoryAuthStore(), old = createAdminAuth(config(a), store), fresh = createAdminAuth(config(b), store);
  const session = await old.login("synthetic-preview", password, "fixture"); assert.equal(session.status, 200);
  assert.equal(await fresh.verify(session.token), null);
  assert.equal((await fresh.login("synthetic-preview", password, "fixture-new")).status, 200);
  const files = await readdir(one); assert.equal(files.length, 3);
  const meta = await readFile(path.join(one, "rotation-metadata.json"), "utf8");
  for (const value of [password, a.TB_ADMIN_PASSWORD_HASH, a.TB_SESSION_SECRET]) assert.equal(meta.includes(value), false);
});
test("confirmation/policy errors create no values and repeat generation never overwrites", async () => {
  const dir = await folder();
  await assert.rejects(preparePreviewRotation(dir, password, "wrong")); assert.deepEqual(await readdir(dir), []);
  await assert.rejects(preparePreviewRotation(dir, "short1", "short1")); assert.deepEqual(await readdir(dir), []);
  await preparePreviewRotation(dir, password, password); const old = await read(dir);
  await assert.rejects(preparePreviewRotation(dir, password, password)); assert.deepEqual(await read(dir), old);
  await assert.rejects(preparePreviewRotation(path.resolve("scripts"), password, password));
});
test("CLI never prints input/new values; safe status only, including errors", async () => {
  const run = async (directory, input) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["scripts/prepare-preview-auth-rotation.mjs", "--directory", directory], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = ""; child.stdout.on("data", x => out += x); child.stderr.on("data", x => err += x);
    child.on("error", reject); child.on("close", code => resolve({ code, out, err })); child.stdin.end(JSON.stringify(input));
  });
  const dir = await folder(), ok = await run(dir, { password, confirmation: password }); assert.equal(ok.code, 0);
  assert.equal(ok.out, "PREVIEW_ROTATION_READY\n"); assert.equal(ok.err, "");
  const values = await read(dir); for (const value of [password, ...Object.values(values)]) assert.equal((ok.out + ok.err).includes(value), false);
  const bad = await run(dir, { password, confirmation: "bad" }); assert.equal(bad.code, 1); assert.equal((bad.out + bad.err).includes(password), false);
  const other = path.join(await folder(), "empty"); await mkdir(other);
  assert.equal((await run(other, { password: "short", confirmation: "short" })).code, 1);
});
