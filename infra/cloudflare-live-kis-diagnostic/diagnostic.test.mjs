import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { FORMULA_HASHES } from "./formula-manifest.mjs";
import { fixture } from "../cloudflare-live-free-probe/core.mjs";
import { calculateIntradayModelTopScores } from "../../lib/intraday-model-top-official-signal.mjs";
import { mergeProvisionalCandle } from "../../lib/intraday-model-b-official-signal.mjs";
import { assertDiagnostic, metadataOnly, createDiagnosticClient, edgeFetch, transportReason, DIAGNOSTIC_REQUEST_CAP, quotaDay, advertisedMain, sealAuthentication, openAuthentication, diagnosticMinuteTime, freezeDiagnosticReport } from "./core.mjs";
const env = { LIVE_ENABLED: "false", DIAGNOSTIC_ONLY: "true", KIS_APP_KEY: "test-not-a-real-key", KIS_APP_SECRET: "test-not-a-real-secret" };
test("diagnostic fails closed during PC window and never enables live", () => {
  assert.throws(() => assertDiagnostic(env, Date.parse("2026-10-19T14:00:00+09:00")), /EXCLUSION/u);
  assert.doesNotThrow(() => assertDiagnostic(env, Date.parse("2026-10-18T22:00:00+09:00")));
  assert.throws(() => assertDiagnostic({ ...env, LIVE_ENABLED: "true" }), /FAIL_CLOSED/u);
});
test("raw price payload is reduced to metadata, never a LIVE signal", () => {
  const q = { rt_cd: "0", output: { stck_prpr: "100", stck_oprc: "95", stck_hgpr: "101", stck_lwpr: "94", acml_vol: "300", prdy_vrss: "5", prdy_ctrt: "5" } };
  const m = { rt_cd: "0", output2: [{ stck_bsop_date: "20261016", stck_cntg_hour: "153000", stck_prpr: "100" }] };
  const result = metadataOnly(q, m, "005930", { quoteReceivedAt: "2026-10-18T13:00:00.000Z", minuteRequestedAt: "2026-10-18T13:00:01.000Z" });
  assert.equal(result.quoteStatus, "VALID"); assert.equal(result.observedDate, "20261016"); assert.equal(result.eligibleForLive, false);
  assert.ok(!/stck_prpr|acml_vol|"price"|"volume"/u.test(JSON.stringify(result))); assert.match(result.responseHash, /^[a-f0-9]{64}$/u);
});

test("off-hours exchange-clock queries preserve real receipt date and empty rows are not success", () => {
  const at = Date.parse("2026-10-19T00:00:00+09:00");
  assert.equal(diagnosticMinuteTime(at), "15:30:00");
  assert.equal(diagnosticMinuteTime(Date.parse("2026-10-19T14:02:00+09:00")), "14:02:00");
  const timing = { quoteReceivedAt: new Date(at).toISOString(), minuteRequestedAt: new Date(at).toISOString(), minuteRequestedExchangeTime: "15:30:00" };
  const q = { rt_cd: "0", output: { stck_prpr: "100", stck_oprc: "95", stck_hgpr: "101", stck_lwpr: "94", acml_vol: "300", prdy_vrss: "5", prdy_ctrt: "5" } };
  assert.equal(metadataOnly(q, { rt_cd: "0", output2: [] }, "005930", timing).minuteStatus, "TIMESTAMP_UNAVAILABLE");
  const value = metadataOnly(q, { rt_cd: "0", output2: [{ stck_bsop_date: "20261016", stck_cntg_hour: "153000" }] }, "005930", timing);
  assert.equal(value.observedDate, "20261016"); assert.equal(value.minuteStatus, "SUCCESS");
  assert.equal(value.minuteRequestedAt, new Date(at).toISOString()); assert.equal(value.eligibleForLive, false);
});
test("existing token manager shares one issuance with parallel consumers without exporting bearer", async () => {
  let calls = 0;
  const c = createDiagnosticClient({ appKey: "fixture", appSecret: "fixture" }, async () => { calls++; return Response.json({ access_token: "fixture-bearer", expires_in: 86400 }); });
  await Promise.all([c.manager.getToken(), c.manager.getToken(), c.manager.getToken()]);
  assert.equal(calls, 1); assert.equal(c.manager.getState().hasUsableToken, true);
  assert.ok(!JSON.stringify(c.manager.getState()).includes("fixture-bearer"));
});
test("credentialed edge transport rejects redirects", async () => {
  await assert.rejects(() => edgeFetch("https://example.invalid", {}, async (_url, init) => { assert.equal(init.redirect, "manual"); return new Response(null, { status: 302 }); }), /REDIRECT_REJECTED/u);
});
test("platform failures are classified without exporting original error text", () => {
  assert.equal(transportReason(new Error("Too many subrequests; sensitive fixture must not be echoed")), "DIAG_PLATFORM_SUBREQUEST_LIMIT");
  assert.equal(transportReason(new Error("Cannot perform I/O on behalf of a different request")), "DIAG_PLATFORM_IO_CONTEXT");
  assert.equal(transportReason(new Error("arbitrary-secret-fixture")), "DIAG_UNKNOWN_TRANSPORT_FAILURE");
  assert.equal(transportReason(Object.assign(new Error("secret URL"), { cause: { code: "ECONNRESET", message: "secret bearer" } })), "DIAG_TRANSPORT_CONNECTION_RESET");
  assert.equal(transportReason({ code: "ENOTFOUND" }), "DIAG_TRANSPORT_DNS");
  assert.equal(transportReason({ cause: { code: "UND_ERR_BODY_TIMEOUT" } }), "DIAG_TRANSPORT_TIMEOUT");
  assert.equal(transportReason({ code: "SECRET_VALUE_NOT_A_CODE" }), "DIAG_UNKNOWN_TRANSPORT_FAILURE");
});
test("public Git input resolution pins exactly one main commit, never guessed latest files", () => {
  const sha = "a".repeat(40);
  assert.equal(advertisedMain(`001e# service=git-upload-pack\n0000003f${sha} refs/heads/main\n0000`), sha);
  assert.throws(() => advertisedMain("0000"), /COMMIT_INVALID/u);
  assert.throws(() => advertisedMain(`${sha} refs/heads/main\n${sha} refs/heads/main\n`), /COMMIT_INVALID/u);
});

test("report outbox freezes bytes before failed delivery and recovers remote commit across restart", async () => {
  let local = null, remote = null, builds = 0;
  const options = { readLocal: () => local, readRemote: async () => remote && { value: remote }, saveLocal: v => { local = v; }, build: async () => ({ counter: ++builds }), validate: v => assert.equal(v.counter, 1) };
  const original = await freezeDiagnosticReport(options);
  // A failed remote upload leaves the exact local outbox; unrelated counters
  // may change but must never rebuild the result.
  assert.strictEqual(await freezeDiagnosticReport(options), original); assert.equal(builds, 1);
  remote = original; local = null;
  assert.strictEqual(await freezeDiagnosticReport(options), original); assert.equal(builds, 1);
  assert.deepEqual(local, remote);
});
let source = await fs.readFile(new URL("./src/index.mjs", import.meta.url), "utf8");
let shardSource = await fs.readFile(new URL("./src/shard.mjs", import.meta.url), "utf8");
shardSource = shardSource.replace('import { DurableObject } from "cloudflare:workers";', 'class DurableObject { constructor(ctx,env) { this.ctx=ctx; this.env=env; } }');
for (const relative of ["../../../lib/kis-api-client-core.mjs", "../../../lib/intraday-model-top-official-signal.mjs", "../core.mjs"])
  shardSource = shardSource.replaceAll(JSON.stringify(relative), JSON.stringify(new URL(relative, new URL("./src/shard.mjs", import.meta.url)).href));
const shardModule = `data:text/javascript;base64,${Buffer.from(shardSource).toString("base64")}`;
const { KisDiagnosticShard } = await import(shardModule);
source = source.replace('"./shard.mjs"', JSON.stringify(shardModule));
let slotSource = await fs.readFile(new URL("./src/slot-shard.mjs", import.meta.url), "utf8");
slotSource = slotSource.replace('import { DurableObject } from "cloudflare:workers";', 'class DurableObject { constructor(ctx,env) { this.ctx=ctx; this.env=env; } }');
for (const relative of ["../../../lib/kis-api-client-core.mjs", "../../../lib/intraday-model-top-official-signal.mjs", "../core.mjs"])
  slotSource = slotSource.replaceAll(JSON.stringify(relative), JSON.stringify(new URL(relative, new URL("./src/slot-shard.mjs", import.meta.url)).href));
const slotModule = `data:text/javascript;base64,${Buffer.from(slotSource).toString("base64")}`;
const { KisSlotShard } = await import(slotModule);
source = source.replace('"./slot-shard.mjs"', JSON.stringify(slotModule));
source = source.replace('export { LiveDay, LiveBatch, CloudLive } from "./production.mjs";', '');
source = source.replace('import { productionScheduled, assertIsolatedProductionFixture } from "./production.mjs";',
  'const productionScheduled = () => ({ status: "DISABLED" }); const assertIsolatedProductionFixture = () => {};');
source = source.replace('"../production-core.mjs"', JSON.stringify(new URL("./production-core.mjs", import.meta.url).href));
source = source.replace('import { DurableObject, WorkflowEntrypoint } from "cloudflare:workers";', 'class DurableObject { constructor(ctx,env) { this.ctx=ctx; this.env=env; } } class WorkflowEntrypoint {}');
for (const relative of ["../core.mjs", "../formula-manifest.mjs", "../site-fixture.mjs", "../swing-fixture.mjs", "../relay-budget.mjs", "../../../lib/kis-api-client-core.mjs", "../../../lib/kis-eod-private-store.mjs", "../../../lib/intraday-model-top-official-signal.mjs", "../../../lib/intraday-model-b-official-signal.mjs", "../../../lib/kis-quote-provider-core.mjs", "../../../lib/intraday-market-seed.mjs", "../../../lib/live-seed-policy.mjs", "../../../lib/kis-eod-provider.mjs"])
  source = source.replaceAll(JSON.stringify(relative), JSON.stringify(new URL(relative, new URL("./src/index.mjs", import.meta.url)).href));
const { KisDiagnosticBroker } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
function sandbox(t) {
  const db = new DatabaseSync(":memory:"); t.after(() => db.close());
  const ctx = { storage: { sql: { get databaseSize() { return db.prepare("PRAGMA page_count").get().page_count * 4096; }, exec(query, ...args) { const rows = db.prepare(query).all(...args); return { toArray: () => rows, one: () => { assert.equal(rows.length, 1); return rows[0]; } }; } } } };
  const localEnv = { ...env };
  return { db, ctx, env: localEnv, broker: new KisDiagnosticBroker(ctx, localEnv) };
}
test("actual broker preserves immutable metadata across restart and rejects hash conflict", t => {
  const f = sandbox(t), value = { records: [], eligibleForLive: false, rawPricesStored: false };
  f.broker.store("test", value);
  new KisDiagnosticBroker(f.ctx, env).store("test", value);
  assert.throws(() => f.broker.store("test", { ...value, changed: true }), /IMMUTABLE_CONFLICT/u);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM evidence").get().n, 1);
});

test("authenticated token survives controller restart only as authenticated ciphertext", async t => {
  const f = sandbox(t); let requests = 0;
  t.mock.method(globalThis, "fetch", async () => { requests++; return Response.json({ access_token: "fixture-bearer-restart-test", expires_in: 86400 }); });
  const first = await f.broker.sharedAuth("restart-test");
  const restored = new KisDiagnosticBroker(f.ctx, env);
  assert.deepEqual(await restored.sharedAuth("after-restart"), first);
  assert.equal(requests, 1);
  const box = f.db.prepare("SELECT value FROM control WHERE id='sealedAuth'").get().value;
  assert.ok(!box.includes(first.accessToken));
  assert.deepEqual(openAuthentication(box, { appKey: env.KIS_APP_KEY, appSecret: env.KIS_APP_SECRET }), first);
  assert.throws(() => openAuthentication(box, { appKey: "wrong", appSecret: env.KIS_APP_SECRET }), /INTEGRITY/u);
  assert.throws(() => openAuthentication(box, { appKey: env.KIS_APP_KEY, appSecret: "wrong" }), /INTEGRITY/u);
  const modified = JSON.parse(box); modified.tag = Buffer.alloc(16).toString("base64");
  assert.throws(() => openAuthentication(JSON.stringify(modified), { appKey: env.KIS_APP_KEY, appSecret: env.KIS_APP_SECRET }), /INTEGRITY/u);
  assert.notEqual(sealAuthentication(first, { appKey: env.KIS_APP_KEY, appSecret: env.KIS_APP_SECRET }), box);
  assert.equal(restored.invalidateAuthentication({ ...first, accessToken: "late-401" }), false);
  assert.equal(restored.invalidateAuthentication(first), true);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM control WHERE id='sealedAuth'").get().n, 0);
});
test("actual broker stops at durable daily cap before touching network", async t => {
  const f = sandbox(t), day = quotaDay(Date.now());
  f.broker.set(`requests:${day}`, DIAGNOSTIC_REQUEST_CAP);
  await assert.rejects(() => f.broker.transport("https://example.invalid", {}), /BUDGET_EXHAUSTED/u);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM calls").get().n, 0);
});
test("deployed formula manifest exactly matches current production source files", async () => {
  for (const [file, expected] of Object.entries(FORMULA_HASHES)) {
    const text = (await fs.readFile(new URL(`../../${file}`, import.meta.url), "utf8")).replaceAll("\r\n", "\n");
    assert.equal(createHash("sha256").update(text).digest("hex"), expected, file);
  }
});
test("actual credential broker paces all calls, retries once, preserves scores and never stores prices", async t => {
  const f = sandbox(t), data = fixture(0), stampMono = performance.now();
  t.mock.method(Date, "now", () => Date.parse("2026-10-18T12:00:00Z") + Math.floor(performance.now() - stampMono));
  f.broker.seed = { requestedDate: "2020-01-01" };
  f.broker.seedByCode = new Map([["005930", { eligible: true, rows: data.rows }]]);
  f.broker.deadline = Date.now() + 15000;
  const q = data.quote, quote = { rt_cd: "0", output: { stck_prpr: String(q.price), stck_oprc: String(q.open), stck_hgpr: String(q.high), stck_lwpr: String(q.low), acml_vol: String(q.volume), prdy_vrss: String(q.change), prdy_ctrt: String(q.rate) } };
  let failed = false, active = 0, maximumActive = 0;
  t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(init.redirect, "manual"); active++; maximumActive = Math.max(maximumActive, active);
    try {
      await new Promise(r => setTimeout(r, 40));
      if (String(url).endsWith("tokenP")) return Response.json({ access_token: "fixture-bearer-not-real", expires_in: 86400 });
      if (String(url).includes("inquire-price?") && !failed) { failed = true; throw new Error("fixture-network-failure"); }
      return Response.json(String(url).includes("inquire-price?") ? quote : { rt_cd: "0", output2: [{ stck_bsop_date: "20200102", stck_cntg_hour: "140001" }] });
    } finally { active--; }
  });
  const value = await f.broker.collect("005930");
  assert.deepEqual(value.scores, calculateIntradayModelTopScores(mergeProvisionalCandle(data.rows, q), q).scores);
  f.broker.store("test:005930", value);
  const calls = f.db.prepare("SELECT started FROM calls ORDER BY started").all();
  assert.equal(calls.length, 4); assert.ok(calls.slice(1).every((r, i) => r.started - calls[i].started >= 200));
  assert.ok(maximumActive <= 2);
  const persisted = f.db.prepare("SELECT body FROM evidence").all().map(r => r.body).join("");
  assert.ok(!/stck_prpr|acml_vol|fixture-bearer-not-real|test-not-a-real-key/u.test(persisted));
  assert.equal(value.eligibleForLive, false);
});
test("interrupted batches and overlapping run ids cannot silently recollect", async t => {
  const f = sandbox(t);
  t.mock.method(Date, "now", () => Date.parse("2026-10-18T12:00:00Z"));
  f.broker.store("resume:005930:claim", { claimedAt: "2026-10-18T12:00:00.000Z", rawPricesStored: false });
  const r = await new KisDiagnosticBroker(f.ctx, env).fetch(new Request("https://isolated/batch?run=resume&codes=005930"));
  assert.equal(r.status, 503); assert.equal((await r.json()).reason, "DIAG_INTERRUPTED_BATCH_REQUIRES_REVIEW");
  f.broker.set("run:first", Date.now()); f.db.prepare("INSERT INTO control VALUES ('activeRun','first')").run();
  const overlap = await f.broker.fetch(new Request("https://isolated/batch?run=second&codes=005930"));
  assert.equal(overlap.status, 503); assert.equal((await overlap.json()).reason, "DIAG_ANOTHER_RUN_ACTIVE");
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM calls").get().n, 0);
});
test("authenticated state remains management-only with no cron or public URL", async () => {
  const config = JSON.parse(await fs.readFile(new URL("./wrangler.jsonc", import.meta.url), "utf8"));
  assert.equal(config.workers_dev, false); assert.equal(config.preview_urls, false);
  assert.deepEqual(config.triggers.crons, []); assert.equal(config.observability.enabled, false);
  assert.equal(config.vars.LIVE_ENABLED, "false"); assert.equal(config.vars.DIAGNOSTIC_ONLY, "true");
  assert.ok(!Object.keys(config.vars).some(k => /KEY|SECRET|TOKEN/u.test(k)));
});
test("separate shard invocations share only auth and two global pair leases, persisting no raw values", async t => {
  const f = sandbox(t), data = fixture(0), mono = performance.now();
  t.mock.method(Date, "now", () => Date.parse("2026-10-18T12:00:00Z") + Math.floor(performance.now() - mono));
  const codes = ["005930", "000660", "064290", "000020"];
  f.env.BROKER = { idFromName: x => x, get: () => ({ fetch: (input, init) => f.broker.fetch(input instanceof Request ? input : new Request(input, init)) }) };
  f.broker.seed = { requestedDate: "2020-01-01", contentHash: "a".repeat(64) };
  f.broker.seedByCode = new Map(codes.map(code => [code, { code, name: "Fixture", eligible: true, rows: data.rows }]));
  f.broker.store("prep:partition", { seedHash: "a".repeat(64), seedReferenceDate: "2020-01-01", eligible: 4 });
  const q = data.quote, payload = { rt_cd: "0", output: { stck_prpr: String(q.price), stck_oprc: String(q.open), stck_hgpr: String(q.high), stck_lwpr: String(q.low), acml_vol: String(q.volume), prdy_vrss: String(q.change), prdy_ctrt: String(q.rate) } };
  let actualActive = 0, maxActive = 0, authCalls = 0;
  t.mock.method(globalThis, "fetch", async url => {
    if (String(url).endsWith("tokenP")) { authCalls++; return Response.json({ access_token: "fixture-bearer-not-real", expires_in: 86400 }); }
    actualActive++; maxActive = Math.max(maxActive, actualActive);
    try { await new Promise(r => setTimeout(r, 40)); return Response.json(String(url).includes("inquire-price?") ? payload : { rt_cd: "0", output2: [{ stck_bsop_date: "20200102", stck_cntg_hour: "140001" }] }); }
    finally { actualActive--; }
  });
  const results = await Promise.all(codes.map(code => new KisDiagnosticShard({}, f.env).fetch(new Request(`https://isolated/collect?run=partition&codes=${code}`)).then(r => r.json())));
  assert.ok(results.every(r => r.records[0].modelStatus === "OFF_HOURS_DIAGNOSTIC_ONLY"));
  assert.equal(authCalls, 1); assert.ok(maxActive <= 2);
  const calls = f.db.prepare("SELECT started FROM calls ORDER BY started").all();
  assert.equal(calls.length, 9); assert.ok(calls.slice(1).every((r, i) => r.started - calls[i].started >= 200));
  const saved = f.db.prepare("SELECT body FROM evidence").all().map(r => r.body).join("");
  assert.ok(!/stck_prpr|acml_vol|fixture-bearer-not-real|"rows"/u.test(saved));
  const repeated = await new KisDiagnosticShard({}, f.env).fetch(new Request("https://isolated/collect?run=partition&codes=005930"));
  assert.deepEqual((await repeated.json()).records[0], results[0].records[0]);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM calls").get().n, 9);
});
test("session pin remains valid inside collection despite proactive refresh threshold", async t => {
  const f = sandbox(t), base = Date.parse("2026-10-18T12:00:00Z"); let ms = base, issued = 0;
  t.mock.method(Date, "now", () => ms);
  f.broker.manager = { async getToken() { issued++; return { accessToken: "fixture-only", generation: 1, expiresAtMs: base + 500000 }; } };
  await f.broker.sharedAuth("pin"); f.broker.set("run:pin", base);
  ms = base + 240000;
  f.broker.manager.getToken = async () => { throw new Error("MUST_NOT_REISSUE"); };
  assert.equal((await f.broker.sharedAuth("pin")).generation, 1); assert.equal(issued, 1);
  assert.ok(!JSON.stringify(f.db.prepare("SELECT * FROM state").all()).includes("fixture-only"));
});
for (const batch8 of [false, true]) test(`${batch8 ? "eight-symbol bounded invocation" : "single-symbol invocation"} obeys 200ms spacing, retries and secret/raw-data isolation`, async t => {
  const f = sandbox(t), data = fixture(0), mono = performance.now();
  t.mock.method(Date, "now", () => Date.parse("2026-10-18T12:00:00Z") + Math.floor(performance.now() - mono));
  const codes = ["005930", "000660", "064290", "000020"];
  f.env.BROKER = { idFromName: x => x, get: () => ({ fetch: (input, init) => f.broker.fetch(input instanceof Request ? input : new Request(input, init)) }) };
  f.broker.seed = { requestedDate: "2020-01-01", contentHash: "a".repeat(64) };
  f.broker.seedByCode = new Map(codes.map(code => [code, { code, name: "Fixture", eligible: true, rows: data.rows }]));
  f.broker.store("prep:grid", { seedHash: "a".repeat(64), seedReferenceDate: "2020-01-01", eligible: 4 });
  const q = data.quote, payload = { rt_cd: "0", output: { stck_prpr: String(q.price), stck_oprc: String(q.open), stck_hgpr: String(q.high), stck_lwpr: String(q.low), acml_vol: String(q.volume), prdy_vrss: String(q.change), prdy_ctrt: String(q.rate) } };
  let authCalls = 0, marketCalls = 0;
  t.mock.method(globalThis, "fetch", async url => {
    if (String(url).endsWith("tokenP")) { authCalls++; return Response.json({ access_token: "fixture-bearer-not-real", expires_in: 86400 }); }
    marketCalls++; await new Promise(r => setTimeout(r, 40));
    return Response.json(String(url).includes("inquire-price?") ? payload : { rt_cd: "0", output2: [{ stck_bsop_date: "20200102", stck_cntg_hour: "140001" }] });
  });
  const results = batch8
    ? (await (await new KisSlotShard({}, f.env).fetch(new Request(`https://isolated/collect-batch?run=grid&codes=${codes.join(",")}&retryCodes=005930`))).json()).records.map(row => ({ records: [row] }))
    : await Promise.all(codes.map((code, i) => new KisSlotShard({}, f.env).fetch(new Request(`https://isolated/collect?run=grid&codes=${code}&dropFirst=${i === 0}`)).then(r => r.json())));
  assert.ok(results.every(r => r.records[0].modelStatus === "OFF_HOURS_DIAGNOSTIC_ONLY"));
  const retried = results.find(r => r.records[0].code === "005930").records[0];
  assert.equal(authCalls, 1); assert.equal(marketCalls, 9); assert.equal(retried.retryEvidence.length, 1);
  const calls = f.db.prepare("SELECT started FROM calls ORDER BY started").all();
  assert.ok(calls.slice(1).every((r, i) => r.started - calls[i].started >= 200));
  assert.ok(f.db.prepare("SELECT COUNT(*) AS n FROM rate_slots WHERE skipped=1").get().n >= 1);
  const saved = f.db.prepare("SELECT body FROM evidence").all().map(r => r.body).join("");
  assert.ok(!/stck_prpr|acml_vol|fixture-bearer-not-real|"rows"|accessToken/u.test(saved));
  const repeated = await new KisSlotShard({}, f.env).fetch(new Request("https://isolated/collect?run=grid&codes=005930"));
  assert.deepEqual((await repeated.json()).records[0], retried); assert.equal(marketCalls, 9);
});
