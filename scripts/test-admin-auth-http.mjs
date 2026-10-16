// Actual Next.js + HTTP test; ephemeral synthetic secrets, isolated build/store.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { hashAdminPassword } from "../lib/admin-auth.mjs";
import { redisFixtureServer } from "./auth-test-support.mjs";
import { inspectDailyProductionDeployment } from "../lib/daily-production-deployment-verifier.mjs";
import { createLiveTransitionStore } from "../lib/live-transition-store.mjs";
import { parseLiveTransitionFilters, screenLiveTransitions } from "../lib/live-transition-screener.mjs";
import { createLocalExecutionStore } from "../infra/live-executor/store.mjs";
import { privateApiToken } from "../infra/live-executor/private-token.mjs";
import { startPrivateApi } from "../infra/live-executor/api.mjs";
import { currentSignal } from "./fixtures/intraday-1400-outcomes.mjs";
import { recordTop5SwingBatch } from "../infra/live-executor/swing-records.mjs";

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const portServer = http.createServer(); await new Promise(resolve => portServer.listen(0, "127.0.0.1", resolve));
const port = portServer.address().port; await new Promise(resolve => portServer.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const password = "Abcdef12", username = "local-test-admin"; // Synthetic eight-character fixture, not real administrator credentials.
const token = randomBytes(32).toString("base64url"), fixture = await redisFixtureServer(token);
const machine = randomBytes(32).toString("base64url");
const deploySha = "a".repeat(40);
const privateRoot = await mkdtemp(path.join(os.tmpdir(), "tb-auth-private-live-"));
const privateStore = createLocalExecutionStore(privateRoot), privateToken = await privateApiToken(privateRoot);
const privateSignal = currentSignal(6);
const privateKey = `live/${privateSignal.signalDate}/${privateSignal.signalDate}/result.json`;
await privateStore.writeImmutable(privateKey, privateSignal);
await privateStore.writeMutable("live/latest.json", { signalDate: privateSignal.signalDate, artifactKey: privateKey, contentHash: privateSignal.contentHash });
await recordTop5SwingBatch({ stateDir: privateRoot, signal: privateSignal });
const privateApi = await startPrivateApi({ store: privateStore, mode: "live", token: privateToken });
const env = { ...process.env, VERCEL_GIT_COMMIT_SHA: deploySha, NODE_ENV: "development", TB_AUTH_TEST_BUILD: "1", TB_ADMIN_USERNAME: username, TB_ADMIN_PASSWORD_HASH: await hashAdminPassword(password), TB_SESSION_SECRET: randomBytes(32).toString("base64url"), TB_AUTH_ORIGIN: origin, TB_AUTH_REDIS_URL: fixture.url, TB_AUTH_REDIS_TOKEN: token, TB_AUTOMATION_READ_TOKEN: machine };
delete env.VERCEL;
Object.assign(env, { FORECAST_SWING_PRIVATE_ROOT: privateRoot, LIVE_EXECUTOR_LOCAL_READ_ENABLED: "true", LIVE_EXECUTOR_LOCAL_MODE: "live", LIVE_EXECUTOR_LOCAL_ORIGIN: privateApi.url, LIVE_EXECUTOR_LOCAL_TOKEN_FILE: path.join(privateRoot, "auth", "read-token") });
// Next.js may update its tsconfig. Keep that generated state out of the repository's config.
await writeFile("tsconfig.auth-test.json", JSON.stringify({ extends: "./tsconfig.json", include: ["next-env.d.ts", "**/*.ts", "**/*.tsx", "**/*.mts"], exclude: ["node_modules"] }));
const child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "-p", String(port), "-H", "127.0.0.1"], { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
let exited = false, startupFailed = false, exitCode = null, startupCode = "UNKNOWN";
child.on("exit", code => { exited = true; exitCode = code; });
// Do not forward runtime output/environment/cookies. Report sanitized codes only.
child.stdout.on("data", () => {}); child.stderr.on("data", chunk => {
  const text = chunk.toString();
  if (text.includes("Unable to acquire lock")) { startupFailed = true; startupCode = "BUILD_LOCK"; }
  else if (/reserved|bad port/iu.test(text)) startupCode = "RESERVED_PORT";
  else if (/EADDRINUSE/u.test(text)) startupCode = "PORT_IN_USE";
  else if (/EACCES|EPERM/u.test(text)) startupCode = "PERMISSION_DENIED";
  else if (/Cannot find module/u.test(text)) startupCode = "MISSING_DEPENDENCY";
});
const request = (path, init = {}) => fetch(`${origin}${path}`, { ...init, redirect: "manual" });
const login = (values) => request("/api/auth/login", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(values) });
async function cleanup() { child.kill(); for (let i = 0; i < 50 && !exited; i++) await wait(100); await fixture.close(); await privateApi.close(); await rm(privateRoot, { recursive: true, force: true }); }
try {
  let ready = false;
  for (let i = 0; i < 120 && !exited; i++) { try { ready = (await request("/login")).ok; if (ready) break; } catch {} await wait(500); }
  assert.ok(ready && !startupFailed, `isolated Next.js server must start (${startupCode}, exit ${exitCode})`);
  for (const path of ["/", "/forecasts", "/?view=models", "/?stock=005930", "/?view=screener", "/data/history/2026-10-07.json", "/.env", "/_next/image?url=%2Fapi%2Fprice&w=64&q=75"]) { const r = await request(path); assert.equal(r.status, 307, path); assert.equal(new URL(r.headers.get("location"), origin).pathname, "/login"); }
  assert.equal((await request("/", { headers: { RSC: "1", "x-middleware-subrequest": "proxy:proxy:proxy:proxy:proxy" } })).status, 307);
  const apis = ["backtests/rank", "company-analysis", "daily-production-status", "financial", "forecasts/swing", "home-dashboard", "intraday-market-analysis", "intraday-model-top", "investor", "kis-eod-top-stocks", "market-analysis", "model-performance", "model-performance/research", "price", "realtime", "screener", "stock", "top-stocks"];
  for (const api of apis) { const r = await request(`/api/${api}`); assert.equal(r.status, 401, api); assert.ok(r.headers.get("cache-control").includes("no-store")); }
  assert.equal((await request("/api/private-live")).status, 401);
  assert.equal((await request("/api/screener?tab=transition&rules=directional-v2&sort=evidence&trendEvidence=improving")).status, 401, "Research evidence never bypasses admin authentication");
  assert.equal((await request("/api/screener?tab=transition&mode=LIVE")).status, 401, "LIVE remains behind administrator authentication");
  const csrf = await request("/api/auth/login", { method: "POST", headers: { Origin: "https://attacker.test", "Content-Type": "application/json" }, body: JSON.stringify({ username, password }) }); assert.equal(csrf.status, 403);
  assert.equal((await login({ username, password: "incorrect" })).status, 401);
  assert.equal((await login({ username: "nonexistent", password })).status, 401);
  const success = await login({ username, password }); assert.equal(success.status, 200);
  const cookie = success.headers.get("set-cookie").split(";")[0];
  assert.match(success.headers.get("set-cookie"), /HttpOnly/); assert.match(success.headers.get("set-cookie"), /SameSite=Lax/);
  const headers = { Cookie: cookie };
  const privateResponse = await request("/api/private-live", { headers });
  assert.equal(privateResponse.status, 200);
  const privateView = await privateResponse.json();
  assert.equal(privateView.modelStatus, "AVAILABLE"); assert.equal(privateView.models.length, 4);
  assert.ok(privateView.models.every(model => model.contentHash === privateSignal.contentHash && model.officialSignalTime === "14:00:00"));
  assert.doesNotMatch(JSON.stringify(privateView), /"quote"|"price"|"volume"|read-token/u);
  assert.ok(!JSON.stringify(privateView).includes(privateToken));
  assert.equal((await request("/api/private-live", { headers: { Authorization: `Bearer ${machine}` } })).status, 401);
  console.log("PRIVATE LIVE HTTP integration passed: administrator session -> local token -> immutable fixture -> four model summaries, no raw prices or credentials");
  assert.equal((await request("/api/auth/session", { headers })).status, 200);
  const forecastResponse = await request("/api/forecasts/swing?code=000001", { headers });
  assert.equal(forecastResponse.status, 200);
  const forecast = await forecastResponse.json();
  assert.equal(forecast.status, "PREPARING");
  assert.equal(forecast.ledger.recordCount, 1);
  assert.equal(forecast.ledger.records[0].observedModels.length, 4);
  assert.ok(forecast.ledger.records[0].observedModels.every(model => model.rank === 1));
  assert.deepEqual(Object.values(forecast.prediction), [null, null, null]);
  assert.equal(forecast.readiness.eligibleForTraining, false);
  assert.equal(forecast.evaluation.costAdjustedReturnPercent, null);
  assert.ok(forecastResponse.headers.get("cache-control").includes("no-store"));
  const forecastPage = await request("/forecasts", { headers });
  assert.equal(forecastPage.status, 200);
  assert.match(await forecastPage.text(), /5거래일|스윙/u);
  assert.equal((await request("/api/forecasts/swing?code=../invalid", { headers })).status, 400);
  assert.equal((await request("/api/forecasts/swing", { method: "POST", headers: { ...headers, Origin: origin } })).status, 405);
  console.log("SWING HTTP integration passed: authenticated PREPARING page/API, null predictions, no-store, no write method");
  const homeResponse = await request("/", { headers });
  assert.equal(homeResponse.status, 200);
  const homeHtml = await homeResponse.text();
  assert.match(homeHtml, /전환 신호 · <!-- -->LIVE 장중 잠정|전환 신호 · LIVE 장중 잠정/u);
  assert.match(homeHtml, /aria-pressed="true"[^>]*>LIVE · 14:00 저장 관측/u);
  assert.equal((await request("/api/model-performance", { headers })).status, 200);
  const research = await request("/api/screener?tab=transition&rules=directional-v2&sort=evidence", { headers });
  assert.equal(research.status, 200); assert.equal((await research.json()).evidencePolicy.version, "transition-evidence-research-v1");
  const liveQuery = "tab=transition&mode=LIVE&pair=5-20&state=candidates&nearPercent=1";
  const liveResponse = await request(`/api/screener?${liveQuery}`, { headers });
  const liveBody = await liveResponse.json();
  let expectedLive, expectedFailure;
  try { expectedLive = await createLiveTransitionStore()(); } catch (error) { expectedFailure = error.message; }
  if (expectedLive) {
    assert.equal(liveResponse.status, 200);
    const screened = screenLiveTransitions(expectedLive.rows, parseLiveTransitionFilters(new URLSearchParams(liveQuery)));
    assert.deepEqual(liveBody.results, screened.results, "actual Next handler returns the validated saved LIVE dataset");
    assert.equal(liveBody.source.signalContentHash, expectedLive.source.signalContentHash);
    assert.equal(liveBody.modelReferenceDate, expectedLive.modelReferenceDate);
  } else {
    assert.equal(liveResponse.status, 503);
    assert.equal(liveBody.error.diagnostic, expectedFailure, "expired fixtures must remain unavailable in the real handler");
  }
  const homeLive = await Promise.all(["5-20", "20-60"].map(async (pair) => {
    const query = new URLSearchParams({ tab: "transition", mode: "LIVE", pair, state: "all", nearPercent: "1" });
    const response = await request(`/api/screener?${query}`, { headers });
    const body = await response.json();
    if (expectedLive) {
      assert.equal(response.status, 200);
      assert.deepEqual(body.results, screenLiveTransitions(expectedLive.rows, parseLiveTransitionFilters(query)).results);
      assert.equal(body.source.signalContentHash, expectedLive.source.signalContentHash);
      assert.equal(body.source.seedContentHash, expectedLive.source.seedContentHash);
      assert.equal(body.pair, pair);
    } else {
      assert.equal(response.status, 503);
      assert.equal(body.error.diagnostic, expectedFailure);
    }
    return body;
  }));
  if (expectedLive) assert.equal(homeLive[0].source.signalContentHash, homeLive[1].source.signalContentHash);
  console.log("HOME HTTP integration passed: actual default LIVE markup and both all-status pair requests");
  assert.ok(liveResponse.headers.get("cache-control").includes("private"));
  assert.ok(liveResponse.headers.get("cache-control").includes("no-store"));
  assert.equal((await request("/api/screener?tab=transition&mode=LIVE&nearPercent=6", { headers })).status, 400);
  console.log(`LIVE HTTP integration passed: authenticated ${liveResponse.status}, saved-source identity, errors, no-store`);
  assert.equal((await request("/api/auth/session", { headers: { Cookie: `${cookie}tampered` } })).status, 401);
  const badLogout = await request("/api/auth/logout", { method: "POST", headers: { ...headers, Origin: "https://attacker.test" } }); assert.equal(badLogout.status, 403);
  const logout = await request("/api/auth/logout", { method: "POST", headers: { ...headers, Origin: origin } }); assert.equal(logout.status, 200); assert.match(logout.headers.get("set-cookie"), /Max-Age=0/);
  assert.equal((await request("/api/auth/session", { headers })).status, 401);
  assert.equal((await request("/", { headers })).status, 307);
  const machineResponse = await request("/api/model-performance", { headers: { Authorization: `Bearer ${machine}` } }); assert.equal(machineResponse.status, 200);
  const machinePerformance = await machineResponse.json();
  assert.deepEqual(Object.keys(machinePerformance), ["dataIdentity", "publicationReady", "latestEodReferenceDate"]);
  assert.equal(machinePerformance.dataIdentity.commitSha, deploySha);
  const expected = machinePerformance.dataIdentity;
  const verified = await inspectDailyProductionDeployment({ siteUrl: origin, expectedReferenceDate: expected.referenceDate, expectedSnapshotHash: expected.snapshotHash, expectedCommitSha: deploySha, automationToken: machine });
  assert.equal(verified.matches, true, JSON.stringify(verified));
  for (const route of ["top-stocks?model=A&limit=1", "home-dashboard?topN=5", "model-performance", "daily-production-status"]) {
    const response = await request(`/api/${route}`, { headers: { Authorization: `Bearer ${machine}` } });
    const body = await response.json(); assert.equal(response.status, 200); assert.deepEqual(body.dataIdentity, expected); assert.equal(body.publicationReady, true);
    assert.doesNotMatch(JSON.stringify(body), /stocks|models|records|scores|closePrice|sourceEvidence|recentFailureReason/u, "Automation must not receive private data through Home or other APIs");
  }
  console.log("PUBLICATION HTTP integration passed: actual authenticated Home/TOP/performance/status routes, exact snapshot hash and deploy SHA, minimal automation DTOs");
  assert.equal((await request("/api/screener", { headers: { Authorization: `Bearer ${machine}` } })).status, 401);
  for (let i = 0; i < 2; i++) assert.equal((await login({ username, password: "wrong" })).status, 401);
  assert.equal((await login({ username, password })).status, 429);
  assert.equal((await request("/api/forecasts/swing", { headers: { Authorization: `Bearer ${machine}` } })).status, 401);
  assert.equal((await request("/api/private-live", { headers })).status, 401);
  console.log("HTTP security passed: 19 APIs, pages/static/RSC policy, login/errors/limit, cookie tamper, CSRF, real server revocation, scoped automation");
  if (process.argv.includes("--preview")) {
    fixture.reset();
    console.log(`AUTH_TEST_PREVIEW_URL=${origin}/login`);
    console.log("Synthetic UI fixture credentials: local-test-admin / Abcdef12 (not a real account)");
    await new Promise(resolve => { process.on("SIGINT", resolve); process.on("SIGTERM", resolve); });
  }
} finally { await cleanup(); }
