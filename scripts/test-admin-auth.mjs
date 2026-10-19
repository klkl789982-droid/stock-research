import assert from "node:assert/strict";
import { test } from "node:test";
import { randomBytes, scryptSync } from "node:crypto";
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
test("new password policy: 8+ characters, English letter and digit, optional special characters", async () => {
  for (const value of ["Abcdef12", "Abcdef1!", "a1234567", "ABCDEFG1", "a1가나다라마바사"]) assert.equal(auth.isValidNewAdminPassword(value), true);
  for (const value of ["Abcdef1", "abcdefgh", "12345678", "가나다라마바사1", "a1😀😀😀", "", null, 12345678, "a1" + "가".repeat(341)]) {
    assert.equal(auth.isValidNewAdminPassword(value), false);
    await assert.rejects(auth.hashAdminPassword(value), error => error.message === auth.ADMIN_PASSWORD_POLICY_MESSAGE);
  }
  assert.equal(auth.isValidNewAdminPassword("a" + "1".repeat(1023)), true);
  const shortHash = await auth.hashAdminPassword("Abcdef12");
  assert.match(shortHash, /^scrypt\$131072\$8\$1\$[a-f0-9]{32}\$[a-f0-9]{64}$/u);
  const shortConfig = auth.authConfig({ ...env, TB_ADMIN_PASSWORD_HASH: shortHash });
  const service = auth.createAdminAuth(shortConfig, memoryAuthStore());
  const result = await service.login(env.TB_ADMIN_USERNAME, "Abcdef12", "policy-fixture");
  assert.equal(result.status, 200);
  assert.equal((await service.verify(result.token)).role, "admin");
  await service.logout(result.token);
  assert.equal(await service.verify(result.token), null);
  const script = await readFile("scripts/hash-admin-password.mjs", "utf8");
  assert.match(script, /ADMIN_PASSWORD_POLICY_MESSAGE/u);
  assert.ok(!script.includes("16+"));
});
test("existing administrator hashes remain usable without credential or session rotation", async () => {
  const legacyPassword = "LegacyOnlyLetters"; // Synthetic old-policy password; never an existing user's credential.
  assert.equal(auth.isValidNewAdminPassword(legacyPassword), false);
  const salt = "a".repeat(32);
  const key = scryptSync(legacyPassword, salt, 32, { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 });
  const legacyHash = `scrypt$131072$8$1$${salt}$${key.toString("hex")}`;
  const legacyEnv = { ...env, TB_ADMIN_PASSWORD_HASH: legacyHash };
  const legacyConfig = auth.authConfig(legacyEnv), store = memoryAuthStore();
  const result = await auth.createAdminAuth(legacyConfig, store).login(env.TB_ADMIN_USERNAME, legacyPassword, "legacy-fixture");
  assert.equal(result.status, 200);
  assert.equal((await auth.createAdminAuth(auth.authConfig(legacyEnv), store).verify(result.token)).role, "admin");
  assert.equal(legacyEnv.TB_ADMIN_PASSWORD_HASH, legacyHash);
});
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
  // Keep an exact inventory, including the two existing private LIVE readers.
  // A stale count17 prevented their boundary assertions from running at all.
  assert.deepEqual(files.sort(), ["backtests/rank", "company-analysis", "daily-production-status", "financial", "home-dashboard",
    "intraday-market-analysis", "intraday-model-top", "investor", "kis-eod-top-stocks", "market-analysis", "model-performance",
    "model-performance/research", "price", "private-live", "private-live-delivery", "realtime", "screener", "stock", "top-stocks"]
    .map(name => `app/api/${name}/route.ts`).sort());
  for (const file of files) {
    const source = ts.createSourceFile(file, await readFile(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const exportedGet = source.statements.filter(statement => ts.isVariableStatement(statement)
      && statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword))
      .flatMap(statement => [...statement.declarationList.declarations]).filter(declaration => declaration.name.getText(source) === "GET");
    assert.equal(exportedGet.length, 1, file);
    const call = exportedGet[0].initializer;
    // Both handleGet and the existing inline arrow handler must remain INSIDE
    // the same server guard; formatting or handler style is not authorization.
    assert.ok(call && ts.isCallExpression(call) && ts.isIdentifier(call.expression) && call.expression.text === "withAdminAccess" && call.arguments.length === 1, file);
    assert.match(source.text, /import\s*\{\s*withAdminAccess\s*\}\s*from\s*["']@\/lib\/admin-access["']/u, file);
  }
  for (const path of ["/", "/?view=models", "/data/history/test.json", "/.env", "/file.svg", "/_next/data/build/index.json", "/_next/static/chunks/test.map", "/_next/image?url=%2Fapi%2Fprice", "/api/top-stocks"]) assert.equal(isPublicResource(new URL(path, config.origin)), false, path);
  for (const path of ["/login", "/tb-mark-v3.png", "/tb-material-bg-v2.png", "/_next/static/chunks/app.js", "/_next/image?url=%2Ftb-mark-v3.png"]) assert.equal(isPublicResource(new URL(path, config.origin)), true, path);
  assert.deepEqual((await readdir("public")).filter(file => /\.(json|csv|parquet|db|sqlite)$/u.test(file)), []);
});
test("machine token scope and redacted publication response, never private KIS or ranking access", async () => {
  const headers = { Authorization: `Bearer ${env.TB_AUTOMATION_READ_TOKEN}` };
  for (const path of ["/api/top-stocks", "/api/model-performance", "/api/daily-production-status", "/api/intraday-model-top", "/api/home-dashboard"]) assert.equal(auth.isAutomationRequest(req(path, { headers }), env), true);
  for (const path of ["/", "/api/model-performance/research", "/api/stock", "/api/kis-eod-top-stocks", "/api/private-live", "/api/private-live-delivery"]) assert.equal(auth.isAutomationRequest(req(path, { headers }), env), false);
  assert.deepEqual(auth.automationPublicationDto("/api/intraday-model-top", { signalDate: "2026-10-08", observationType: "LIVE_OBSERVATION", collectionCompletedAt: "2026-10-08T05:34:00Z", stocks: [{ observedPrice: 123 }], source: "private" }), { signalDate: "2026-10-08", observationType: "LIVE_OBSERVATION", collectionCompletedAt: "2026-10-08T05:34:00Z" });
  assert.equal(auth.isAutomationRequest(req("/api/top-stocks", { method: "POST", headers }), env), false);
  assert.equal(auth.isAutomationRequest(req("/api/top-stocks", { headers: { Authorization: "Bearer wrong" } }), env), false);
  assert.deepEqual(auth.automationPublicationDto("/api/top-stocks", { rankingAsOfDate: "2026-10-07", stocks: [{ price: 123 }], freshness: { freshnessStatus: "fresh", secret: "hidden" } }), { dataIdentity: null, publicationReady: false, rankingAsOfDate: "2026-10-07", freshness: { freshnessStatus: "fresh" } });
  let calls = 0;
  const dataIdentity = { referenceDate: "2026-10-07", snapshotHash: "a".repeat(64), commitSha: "b".repeat(40) };
  const response = await inspectDailyProductionDeployment({ expectedSnapshotHash: dataIdentity.snapshotHash, expectedCommitSha: dataIdentity.commitSha, siteUrl: "https://site.test", expectedReferenceDate: "2026-10-07", automationToken: env.TB_AUTOMATION_READ_TOKEN, fetchImpl: async (url, options) => {
    assert.equal(options.headers.Authorization, headers.Authorization); assert.equal(options.redirect, "error"); calls++;
    return Response.json({ dataIdentity, publicationReady: true, ...(url.includes("top-stocks") ? { rankingAsOfDate: "2026-10-07", freshness: { freshnessStatus: "fresh" } } : url.includes("model-performance") ? { latestEodReferenceDate: "2026-10-07" } : url.includes("home-dashboard") ? { referenceDate: "2026-10-07" } : { siteApiReferenceDate: "2026-10-07", publicationStatus: "published" }) });
  } }); assert.equal(calls, 4); assert.equal(response.matches, true);
  const dto = auth.automationPublicationDto("/api/home-dashboard", { dataIdentity, publicationReady: true, referenceDate: "2026-10-07", models: ["private"], records: ["private"], token: "private" });
  assert.deepEqual(Object.keys(dto).sort(), ["dataIdentity", "publicationReady", "referenceDate"]);
  assert.doesNotMatch(JSON.stringify(dto), /private/u);
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
