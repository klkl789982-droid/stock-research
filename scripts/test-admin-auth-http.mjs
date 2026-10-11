// Actual Next.js + HTTP test; ephemeral synthetic secrets, isolated build/store.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { hashAdminPassword } from "../lib/admin-auth.mjs";
import { redisFixtureServer } from "./auth-test-support.mjs";

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const portServer = http.createServer(); await new Promise(resolve => portServer.listen(0, "127.0.0.1", resolve));
const port = portServer.address().port; await new Promise(resolve => portServer.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const password = "Local-auth-test-only!2026", username = "local-test-admin"; // Never real administrator credentials.
const token = randomBytes(32).toString("base64url"), fixture = await redisFixtureServer(token);
const machine = randomBytes(32).toString("base64url");
const env = { ...process.env, NODE_ENV: "development", TB_AUTH_TEST_BUILD: "1", TB_ADMIN_USERNAME: username, TB_ADMIN_PASSWORD_HASH: await hashAdminPassword(password), TB_SESSION_SECRET: randomBytes(32).toString("base64url"), TB_AUTH_ORIGIN: origin, TB_AUTH_REDIS_URL: fixture.url, TB_AUTH_REDIS_TOKEN: token, TB_AUTOMATION_READ_TOKEN: machine };
// Next.js may update its tsconfig. Keep that generated state out of the repository's config.
await writeFile("tsconfig.auth-test.json", JSON.stringify({ extends: "./tsconfig.json", include: ["next-env.d.ts", "**/*.ts", "**/*.tsx", "**/*.mts"], exclude: ["node_modules"] }));
const child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "-p", String(port), "-H", "127.0.0.1"], { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
let exited = false, startupFailed = false;
child.on("exit", () => { exited = true; });
// Do not forward runtime output/environment/cookies. Report sanitized codes only.
child.stdout.on("data", () => {}); child.stderr.on("data", chunk => { if (chunk.toString().includes("Unable to acquire lock")) startupFailed = true; });
const request = (path, init = {}) => fetch(`${origin}${path}`, { ...init, redirect: "manual" });
const login = (values) => request("/api/auth/login", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(values) });
async function cleanup() { child.kill(); for (let i = 0; i < 50 && !exited; i++) await wait(100); await fixture.close(); }
try {
  let ready = false;
  for (let i = 0; i < 120 && !exited; i++) { try { ready = (await request("/login")).ok; if (ready) break; } catch {} await wait(500); }
  assert.ok(ready && !startupFailed, "isolated Next.js server must start");
  for (const path of ["/", "/?view=models", "/?stock=005930", "/?view=screener", "/data/history/2026-10-07.json", "/.env", "/_next/image?url=%2Fapi%2Fprice&w=64&q=75"]) { const r = await request(path); assert.equal(r.status, 307, path); assert.equal(new URL(r.headers.get("location"), origin).pathname, "/login"); }
  assert.equal((await request("/", { headers: { RSC: "1", "x-middleware-subrequest": "proxy:proxy:proxy:proxy:proxy" } })).status, 307);
  const apis = ["backtests/rank", "company-analysis", "daily-production-status", "financial", "home-dashboard", "intraday-market-analysis", "intraday-model-top", "investor", "kis-eod-top-stocks", "market-analysis", "model-performance", "model-performance/research", "price", "realtime", "screener", "stock", "top-stocks"];
  for (const api of apis) { const r = await request(`/api/${api}`); assert.equal(r.status, 401, api); assert.ok(r.headers.get("cache-control").includes("no-store")); }
  const csrf = await request("/api/auth/login", { method: "POST", headers: { Origin: "https://attacker.test", "Content-Type": "application/json" }, body: JSON.stringify({ username, password }) }); assert.equal(csrf.status, 403);
  assert.equal((await login({ username, password: "incorrect" })).status, 401);
  assert.equal((await login({ username: "nonexistent", password })).status, 401);
  const success = await login({ username, password }); assert.equal(success.status, 200);
  const cookie = success.headers.get("set-cookie").split(";")[0];
  assert.match(success.headers.get("set-cookie"), /HttpOnly/); assert.match(success.headers.get("set-cookie"), /SameSite=Lax/);
  const headers = { Cookie: cookie };
  assert.equal((await request("/api/auth/session", { headers })).status, 200);
  assert.equal((await request("/", { headers })).status, 200);
  assert.equal((await request("/api/model-performance", { headers })).status, 200);
  assert.equal((await request("/api/auth/session", { headers: { Cookie: `${cookie}tampered` } })).status, 401);
  const badLogout = await request("/api/auth/logout", { method: "POST", headers: { ...headers, Origin: "https://attacker.test" } }); assert.equal(badLogout.status, 403);
  const logout = await request("/api/auth/logout", { method: "POST", headers: { ...headers, Origin: origin } }); assert.equal(logout.status, 200); assert.match(logout.headers.get("set-cookie"), /Max-Age=0/);
  assert.equal((await request("/api/auth/session", { headers })).status, 401);
  assert.equal((await request("/", { headers })).status, 307);
  const machineResponse = await request("/api/model-performance", { headers: { Authorization: `Bearer ${machine}` } }); assert.equal(machineResponse.status, 200); assert.deepEqual(Object.keys(await machineResponse.json()), ["latestEodReferenceDate"]);
  assert.equal((await request("/api/screener", { headers: { Authorization: `Bearer ${machine}` } })).status, 401);
  for (let i = 0; i < 2; i++) assert.equal((await login({ username, password: "wrong" })).status, 401);
  assert.equal((await login({ username, password })).status, 429);
  console.log("HTTP security passed: 17 APIs, pages/static/RSC policy, login/errors/limit, cookie tamper, CSRF, real server revocation, scoped automation");
  if (process.argv.includes("--preview")) {
    fixture.reset();
    console.log(`AUTH_TEST_PREVIEW_URL=${origin}/login`);
    console.log("Synthetic UI fixture credentials: local-test-admin / Local-auth-test-only!2026 (not a real account)");
    await new Promise(resolve => { process.on("SIGINT", resolve); process.on("SIGTERM", resolve); });
  }
} finally { await cleanup(); }
