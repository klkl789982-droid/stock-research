// Run after npm run build. Real compiled handler/auth, isolated NFT-only package.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { authConfig, createAdminAuth, hashAdminPassword, sessionCookie } from "../lib/admin-auth.mjs";
import { redisFixtureServer } from "./auth-test-support.mjs";

const repository = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const route = "api/forecasts/swing";
const relative = `.next/server/app/${route}/route.js`;
const traceFile = path.join(repository, `${relative}.nft.json`);
const trace = JSON.parse(await fs.readFile(traceFile, "utf8"));
const inside = (root, file) => { const name = path.relative(root, file); return name !== ".." && !name.startsWith(`..${path.sep}`) && !path.isAbsolute(name); };
const allowedData = /^data\/(?:intraday-signals\/model-top\/(?:latest\.json|\d{4}-\d{2}-\d{2}\/1400\.json)|forecast-ledger\/swing-5d\/[a-f0-9]{64}\.json|forecast-outcomes\/swing-5d\/[a-f0-9]{64}\/[a-f0-9]{64}\.json)$/u;
const files = [...new Set([relative, ...trace.files.map(name => path.relative(repository, path.resolve(path.dirname(traceFile), name)).split(path.sep).join("/"))])];
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "swing-nft-"));
let fixture;
try {
  for (const name of files) {
    const source = path.resolve(repository, name);
    assert.ok(inside(repository, source) && inside(repository, await fs.realpath(source)), `Unpackaged path: ${name}`);
    assert.doesNotMatch(name, /(?:^|\/)\.env(?:\.|$)|(?:^|\/)\.runtime\//u);
    if (name.startsWith("data/")) assert.match(name, allowedData, "No unrelated market, private, legacy or seed data may be traced");
    const target = path.join(temporary, name); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.copyFile(source, target);
  }
  assert.ok(files.includes("data/intraday-signals/model-top/latest.json"));
  const dates = (await fs.readdir(path.join(repository, "data/intraday-signals/model-top"))).filter(name => /^\d{4}-\d{2}-\d{2}$/u.test(name));
  for (const date of dates) { const names = await fs.readdir(path.join(repository, "data/intraday-signals/model-top", date)); if (names.includes("1400.json")) assert.ok(files.includes(`data/intraday-signals/model-top/${date}/1400.json`)); }
  const token = randomBytes(32).toString("base64url"), password = `Synthetic1-${randomBytes(12).toString("hex")}`;
  fixture = await redisFixtureServer(token);
  const env = { NODE_ENV: "development", TB_ADMIN_USERNAME: "swing-package-fixture", TB_ADMIN_PASSWORD_HASH: await hashAdminPassword(password), TB_SESSION_SECRET: randomBytes(32).toString("base64url"), TB_AUTH_ORIGIN: "http://127.0.0.1", TB_AUTH_REDIS_URL: fixture.url, TB_AUTH_REDIS_TOKEN: token };
  const now = Date.now();
  const login = await createAdminAuth(authConfig(env), undefined, () => now).login(env.TB_ADMIN_USERNAME, password, "swing-package-fixture");
  assert.equal(login.status, 200);
  const cookie = sessionCookie(login.token, env).split(";")[0];
  async function request(root, requests, isolated) {
    return new Promise((resolve, reject) => {
      // Reuse the established compiled worker: it prohibits every network call
      // except the synthetic auth store and rejects reads outside the package.
      const child = spawn(process.execPath, [path.join(repository, "scripts/test-deployment-traces.mjs"), "--compiled-worker"], { cwd: root, env: { ...env, PATH: process.env.PATH }, stdio: ["ignore", "pipe", "pipe", "ipc"] });
      let result, diagnostic = "";
      child.stdout.on("data", () => {}); child.stderr.on("data", chunk => { diagnostic = (diagnostic + chunk).slice(-8000); });
      const timeout = setTimeout(() => child.kill(), 60000);
      child.once("error", error => { clearTimeout(timeout); reject(error); });
      child.on("message", message => { result = message; });
      child.once("close", code => { clearTimeout(timeout); if (code === 0 && result?.results) resolve(result.results); else reject(new Error(`Compiled swing handler failed ${code}: ${diagnostic}`)); });
      child.send({ root, route, requests, now, cookie, isolated });
    });
  }
  const calls = [{ authenticated: false }, { query: "?code=005930" }, { query: "?code=999999" }, { query: "?code=../invalid" }];
  const full = await request(repository, calls, false), packaged = await request(temporary, calls, true);
  assert.deepEqual(packaged, full, "NFT-only runtime must return the exact complete-checkout contract");
  assert.equal(packaged[0].status, 401); assert.equal(packaged[1].status, 200); assert.equal(packaged[3].status, 400);
  for (const result of packaged.slice(1, 3)) {
    assert.equal(result.body.status, "PREPARING"); assert.deepEqual(Object.values(result.body.prediction), [null, null, null]);
    assert.equal(result.body.readiness.eligibleForTraining, false); assert.match(result.cacheControl, /private.*no-store/u);
  }
  const pointerPath = path.join(temporary, "data/intraday-signals/model-top/latest.json");
  const pointer = JSON.parse(await fs.readFile(pointerPath, "utf8")); pointer.signalPath = "../../outside.json"; await fs.writeFile(pointerPath, JSON.stringify(pointer));
  const hostile = (await request(temporary, [{ query: "?code=005930" }], true))[0];
  assert.equal(hostile.body.observation.status, "UNAVAILABLE"); assert.equal(hostile.body.observation.referencePrice, null);
  await fs.rm(path.join(temporary, "data/intraday-signals/model-top"), { recursive: true });
  const absent = (await request(temporary, [{}], true))[0];
  assert.equal(absent.status, 200); assert.equal(absent.body.observation.independentDateCount, 0); assert.equal(absent.body.ledger.recordCount, 0);
  console.log(`Swing compiled package passed: ${files.length} bounded files, actual auth denial, complete-checkout parity, hostile/missing data, null-only preparation.`);
} finally { if (fixture) await fixture.close(); await fs.rm(temporary, { recursive: true, force: true }); }
