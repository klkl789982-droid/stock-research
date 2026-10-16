import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { localLiveExecutorResponse } from "./local-live-executor.mjs";
import { isAutomationRequest } from "./admin-auth.mjs";

const token = "NON_SENSITIVE_FIXTURE_0123456789_abcdefghijklmnopqrstuvwxyz";
const request = (url = "http://127.0.0.1:3000/api/private-live", headers = {}) => new Request(url, { headers });
const stamp = "2026-10-12T07:12:34.000Z";
const statusFixture = { mode: "shadow", status: "STORED", observationType: "CURRENT_TIME_SHADOW", signalDate: "2026-10-12", collectionStartedAt: stamp, collectionCompletedAt: stamp,
  storedAt: stamp, lastSuccessAt: stamp, collection: { successful: 508, failed: 0, ineligible: 45 }, rawQuote: { price: 1234 }, token: "DO_NOT_RETURN" };
const topFixture = (model) => ({ mode: "shadow", signalDate: "2026-10-12", seedReferenceDate: "2026-10-08", observationType: "CURRENT_TIME_SHADOW", contentHash: "a".repeat(64),
  collectionStartedAt: stamp, collectionCompletedAt: stamp, modelVersion: `${model}-v1`, rawQuote: { price: 1234 },
  records: [{ ticker: "005930", companyName: "Synthetic only", score: 72.5, rank: 1, quote: { price: 1234 }, volume: 999 }] });
async function fixture(t, fetchOverride = null) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "tb-local-live-bridge-"));
  t.after(async () => { assert.ok(directory.startsWith(`${path.resolve(os.tmpdir())}${path.sep}tb-local-live-bridge-`)); await fs.rm(directory, { recursive: true, force: true }); });
  const filename = path.join(directory, "read-token");
  await fs.writeFile(filename, `${token}\n`, { mode: 0o600 });
  const env = { LIVE_EXECUTOR_LOCAL_READ_ENABLED: "true", LIVE_EXECUTOR_LOCAL_ORIGIN: "http://127.0.0.1:4319", LIVE_EXECUTOR_LOCAL_MODE: "shadow", LIVE_EXECUTOR_LOCAL_TOKEN_FILE: filename };
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init.method });
    assert.equal(init.headers.Authorization, `Bearer ${token}`);
    assert.equal(init.redirect, "error"); assert.equal(init.cache, "no-store"); assert.ok(init.signal);
    assert.equal(new URL(url).origin, "http://127.0.0.1:4319");
    if (fetchOverride) return fetchOverride(new URL(url), init);
    return Response.json(new URL(url).pathname === "/status" ? statusFixture : topFixture(new URL(url).searchParams.get("model")));
  };
  return { env, calls, fetchImpl, directory };
}

test("default-off and every Vercel environment deny before any upstream request", async (t) => {
  const f = await fixture(t);
  for (const env of [{}, { ...f.env, LIVE_EXECUTOR_LOCAL_READ_ENABLED: "false" }, { ...f.env, VERCEL: "1" }, { ...f.env, VERCEL: "" }]) {
    assert.equal((await localLiveExecutorResponse(request(), { env, fetchImpl: f.fetchImpl })).status, 404);
  }
  assert.equal(f.calls.length, 0);
});
test("remote, spoofed Host, foreign Origin and cross-site requests cannot reach the local source", async (t) => {
  const f = await fixture(t);
  for (const req of [request("https://stock-research-chi.vercel.app/api/private-live"), request(undefined, { Host: "attacker.invalid" }),
    request(undefined, { Origin: "https://attacker.invalid" }), request(undefined, { "sec-fetch-site": "cross-site" }),
    request(undefined, { "x-forwarded-host": "attacker.invalid" }), request(undefined, { "x-forwarded-for": "10.0.0.8" })])
    assert.equal((await localLiveExecutorResponse(req, f)).status, 403);
  assert.equal(f.calls.length, 0);
});

test("Next loopback URL normalization permits only same-port local aliases", async t => {
  const f = await fixture(t);
  const good = await localLiveExecutorResponse(request("http://localhost:3000/api/private-live", { Host: "127.0.0.1:3000", Origin: "http://127.0.0.1:3000", "x-forwarded-host": "127.0.0.1:3000" }), f);
  assert.equal(good.status, 200); assert.equal((await good.json()).modelStatus, "AVAILABLE");
  for (const host of ["127.0.0.1:3001", "localhost:3001", "localhost:3000@attacker.invalid", "localhost:3000/evil"]) {
    assert.equal((await localLiveExecutorResponse(request("http://localhost:3000/api/private-live", { Host: host }), f)).status, 403);
  }
});
test("upstream origin cannot be used for SSRF, URL credentials, redirects or query injection", async (t) => {
  const f = await fixture(t);
  for (const origin of ["https://127.0.0.1:4319", "http://localhost:4319", "http://169.254.169.254:4319", "http://user:pass@127.0.0.1:4319", "http://127.0.0.1:4319/other", "http://127.0.0.1:4319/?url=x", "http://127.0.0.1:80", "http://127.0.0.1:4319/#secret"]) {
    const result = await localLiveExecutorResponse(request(), { ...f, env: { ...f.env, LIVE_EXECUTOR_LOCAL_ORIGIN: origin } });
    assert.equal((await result.json()).status, "UNAVAILABLE");
  }
  assert.equal(f.calls.length, 0);
  assert.equal((await localLiveExecutorResponse(request("http://127.0.0.1:3000/api/private-live?model=E"), f)).status, 400);
});
test("token must come from an external private file and is never included in failure responses", async (t) => {
  const f = await fixture(t);
  for (const filename of [".env.local", path.resolve(".env.local"), path.join(f.directory, "missing")]) {
    const result = await localLiveExecutorResponse(request(), { ...f, env: { ...f.env, LIVE_EXECUTOR_LOCAL_TOKEN_FILE: filename } });
    const text = await result.text(); assert.doesNotMatch(text, /NON_SENSITIVE|\.env|missing/u);
    assert.equal(JSON.parse(text).status, "UNAVAILABLE");
  }
  assert.equal(f.calls.length, 0);
});
test("four model summaries share one immutable observation and raw prices are stripped", async (t) => {
  const f = await fixture(t);
  const result = await localLiveExecutorResponse(request(undefined, { Host: "127.0.0.1:3000", Origin: "http://127.0.0.1:3000", "sec-fetch-site": "same-origin" }), f);
  assert.equal(result.status, 200); assert.match(result.headers.get("cache-control"), /private, no-store/u);
  const body = await result.json();
  assert.equal(body.source, "localPrivateExecutor"); assert.equal(body.mode, "shadow");
  assert.equal(body.observationType, "CURRENT_TIME_SHADOW"); assert.equal(body.modelStatus, "AVAILABLE");
  assert.deepEqual(body.models.map((entry) => entry.model), ["A", "B", "C", "D"]);
  assert.deepEqual(f.calls.map((call) => new URL(call.url).pathname + new URL(call.url).search), ["/status", "/top?model=A&limit=5", "/top?model=B&limit=5", "/top?model=C&limit=5", "/top?model=D&limit=5"]);
  assert.doesNotMatch(JSON.stringify(body), /rawQuote|"price"|"volume"|"quote"|token|NON_SENSITIVE|DO_NOT_RETURN/u);
});
test("no saved model remains an explicit no-observation state rather than fabricated scores", async (t) => {
  const f = await fixture(t, (url) => url.pathname === "/status" ? Response.json({ mode: "shadow", status: "NO_OBSERVATION" }) : Response.json({ error: "NO_OBSERVATION" }, { status: 503 }));
  const body = await (await localLiveExecutorResponse(request(), f)).json();
  assert.equal(body.status, "NO_OBSERVATION"); assert.equal(body.modelStatus, "UNAVAILABLE"); assert.deepEqual(body.models, []);
});
test("mixed artifact hashes or mismatched LIVE/shadow types fail closed", async (t) => {
  for (const mutate of [(value) => ({ ...value, contentHash: "b".repeat(64) }), (value) => ({ ...value, observationType: "LIVE_OBSERVATION" })]) {
    const f = await fixture(t, (url) => Response.json(url.pathname === "/status" ? statusFixture : url.searchParams.get("model") === "B" ? mutate(topFixture("B")) : topFixture(url.searchParams.get("model"))));
    const body = await (await localLiveExecutorResponse(request(), f)).json();
    assert.equal(body.status, "UNAVAILABLE"); assert.deepEqual(body.models, []);
  }
});
test("bounded upstream failures never return provider responses or secret-shaped error bodies", async (t) => {
  const f = await fixture(t, () => new Response("DO_NOT_RETURN_PROVIDER_ERROR", { status: 401 }));
  const result = await localLiveExecutorResponse(request(), f);
  assert.doesNotMatch(await result.text(), /DO_NOT_RETURN|NON_SENSITIVE/u);
  const oversized = await fixture(t, () => Response.json({ text: "x".repeat(140000) }));
  assert.equal((await (await localLiveExecutorResponse(request(), oversized)).json()).status, "UNAVAILABLE");
});
test("private-live route reuses administrator authentication and is not an automation-read exception", async () => {
  const route = await fs.readFile(new URL("../app/api/private-live/route.ts", import.meta.url), "utf8");
  assert.match(route, /GET = withAdminAccess/u);
  assert.equal(isAutomationRequest(new Request("http://127.0.0.1:3000/api/private-live", { headers: { Authorization: `Bearer ${token}` } }), { TB_AUTOMATION_READ_TOKEN: token }), false);
});
