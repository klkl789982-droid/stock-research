import assert from "node:assert/strict";
import { test } from "node:test";
import { randomBytes } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import ts from "typescript";
import * as auth from "../lib/admin-auth.mjs";
import { isPublicResource } from "../lib/admin-route-policy.mjs";
import { memoryAuthStore, redisFixtureServer } from "./auth-test-support.mjs";
import { inspectDailyProductionDeployment } from "../lib/daily-production-deployment-verifier.mjs";

const password = "Synthetic-test-only-password!2026";
const hash = await auth.hashAdminPassword(password);
const env = { NODE_ENV: "development", TB_ADMIN_USERNAME: "fixture-admin", TB_ADMIN_PASSWORD_HASH: hash, TB_SESSION_SECRET: randomBytes(32).toString("base64url"), TB_AUTH_ORIGIN: "http://127.0.0.1:3000", TB_AUTH_REDIS_URL: "http://127.0.0.1:9999", TB_AUTH_REDIS_TOKEN: "fixture-only", TB_AUTOMATION_READ_TOKEN: randomBytes(32).toString("base64url") };
const config = auth.authConfig(env);
const req = (path, init) => new Request(`http://127.0.0.1:3000${path}`, init);
test("scrypt hash, wrong ID/password, rotation, expiration, tamper and server logout revocation", async () => {
  assert.match(hash, /^scrypt\$131072\$8\$1\$/u);
  let clock = Date.now(); const store = memoryAuthStore(() => clock), service = auth.createAdminAuth(config, store, () => clock);
  const unknown = await service.login("unknown", password, "one"); const wrong = await service.login(env.TB_ADMIN_USERNAME, "wrong", "two");
  assert.deepEqual(unknown, wrong); assert.equal(wrong.status, 401);
  const first = await service.login(env.TB_ADMIN_USERNAME, password, "three");
  assert.equal((await service.verify(first.token)).role, "admin");
  assert.equal(await service.verify(`${first.token}tampered`), null);
  const next = await service.login(env.TB_ADMIN_USERNAME, password, "four", first.token);
  assert.notEqual(next.token, first.token); assert.equal(await service.verify(first.token), null);
  const changed = auth.createAdminAuth(auth.authConfig({ ...env, TB_ADMIN_USERNAME: "changed" }), store, () => clock);
  assert.equal(await changed.verify(next.token), null);
  await service.logout(next.token); assert.equal(await service.verify(next.token), null);
  const expired = await service.login(env.TB_ADMIN_USERNAME, password, "five");
  clock += auth.SESSION_SECONDS * 1000; assert.equal(await service.verify(expired.token), null);
});
test("login limits apply before hashing and cannot be bypassed by a claimed forwarded IP", async () => {
  const store = memoryAuthStore(), service = auth.createAdminAuth(config, store);
  for (let i = 0; i < 5; i++) assert.equal((await service.login("no", "wrong", "same")).status, 401);
  assert.equal((await service.login(env.TB_ADMIN_USERNAME, password, "same")).status, 429);
  assert.equal(auth.loginIdentity(req("/", { headers: { "x-forwarded-for": "spoof" } }), env), "local");
});
test("cookie policy, configured-origin CSRF, Production missing configuration fails closed", async () => {
  assert.match(auth.sessionCookie("fixture", { NODE_ENV: "production" }), /^__Host-tb-session=/);
  for (const attribute of ["Path=/", "Secure", "HttpOnly", "SameSite=Lax", "Max-Age=28800"]) assert.ok(auth.sessionCookie("fixture", { NODE_ENV: "production" }).includes(attribute));
  assert.equal(auth.sameOriginMutation(req("/api/auth/login", { method: "POST", headers: { Origin: env.TB_AUTH_ORIGIN } }), config), true);
  for (const origin of ["https://attacker.test", "null", ""]) assert.equal(auth.sameOriginMutation(req("/", { headers: { Origin: origin } }), config), false);
  assert.equal(auth.sameOriginMutation(req("/", { headers: { Origin: env.TB_AUTH_ORIGIN, "Sec-Fetch-Site": "cross-site" } }), config), false);
  assert.throws(() => auth.authConfig({ ...env, NODE_ENV: "production" }), /AUTH_UNAVAILABLE/);
  for (const key of ["TB_ADMIN_USERNAME", "TB_ADMIN_PASSWORD_HASH", "TB_SESSION_SECRET", "TB_AUTH_ORIGIN", "TB_AUTH_REDIS_URL", "TB_AUTH_REDIS_TOKEN"]) assert.throws(() => auth.authConfig({ ...env, [key]: "" }), /AUTH_UNAVAILABLE/);
  assert.deepEqual(await auth.authenticateRequest(req("/"), {}), { session: null, unavailable: true });
});
test("durable Redis adapter actual HTTP: create/read/delete, atomic shared limits, outage sanitization", async () => {
  const fixture = await redisFixtureServer("fixture-token");
  try {
    const c = { ...config, redisUrl: fixture.url, redisToken: "fixture-token" }, store = auth.createRedisAuthStore(c);
    await store.create("test", { role: "admin" }, 60); assert.deepEqual(await store.read("test"), { role: "admin" });
    await assert.rejects(store.create("test", {}, 60), /AUTH_UNAVAILABLE/); await store.remove("test"); assert.equal(await store.read("test"), null);
    for (let i = 0; i < 5; i++) assert.equal(await store.takeAttempt("same"), true);
    assert.equal(await auth.createRedisAuthStore(c).takeAttempt("same"), false);
    fixture.reset(); for (let i = 0; i < 30; i++) assert.equal(await store.takeAttempt(`source-${i}`), true); assert.equal(await store.takeAttempt("another"), false);
    await assert.rejects(auth.createRedisAuthStore({ ...c, redisToken: "incorrect" }).read("test"), /AUTH_UNAVAILABLE/);
    await assert.rejects(auth.createRedisAuthStore(c, async () => { throw new Error("sensitive-url-token"); }).read("test"), error => error.message === "AUTH_UNAVAILABLE");
  } finally { await fixture.close(); }
});
test("all existing data APIs use a server-only boundary; no broad static/RSC/image bypass", async () => {
  async function walk(directory) { const files = []; for (const e of await readdir(directory, { withFileTypes: true })) { const path = `${directory}/${e.name}`; files.push(...(e.isDirectory() ? await walk(path) : e.name === "route.ts" ? [path] : [])); } return files; }
  const files = (await walk("app/api")).filter(file => !file.startsWith("app/api/auth/"));
  assert.equal(files.length, 17);
  for (const file of files) assert.match(await readFile(file, "utf8"), /export const GET = withAdminAccess\(handleGet\);/u, file);
  for (const path of ["/", "/?view=models", "/data/history/test.json", "/.env", "/file.svg", "/_next/data/build/index.json", "/_next/static/chunks/test.map", "/_next/image?url=%2Fapi%2Fprice", "/api/top-stocks"]) assert.equal(isPublicResource(new URL(path, config.origin)), false, path);
  for (const path of ["/login", "/tb-mark-v3.png", "/tb-material-bg-v2.png", "/_next/static/chunks/app.js", "/_next/image?url=%2Ftb-mark-v3.png"]) assert.equal(isPublicResource(new URL(path, config.origin)), true, path);
  assert.deepEqual((await readdir("public")).filter(file => /\.(json|csv|parquet|db|sqlite)$/u.test(file)), []);
});
test("machine token scope and redacted publication response, never private KIS or ranking access", async () => {
  const headers = { Authorization: `Bearer ${env.TB_AUTOMATION_READ_TOKEN}` };
  for (const path of ["/api/top-stocks", "/api/model-performance", "/api/daily-production-status"]) assert.equal(auth.isAutomationRequest(req(path, { headers }), env), true);
  for (const path of ["/", "/api/model-performance/research", "/api/stock", "/api/kis-eod-top-stocks", "/api/intraday-model-top"]) assert.equal(auth.isAutomationRequest(req(path, { headers }), env), false);
  assert.equal(auth.isAutomationRequest(req("/api/top-stocks", { method: "POST", headers }), env), false);
  assert.equal(auth.isAutomationRequest(req("/api/top-stocks", { headers: { Authorization: "Bearer wrong" } }), env), false);
  assert.deepEqual(auth.automationPublicationDto("/api/top-stocks", { rankingAsOfDate: "2026-10-07", stocks: [{ price: 123 }], freshness: { freshnessStatus: "fresh", secret: "hidden" } }), { rankingAsOfDate: "2026-10-07", freshness: { freshnessStatus: "fresh" } });
  let calls = 0;
  const response = await inspectDailyProductionDeployment({ siteUrl: "https://site.test", expectedReferenceDate: "2026-10-07", automationToken: env.TB_AUTOMATION_READ_TOKEN, fetchImpl: async (url, options) => {
    assert.equal(options.headers.Authorization, headers.Authorization); assert.equal(options.redirect, "error"); calls++;
    return Response.json(url.includes("top-stocks") ? { rankingAsOfDate: "2026-10-07", freshness: { freshnessStatus: "fresh" } } : url.includes("model-performance") ? { latestEodReferenceDate: "2026-10-07" } : { siteApiReferenceDate: "2026-10-07", publicationStatus: "published" });
  } }); assert.equal(calls, 3); assert.equal(response.matches, true);
});
test("actual data boundary wrapper denies before handler, even if Proxy was skipped", async () => {
  const source = await readFile("lib/admin-access.ts", "utf8"), compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  let session = null, unavailable = false;
  const exports = {};
  new Function("require", "exports", compiled)(name => {
    if (name === "server-only") return {};
    if (name === "./admin-auth.mjs") return { ...auth, authenticateRequest: async () => ({ session, unavailable }), isAutomationRequest: request => auth.isAutomationRequest(request, env) };
    throw new Error(name);
  }, exports);
  let calls = 0; const handler = exports.withAdminAccess(async () => { calls++; return Response.json({ rankingAsOfDate: "2026-10-07", stocks: ["private"] }); });
  assert.equal((await handler(req("/api/top-stocks"))).status, 401); assert.equal(calls, 0);
  unavailable = true; assert.equal((await handler(req("/api/top-stocks"))).status, 503); assert.equal(calls, 0);
  unavailable = false; session = { role: "admin" }; assert.equal((await handler(req("/api/top-stocks"))).status, 200);
  session = null; const machine = await handler(req("/api/top-stocks", { headers: { Authorization: `Bearer ${env.TB_AUTOMATION_READ_TOKEN}` } })); assert.equal((await machine.json()).stocks, undefined);
});
