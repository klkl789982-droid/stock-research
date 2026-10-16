// Real compiled Next route, synthetic admin/Redis, no external network permitted.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { authConfig, createAdminAuth, hashAdminPassword, sessionCookie } from "../lib/admin-auth.mjs";
import { redisFixtureServer } from "./auth-test-support.mjs";

const repository = fileURLToPath(new URL("../", import.meta.url));
const route = "api/private-live-delivery", relative = `.next/server/app/${route}/route.js`;
const traceFile = path.join(repository, `${relative}.nft.json`);
const trace = JSON.parse(await fs.readFile(traceFile, "utf8"));
const files = [relative, ...trace.files.map(name => path.relative(repository, path.resolve(path.dirname(traceFile), name)))];
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "tb-private-delivery-package-"));
let redis;
try {
  for (const name of files) {
    assert.ok(!path.isAbsolute(name) && !name.split(path.sep).includes(".."));
    assert.doesNotMatch(name.replaceAll("\\", "/"), /(?:^|\/)(?:data|\.runtime|\.env(?:\.|$))/);
    const target = path.join(temporary, name);
    await fs.mkdir(path.dirname(target), { recursive: true }); await fs.copyFile(path.join(repository, name), target);
  }
  const password = `Synthetic1-${randomBytes(12).toString("hex")}`, redisToken = randomBytes(32).toString("base64url");
  redis = await redisFixtureServer(redisToken);
  const env = { NODE_ENV: "development", TB_ADMIN_USERNAME: "delivery-test", TB_ADMIN_PASSWORD_HASH: await hashAdminPassword(password),
    TB_SESSION_SECRET: randomBytes(32).toString("base64url"), TB_AUTH_ORIGIN: "http://127.0.0.1", TB_AUTH_REDIS_URL: redis.url, TB_AUTH_REDIS_TOKEN: redisToken };
  const now = Date.now(), auth = createAdminAuth(authConfig(env), undefined, () => now);
  const login = await auth.login(env.TB_ADMIN_USERNAME, password, "delivery-test"); assert.equal(login.status, 200);
  const cookie = sessionCookie(login.token, env).split(";")[0];
  async function invoke(overrides = {}, suppliedCookie = cookie) {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(repository, "scripts/test-deployment-traces.mjs"), "--compiled-worker"], {
        cwd: temporary, env: { ...env, ...overrides, PATH: process.env.PATH }, windowsHide: true, stdio: ["ignore", "ignore", "pipe", "ipc"] });
      let output, errorText = "";
      const timer = setTimeout(() => child.kill(), 30000);
      child.stderr.on("data", chunk => { errorText = (errorText + chunk).slice(-2000); });
      child.on("message", result => { output = result; });
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("close", code => { clearTimeout(timer); if (code === 0 && output?.results) resolve(output.results); else reject(new Error(`PACKAGE_TEST_FAILED:${code}:${errorText}`)); });
      child.send({ root: temporary, route, requests: [{ authenticated: false }, {}], now, cookie: suppliedCookie, isolated: true });
    });
  }
  const disabled = await invoke(); assert.deepEqual(disabled.map(x => x.status), [401, 404]);
  const absent = await invoke({ PRIVATE_LIVE_DELIVERY_READ_ENABLED: "true" });
  assert.deepEqual(absent.map(x => x.status), [401, 503]);
  assert.equal(absent[1].body.error, "PRIVATE_LIVE_DELIVERY_UNAVAILABLE");
  assert.match(absent[1].cacheControl, /private.*no-store/);
  await auth.logout(login.token);
  assert.deepEqual((await invoke()).map(x => x.status), [401, 401]);
  console.log(`Private delivery compiled package: ${new Set(files).size} files, no data/env files; anonymous 401, disabled 404, missing config 503, logout 401 verified.`);
} finally {
  if (redis) await redis.close();
  assert.ok(path.resolve(temporary).startsWith(`${path.resolve(os.tmpdir())}${path.sep}tb-private-delivery-package-`));
  await fs.rm(temporary, { recursive: true, force: true });
}
