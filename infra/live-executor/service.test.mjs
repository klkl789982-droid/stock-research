import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { privateApiToken } from "./private-token.mjs";
import { verifyHostClock } from "./runtime.mjs";
import { createLocalExecutionStore } from "./store.mjs";
import { startPrivateApi } from "./api.mjs";

test("private API credential is create-only, outside checkout and never regenerated on restart", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "tb-service-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const first = await privateApiToken(directory);
  assert.match(first, /^[a-f0-9]{64}$/u);
  assert.equal(await privateApiToken(directory), first);
  await fs.writeFile(path.join(directory, "auth", "read-token"), "corrupt");
  await assert.rejects(privateApiToken(directory), /LOCAL_TOKEN_FILE_INVALID/u);
  assert.equal(await fs.readFile(path.join(directory, "auth", "read-token"), "utf8"), "corrupt");
});

test("clock reference checks TLS date uncertainty, timeout/failure and clock jumps", async () => {
  const start = Date.parse("2026-10-12T05:29:00.000Z");
  const response = (date, status = 200) => new Response(null, { status, headers: { date, "cache-control": "no-cache" } });
  let clock = [start, start + 400];
  const good = await verifyHostClock({ now: () => clock.shift(), fetchImpl: async (url, init) => {
    assert.equal(url, "https://api.github.com/rate_limit"); assert.equal(init.method, "GET"); assert.equal(init.cache, "no-store"); assert.equal(init.headers["Cache-Control"], "no-cache");
    return response("Mon, 12 Oct 2026 05:29:00 GMT");
  } });
  assert.equal(good.offsetMs, -200); assert.equal(good.uncertaintyMs, 1200);
  for (const [end, date, reason] of [[start + 400, "Mon, 12 Oct 2026 05:28:40 GMT", "HOST_CLOCK_OFFSET_EXCEEDED"], [start + 6000, "Mon, 12 Oct 2026 05:29:00 GMT", "CLOCK_REFERENCE_UNAVAILABLE"], [start - 1, "Mon, 12 Oct 2026 05:29:00 GMT", "CLOCK_REFERENCE_UNAVAILABLE"]]) {
    clock = [start, end];
    await assert.rejects(verifyHostClock({ now: () => clock.shift(), fetchImpl: async () => response(date) }), new RegExp(reason));
  }
  await assert.rejects(verifyHostClock({ fetchImpl: async () => { throw new Error("must not leak upstream"); } }), /CLOCK_REFERENCE_UNAVAILABLE/u);
  for (const headers of [{ "cache-control": "public, max-age=60" }, { "cache-control": "no-cache", age: "10" }]) {
    clock = [start, start + 100];
    await assert.rejects(verifyHostClock({ now: () => clock.shift(), fetchImpl: async () => new Response(null, { headers: { date: "Mon, 12 Oct 2026 05:29:00 GMT", ...headers } }) }), /CLOCK_REFERENCE_UNAVAILABLE/);
  }
});

test("persistent service status is authenticated and contains only operational metadata", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "tb-service-api-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = createLocalExecutionStore(directory), token = await privateApiToken(directory);
  const api = await startPrivateApi({ store, mode: "live", token });
  t.after(() => api.close());
  assert.equal((await fetch(`${api.url}/status`)).status, 401);
  const response = await fetch(`${api.url}/status`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.mode, "live"); assert.equal(body.status, "WAITING"); assert.equal(body.signalDate, null);
  assert.doesNotMatch(JSON.stringify(body), /appKey|appSecret|read-token|"quote"/u);
});
