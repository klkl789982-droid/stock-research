import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import ts from "typescript";
import * as auth from "../lib/admin-auth.mjs";
import * as codes from "../lib/stock-code.mjs";
import * as watchlist from "../lib/watchlist.mjs";
import { watchlistMarketRows } from "../lib/watchlist-market.mjs";
import { memoryAuthStore } from "./auth-test-support.mjs";

const row = (code, closePrice = 100) => ({ code, name: "종목" + code, market: "KOSPI", closePrice, executable: true, qualityEligibility: { eligible: true },
  scores: { modelB: 75 }, ranks: { modelB: 2 } });
const snapshot = (date, records) => ({ asOfDate: date, dataQuality: { structuralStatus: "passed" }, records: records.map(r => ({ ...r, date })) });
const prior = snapshot("2026-11-02", [row("000001", 80), row("000002", 100)]);
const current = snapshot("2026-11-03", [row("000001"), { ...row("000002", 98), qualityEligibility: { eligible: false } }]);
const calendar = { dates: Object.fromEntries([prior, current].map(s => [s.asOfDate, { status: "tradingDay" }])) };
const market = watchlistMarketRows(current, prior, calendar, current.asOfDate);

test("same-code tradable closes on confirmed adjacent sessions only; no quarantine zero or false day change", () => {
  assert.equal(market.get("000001").closeChangePct, 25);
  assert.equal(market.get("000001").models["B-v1"].rank, 2);
  assert.equal(market.get("000002").close, null);
  assert.equal(market.get("000002").models, null);
  assert.equal(watchlistMarketRows(current, prior, {}, current.asOfDate).get("000001").closeChangePct, null);
  const damaged = { ...prior, records: [...prior.records, prior.records[0]] };
  assert.equal(watchlistMarketRows(current, damaged, calendar, current.asOfDate).get("000001").close, 100);
  assert.equal(watchlistMarketRows(current, damaged, calendar, current.asOfDate).get("000001").closeChangePct, null);
  assert.throws(() => watchlistMarketRows({ ...current, asOfDate: "2026-11-04" }, prior, calendar, current.asOfDate));
});

function redisFixture() {
  const records = new Map();
  return async args => {
    const op = args[0], key = args[op === "EVAL" ? 3 : 1];
    assert.match(key, /^tb:watchlist:v1:[a-f0-9]{64}$/);
    const hash = records.get(key) ?? new Map();
    records.set(key, hash);
    if (op === "HGETALL") return [...hash].flat();
    if (op === "HDEL") return Number(hash.delete(args[2]));
    assert.equal(op, "EVAL");
    const [, lua, keyCount, , code, json, limit] = args;
    assert.equal(keyCount, 1);
    assert.match(lua, /HEXISTS.*\n.*HLEN.*\n.*HSET/su);
    if (hash.has(code)) return 0;
    if (hash.size >= limit) return -1;
    hash.set(code, json);
    return 1;
  };
}

test("parallel inserts are bounded and idempotent, and account scope survives session/credential rotation", async () => {
  const command = redisFixture(), user = { username: "a", origin: "https://test.invalid" };
  const store = watchlist.createWatchlistStore(user, command);
  const results = await Promise.all(Array.from({ length: 52 }, (_, i) => store.add(row(String(i).padStart(6, "0")))));
  assert.deepEqual([results.filter(n => n === 1).length, results.filter(n => n === -1).length], [50, 2]);
  assert.equal(await store.add(row("000001")), 0);
  const other = watchlist.createWatchlistStore({ ...user, username: "b" }, command);
  await other.remove("000001");
  assert.equal((await other.list()).length, 0);
  assert.equal((await watchlist.createWatchlistStore({ ...user, secret: "rotated" }, command).list()).length, 50);
  await store.remove("000001"); await store.remove("000001");
  assert.equal((await store.list()).length, 49);
});

async function compiled(file, modules) {
  const source = await readFile(new URL(file, import.meta.url), "utf8");
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  new Function("require", "exports", js)(key => { if (!(key in modules)) throw Error(key); return modules[key]; }, exports);
  return exports;
}
test("actual authenticated handlers isolate sessions, reject user overrides and CSRF, retain saved rows on price outage", async () => {
  const password = "Watchlist-fixture123";
  const env = { NODE_ENV: "development", TB_ADMIN_USERNAME: "test-a", TB_ADMIN_PASSWORD_HASH: await auth.hashAdminPassword(password),
    TB_SESSION_SECRET: randomBytes(32).toString("base64url"), TB_AUTH_ORIGIN: "https://example.invalid",
    TB_AUTH_REDIS_URL: "https://redis.invalid", TB_AUTH_REDIS_TOKEN: "fixture" };
  let config = auth.authConfig(env), marketUp = true;
  const sessions = memoryAuthStore(), command = redisFixture();
  const login = async () => (await auth.createAdminAuth(config, sessions).login(config.username, password, "fixture")).token;
  const authBoundary = await compiled("../lib/admin-access.ts", { "server-only": {},
    "./admin-auth.mjs": { ...auth, authenticateRequest: async req => ({
      session: await auth.createAdminAuth(config, sessions).verify(auth.readCookie(req, env)), unavailable: false,
    }) } });
  const api = await compiled("../app/api/watchlist/route.ts", { "@/lib/admin-access": authBoundary,
    "@/lib/admin-auth.mjs": { ...auth, authConfig: () => config, createRedisCommand: () => command },
    "@/lib/stock-code.mjs": codes, "@/lib/watchlist.mjs": watchlist,
    "@/lib/watchlist-market.mjs": { getWatchlistMarket: async () => { if (!marketUp) throw Error("offline"); return market; } } });
  const request = (method, token, body, origin = config.origin, query = "") => api[method](new Request(config.origin + "/api/watchlist" + query, {
    method, headers: { origin, "content-type": "application/json", cookie: auth.COOKIE_NAME(env) + "=" + token }, ...(body ? { body: JSON.stringify(body) } : {}),
  }));
  const a = await login(), input = { code: "000001" };
  assert.equal((await request("GET", "")).status, 401);
  assert.equal((await request("PUT", a, input, "https://other.invalid")).status, 403);
  assert.equal((await request("PUT", a, { ...input, username: "test-b" })).status, 400);
  assert.equal((await request("GET", a, null, config.origin, "?owner=test-b")).status, 400);
  assert.equal((await (await request("GET", a, null, config.origin, "?search=000001")).json()).candidates.length, 1);
  assert.equal((await request("PUT", a, { code: "000999" })).status, 404);
  assert.equal((await request("PUT", a, input)).status, 200);
  assert.equal((await request("PUT", a, input)).status, 200);
  assert.deepEqual((await (await request("GET", a)).json()).items, [market.get("000001")]);
  marketUp = false;
  const outage = await (await request("GET", a)).json();
  assert.equal(outage.marketAvailable, false); assert.equal(outage.items[0].name, "종목000001"); assert.equal(outage.items[0].close, null);
  config = auth.authConfig({ ...env, TB_ADMIN_USERNAME: "test-b" });
  assert.equal((await request("GET", a)).status, 401);
  const b = await login();
  assert.deepEqual((await (await request("GET", b)).json()).items, []);
  assert.equal((await request("DELETE", b, input)).status, 200);
  config = auth.authConfig(env);
  assert.equal((await (await request("GET", a)).json()).items.length, 1);
  assert.equal((await request("DELETE", a, input)).status, 200);
  assert.deepEqual((await (await request("GET", a)).json()).items, []);
  assert.equal(auth.isAutomationRequest(new Request(config.origin + "/api/watchlist", { headers: { authorization: "Bearer " + "x".repeat(45) } }), { TB_AUTOMATION_READ_TOKEN: "x".repeat(45) }), false);
});
