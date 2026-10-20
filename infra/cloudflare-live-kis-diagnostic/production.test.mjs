import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { productionObservation, aggregateProduction, nextPairSlots, bounds, normalDayBudget, assertProduction, checkCutover, activationConfig, LIVE_CRONS, PRODUCTION_BUDGET } from "./production-core.mjs";
import { ProductionDayState } from "./production-state.mjs";
import { fixture } from "../cloudflare-live-free-probe/core.mjs";
import { buildIntradayModelTopSignal, hashIntradayModelTop as hash } from "../../lib/intraday-model-top-official-signal.mjs";
import { intradaySeedHash } from "../../lib/intraday-market-seed.mjs";
import { readLatestPrivateLive, validateLiveDelivery } from "../../lib/private-live-delivery.mjs";
import { validateForecastRecord } from "../../lib/forecast-swing-contract.mjs";
import { buildCloudSwingIntent, persistCloudSwingIntent } from "./cloud-swing.mjs";

const date = "2026-10-19", seedDate = "2026-10-16", b = bounds(date);
const env = { LIVE_PRODUCTION_ENABLED: "true", LIVE_PRODUCER: "cloud", LIVE_CUTOVER_RECEIPT_HASH: "a".repeat(64) };
// Load the real Workflow implementation. Replace only Cloudflare base classes
// and the already separately tested shard transport shell, not orchestration.
let workflowSource = await fs.readFile(new URL("./src/production.mjs", import.meta.url), "utf8");
workflowSource = workflowSource.replace('import { DurableObject, WorkflowEntrypoint } from "cloudflare:workers";', 'class DurableObject { constructor(ctx,env){this.ctx=ctx;this.env=env;} } class WorkflowEntrypoint {constructor(env){this.env=env;}}');
workflowSource = workflowSource.replace('import { KisSlotShard } from "./slot-shard.mjs";', 'class KisSlotShard {}');
for (const relative of ["../production-state.mjs", "../production-core.mjs", "../production-fixture.mjs", "../core.mjs", "../relay-budget.mjs", "../../../lib/kis-eod-private-store.mjs"])
  workflowSource = workflowSource.replaceAll(JSON.stringify(relative), JSON.stringify(new URL(relative, new URL("./src/production.mjs", import.meta.url)).href));
const { CloudLive, LiveDay, productionScheduled } = await import(`data:text/javascript;base64,${Buffer.from(workflowSource).toString("base64")}`);
function inputFixture() {
  const records = Array.from({ length: 553 }, (_, i) => ({ code: String(100000 + i), name: `Synthetic${i}`, market: "KOSPI", eligible: i < 508,
    officialAsOfDate: seedDate, sourceHash: "b".repeat(64), rows: fixture(i).rows.map((row, index) => [new Date(Date.parse(`${seedDate}T00:00:00Z`) - index * 86400000).toISOString().slice(0, 10).replaceAll("-", ""), ...row.slice(1)]) }));
  const base = { schemaVersion: 1, seedType: "intradayMarketAnalysisSeed", rowOrder: "descending", requestedDate: seedDate,
    generatedAt: `${date}T03:01:00.000Z`, sourceManifest: { modelFormulaHashes: Object.fromEntries(["A-v1", "B-v1", "C-v1", "D-v1"].map(v => [v, "a".repeat(64)])),
      sources: { officialDailyPrice: { normalizedInputHash: "b".repeat(64), availability: { referenceDate: seedDate, availabilityStatus: "OBSERVED",
        availabilityEvidence: "SYSTEM_OBSERVED_BATCH_COLLECTION", outcome: "success", requestedAt: `${date}T03:00:00.000Z`, observedAt: `${date}T03:00:30.000Z`, normalizedInputHash: "b".repeat(64) } } } }, records };
  return { ...base, contentHash: intradaySeedHash(base) };
}
function observations(seed) {
  const quotes = new Map(), rows = seed.records.map((input, i) => {
    const q = { ...fixture(i).quote, asOfDate: date, asOfTime: "14:00:01", receivedAt: `${date}T05:00:01.010Z` };
    quotes.set(input.code, q);
    const quote = { rt_cd: "0", output: { stck_shrn_iscd: input.code, stck_prpr: String(q.price), stck_oprc: String(q.open), stck_hgpr: String(q.high), stck_lwpr: String(q.low), acml_vol: String(q.volume), prdy_vrss: String(q.change), prdy_ctrt: String(q.rate) } };
    const minute = { rt_cd: "0", output2: [{ stck_bsop_date: "20261019", stck_cntg_hour: "140001" }] };
    const timing = { quoteRequestedAt: `${date}T05:00:01.000Z`, quoteReceivedAt: q.receivedAt, minuteRequestedAt: `${date}T05:00:01.200Z`, minuteReceivedAt: `${date}T05:00:01.210Z` };
    return productionObservation({ quote, minute, timing, code: input.code, input, seedContext: seed, signalDate: date });
  });
  return { quotes, rows };
}
function prepared(seed) { return { targetDate: date, seedReferenceDate: seedDate, readiness: "READY", universe: 553, eligible: 508,
  codes: seed.records.map(r => r.code), eligibleCodes: seed.records.filter(r => r.eligible).map(r => r.code),
  inputCommit: "a".repeat(40), seedHash: seed.contentHash, remoteCheckedAt: `${date}T04:59:02.000Z`, readyAt: `${date}T04:59:03.000Z` }; }
function remoteFixture() {
  const values = new Map(); let fail = false, requests = 0;
  const store = { async verifyPrivateRepository() {}, async read(k) { requests++; return values.has(k) ? { value: structuredClone(values.get(k)) } : null; },
    async writeImmutable(k, v) { requests++; if (fail) { fail = false; throw new Error("PRIVATE_STORE_NETWORK_FAILED"); }
      if (values.has(k) && hash(values.get(k)) !== hash(v)) throw new Error("PRIVATE_STORE_IMMUTABLE_CONFLICT"); values.set(k, structuredClone(v)); },
    async listKeys(prefix) { requests++; const names = new Map(); for (const k of values.keys()) if (k.startsWith(`${prefix}/`)) { const rest = k.slice(prefix.length + 1), [name] = rest.split("/"); names.set(name, { name, type: rest.includes("/") ? "dir" : "file" }); } return [...names.values()]; } };
  return { store, values, failNext: () => { fail = true; }, requests: () => requests };
}
function sandbox(t, seed = inputFixture()) {
  const db = new DatabaseSync(":memory:"); t.after(() => db.close()); let ms = b.start - 20000;
  const remote = remoteFixture();
  // Native SQLite execution and conservative local row accounting. This is NOT
  // a claim of actual Cloudflare billed rows; production consumes real cursors.
  const sql = { get databaseSize() { return db.prepare("PRAGMA page_count").get().page_count * 4096; }, exec(query, ...args) {
    const rows = db.prepare(query).all(...args); return { toArray: () => rows, rowsRead: rows.length + 1, rowsWritten: /^(INSERT|UPDATE)/u.test(query) ? 2 : 0 };
  } };
  const transaction = fn => { db.exec("BEGIN"); try { const value = fn(); db.exec("COMMIT"); return value; } catch (e) { db.exec("ROLLBACK"); throw e; } };
  const options = { sql, env, transaction, remote: remote.store, now: () => ms, prepare: async () => prepared(seed), bundle: async () => ({ authenticationRecord: { accessToken: "fixture-only", expiresAtMs: b.end + 100000 } }) };
  return { seed, db, sql, remote, options, state: new ProductionDayState(options), set: value => { ms = value; } };
}

test("all553 synthetic inputs preserve original A/B/C/D scores and TOP5 ranks with508 eligible", () => {
  const seed = inputFixture(), f = observations(seed), p = prepared(seed);
  const value = aggregateProduction(p, f.rows, `${date}T05:05:01.000Z`);
  const expected = buildIntradayModelTopSignal({ seed, quotesByCode: f.quotes, signalDate: date,
    collectionStartedAt: `${date}T05:00:01.000Z`, collectionCompletedAt: `${date}T05:00:01.210Z` });
  assert.equal(expected.status, "READY"); assert.equal(expected.collection.successful, 508);
  for (const model of value.delivery.models) assert.deepEqual(model.records, expected.top5[model.modelVersion].map(({ observationId: _id, ...row }) => { void _id; return row; }));
  for (const row of f.rows.filter(r => r.status === "AVAILABLE")) assert.deepEqual(row.scores, expected.records.find(r => r.ticker === row.code).scores);
  assert.equal(validateLiveDelivery(value.delivery, `${date}T05:06:00.000Z`), value.delivery);
  assert.equal(value.swing.selections.length, 20);
  assert.ok(value.swing.records.every(r => validateForecastRecord(r).valid && r.horizonTradingDays === 5
    && r.entryPolicy === "NEXT_CONFIRMED_SESSION_OPEN_STRICTLY_AFTER_ISSUANCE"
    && r.exitPolicy === "FIFTH_SESSION_CLOSE_INCLUDING_ENTRY" && r.observation.referencePrice === null
    && r.predictions.expectedReturn === null && r.eligibility.inputTimingEligible === false));
  assert.ok(!/"(?:price|rows|open|high|low|close|volume|accessToken)"/u.test(JSON.stringify(value)));
});

test("swing intent preserves TOP5 union and first issuance; invalid or missing price stays blocked", async () => {
  const seed = inputFixture(), f = observations(seed), remote = remoteFixture();
  const value = aggregateProduction(prepared(seed), f.rows, `${date}T05:05:01.000Z`);
  assert.deepEqual(buildCloudSwingIntent(value.evidence, value.delivery), value.swing);
  await persistCloudSwingIntent(remote.store, value.swing);
  await persistCloudSwingIntent(remote.store, value.swing);
  assert.equal(remote.values.size, 1);
  assert.ok(value.swing.records.every(r => r.createdAt === value.delivery.exportedAt && r.actualFill === null && r.costs.status === "UNRESOLVED"
    && r.eligibility.blockers.includes("OBSERVATION:MISSING_REFERENCE_PRICE")));
  const bad = structuredClone(value.swing); bad.records[0].observation.referencePrice = 1;
  await assert.rejects(persistCloudSwingIntent(remote.store, bad), /CONTRACT_INVALID/u);
  const changed = structuredClone(value.evidence); changed.observations[0].scores["A-v1"]++;
  assert.throws(() => buildCloudSwingIntent(changed, value.delivery), /SOURCE_INVALID/u);
});

test("one missing required input, duplicates, altered dates and future receipts block publication", () => {
  const seed = inputFixture(), f = observations(seed), p = prepared(seed);
  for (const mutation of [r => r.slice(1), r => [...r.slice(0, -1), r[0]], r => r.map((x, i) => i ? x : { ...x, status: "ERROR", scores: null }),
    r => r.map((x, i) => i ? x : { ...x, minuteReceivedAt: `${date}T05:05:00.001Z` }), r => r.map((x, i) => i ? x : { ...x, observedDate: seedDate }),
    r => r.map((x, i) => i ? x : { ...x, observedTime: "13:59:59" }), r => r.map((x, i) => i ? x : { ...x, observedTime: "14:00:02" }),
    r => r.map((x, i) => i ? x : { ...x, originalRecordHash: null })]) {
    assert.throws(() => aggregateProduction(p, mutation(f.rows), `${date}T05:06:00.000Z`), /LIVE_CLOUD_/u);
  }
});

test("adjacent production slots maintain the220ms grid,200ms worst-case spacing and strict cutoff", () => {
  let head = 0, count = 0; const slots = [];
  for (let i = 0; i < 553; i++) { const s = nextPairSlots({ now: b.start, head, count, date }); slots.push(s.quoteSlot.notBefore, s.minuteSlot.notBefore); head = s.head; count += 2; }
  assert.ok(slots.every((s, i) => !i || s - (slots[i - 1] + 20) >= 200));
  assert.ok(slots.at(-1) + 165 < b.end - 55000);
  assert.throws(() => nextPairSlots({ now: b.end, head, count, date }), /WINDOW_EXPIRED/u);
  assert.throws(() => nextPairSlots({ now: b.start, count: 1400, date }), /REQUEST_BUDGET/u);
});

test("normal-day allocations fit Free; current experimental accumulation is not a per-day requirement", () => {
  const budget = normalDayBudget(); assert.ok(Object.values(budget).every(v => v.total < v.limit));
  assert.equal(budget.workflowSteps.total, 320); assert.equal(budget.sqlRowsRead.total, 1500000); assert.equal(budget.sqlRowsWritten.total, 55000);
  assert.ok(PRODUCTION_BUDGET.workflowStorageGbMonths >= 71 * 65536 * 3 * 2 / 1e9, "retention reserve must include measured per-instance state, not only step outputs");
  assert.ok(PRODUCTION_BUDGET.workflowStorageGbMonths >= 5341184 * 3 * 2 / 1e9, "reserve the measured full-run footprint and three-day retention with headroom");
  assert.deepEqual(LIVE_CRONS, ["40,50 4 * * MON-FRI", "6,8,10 5 * * MON-FRI"]);
  assert.throws(() => assertProduction({ ...env, LIVE_PRODUCTION_ENABLED: "false" }), /DISABLED/u);
  assert.throws(() => checkCutover({}, b.start), /CUTOVER_BLOCKED/u);
  assert.throws(() => activationConfig({}, {}, b.start), /CUTOVER_BLOCKED/u);
  assert.throws(() => assertProduction({ ...env, LIVE_CUTOVER_RECEIPT_HASH: "" }), /DISABLED/u);
  const proof = Object.fromEntries(["workersFree", "accountUsageVerifiedAfterReset", "otherResourcesInventoried", "storageVerified", "retentionVerified",
    "pcTaskDisabled", "pcHostStopped", "oldLiveTriggersDisabled", "fullEligibleSetVerified", "privateRelayVerified", "authenticatedSiteVerified"].map(k => [k, true]));
  Object.assign(proof, { utcDay: "2026-10-19", checkedAt: new Date(b.start).toISOString() });
  assert.throws(() => activationConfig({}, proof, b.start), /swingRecordingVerified/u);
  assert.equal(activationConfig({}, { ...proof, swingRecordingVerified: true }, b.start).vars.LIVE_PRODUCER, "cloud");
});

test("real SQLite day state survives restart, preserves conflict/hash guards and bans raw data", async t => {
  const f = sandbox(t); await f.state.prepare(date, true);
  const reopened = new ProductionDayState(f.options);
  assert.equal(reopened.read("final").seedHash, f.seed.contentHash);
  assert.throws(() => reopened.write("final", { wrong: true }), /IMMUTABLE_CONFLICT/u);
  assert.throws(() => reopened.write("bad", { price: 1 }), /RAW_STORAGE/u);
  f.db.prepare("UPDATE docs SET body='{}' WHERE id='final'").run(); assert.throws(() => reopened.read("final"), /HASH_MISMATCH/u);
});

test("failed13:40 preparation may recover via a fresh13:59 read, but not at14:00", async t => {
  const f = sandbox(t); let ready = false, calls = 0;
  const state = new ProductionDayState({ ...f.options, prepare: async () => { calls++; if (!ready) throw new Error("LIVE_CLOUD_INPUT_NOT_READY"); return prepared(f.seed); } });
  f.set(b.start - 1200000); await assert.rejects(state.prepare(date, false), /INPUT_NOT_READY/u);
  ready = true; f.set(b.start - 50000); assert.equal((await state.prepare(date, true)).readiness, "READY"); assert.equal(calls, 2);
  const next = new ProductionDayState(f.options); f.set(b.start); await assert.rejects(next.prepare(date, true), /INPUT_LATE/u);
});

test("same symbol cannot be collected twice and failed/late lease never becomes normal output", async t => {
  const f = sandbox(t); await f.state.prepare(date, true); f.set(b.start);
  const first = await f.state.acquire(date, f.seed.records[0].code);
  await assert.rejects(f.state.acquire(date, f.seed.records[0].code), /ALREADY_RESERVED/u);
  assert.equal(first.minuteSlot.slot, first.quoteSlot.slot + 1);
  assert.throws(() => f.state.finish(date), /INCOMPLETE/u);
  f.set(b.end + 1); await assert.rejects(f.state.acquire(date, f.seed.records[1].code), /WINDOW_EXPIRED/u);
});

test("outbox freezes before failed relay; restart+retry delivers identical hashes without recollecting", async t => {
  const f = sandbox(t); await f.state.prepare(date, true);
  const observed = observations(f.seed).rows;
  for (const r of observed) f.state.write(`observation:${r.code}`, r);
  f.set(b.end + 1000); const first = f.state.finish(date);
  f.remote.failNext(); await assert.rejects(f.state.relay(date), /NETWORK_FAILED/u);
  const frozen = f.state.read("outbox"); f.set(b.end + 61001);
  const reopened = new ProductionDayState(f.options); assert.equal((await reopened.relay(date)).status, "PRIVATE_RELAY_VERIFIED");
  assert.deepEqual(reopened.read("outbox"), frozen);
  assert.equal((await readLatestPrivateLive(f.remote.store, { now: `${date}T05:10:00.000Z` })).deliveryHash, first.deliveryHash);
  const calls = f.remote.requests(); await reopened.relay(date); assert.equal(f.remote.requests(), calls);
});

test("missing SQL billing telemetry and quota exhaustion stop before further work", t => {
  const f = sandbox(t); f.state.meter.w = 34100;
  assert.throws(() => f.state.read("date"), /SQL_BUDGET/u);
  assert.doesNotThrow(() => f.state.status(), "reserved diagnostics remain available after collection admission stops");
  f.state.meter.w = 40000;
  assert.throws(() => f.state.status(), /SQL_BUDGET/u);
  assert.throws(() => new ProductionDayState({ ...f.options, sql: { ...f.sql, exec(query, ...args) { const c = f.sql.exec(query, ...args); return { toArray: () => c.toArray() }; } } }), /METER_CHANGED/u);
});

test("staged deployment cannot schedule or expose HTTP; no formula or existing Daily workflow changes", async () => {
  const config = JSON.parse(await fs.readFile(new URL("./wrangler.jsonc", import.meta.url), "utf8"));
  assert.equal(config.vars.LIVE_PRODUCTION_ENABLED, "false"); assert.equal(config.vars.LIVE_PRODUCER, "pc");
  assert.deepEqual(config.triggers.crons, []); assert.equal(config.workers_dev, false); assert.equal(config.preview_urls, false);
  const source = await fs.readFile(new URL("./src/production.mjs", import.meta.url), "utf8");
  assert.ok(source.includes('step.sleepUntil("1359 fresh EOD recheck"'));
  assert.ok(source.includes('step.sleepUntil("wait for absolute1400"'));
  assert.ok(!source.includes("workflow_dispatch"));
});

test("553-symbol eight-lease synthetic replay measures allocator span and SQL budget without API calls", async t => {
  const f = sandbox(t); await f.state.prepare(date, true); f.set(b.start);
  const readyRows = observations(f.seed).rows, active = []; let next = 0, last = b.start;
  const enqueue = async () => {
    const row = readyRows[next++], lease = await f.state.acquire(date, row.code);
    active.push({ row, lease, end: lease.minuteSlot.notBefore + 22 });
  };
  for (let i = 0; i < 8; i++) await enqueue();
  while (active.length) {
    active.sort((a, z) => a.end - z.end); const { row, lease, end } = active.shift(); f.set(end); last = end;
    const metadata = { ...row, observedTime: new Date(lease.quoteSlot.notBefore + 9 * 3600000).toISOString().slice(11, 19),
      quoteRequestedAt: new Date(lease.quoteSlot.notBefore).toISOString(), quoteReceivedAt: new Date(lease.quoteSlot.notBefore + 22).toISOString(),
      minuteRequestedAt: new Date(lease.minuteSlot.notBefore).toISOString(), minuteReceivedAt: new Date(end).toISOString() };
    const calls = [["quote", lease.quoteSlot], ["minute", lease.minuteSlot]].map(([kind, s]) => ({ kind, slot: s.slot, started: s.notBefore, completed: s.notBefore + 22, status: 200 }));
    f.state.complete(date, row.code, { metadata, calls });
    if (next < 553) await enqueue();
  }
  assert.ok(last - b.start < 245000, "synthetic22ms response replay, not a real network throughput claim");
  assert.ok(f.state.meter.w < 39000); assert.ok(f.state.meter.r < 1000000);
  f.set(b.end + 1000); f.state.finish(date);
  t.diagnostic(JSON.stringify({ syntheticOnly: true, symbols: next, collectionSpanMs: last - b.start,
    fakeSqlRowsReadUpper: f.state.meter.r, fakeSqlRowsWrittenUpper: f.state.meter.w, sqliteBytes: f.sql.databaseSize,
    realKisCalls: 0, billedCloudflareRowsMeasured: false }));
});

test("actual Workflow survives missing13:40 EOD and precreates70 fixed children after fresh13:59 readiness", async t => {
  let now = b.start - 1200000; t.mock.method(Date, "now", () => now);
  const batches = [], events = [], target = { async prepare(_date, final) {
    events.push(final ? "FINAL_INPUT" : "PREWARM"); if (!final) throw new Error("LIVE_CLOUD_INPUT_NOT_READY");
    assert.equal(now, b.start - 60000); return { codes: Array.from({ length: 553 }, (_, i) => String(100000 + i)) };
  }, async finish() { assert.ok(now > b.end); events.push("FINISH"); }, async relay() { events.push("RELAY"); return { status: "PRIVATE_RELAY_VERIFIED" }; }, async failure() { assert.fail("Unexpected workflow failure"); } };
  const bindings = { ...env, LIVE_DAYS: { idFromName: x => x, get: () => target }, LIVE: { async createBatch(defs) { assert.ok(now < b.start); batches.push(...defs); } } };
  const step = { async do(_name, _options, fn) { return fn(); }, async sleepUntil(_name, at) { now = Math.max(now, at.getTime()); }, async sleep() { now += 10000; } };
  const result = await new CloudLive(bindings).run({ payload: { mode: "day", date } }, step);
  assert.equal(result.status, "PRIVATE_RELAY_VERIFIED"); assert.equal(batches.length, 70);
  assert.equal(new Set(batches.map(d => d.id)).size, 70); assert.deepEqual(events, ["PREWARM", "FINAL_INPUT", "FINISH", "RELAY"]);
});

test("duplicate cron shares same parent ID; weekend/disabled state never schedules collection", async () => {
  const ids = [], bindings = { ...env, LIVE: { async create(d) { ids.push(d.id); if (ids.length > 1) throw new Error("duplicate"); }, async get() { return { async status() { return { status: "running" }; } }; } } };
  const event = { scheduledTime: b.start - 1200000 };
  await productionScheduled(event, bindings); await productionScheduled(event, bindings);
  assert.equal(ids[0], ids[1]);
  assert.equal((await productionScheduled(event, { ...bindings, LIVE_PRODUCTION_ENABLED: "false" })).status, "DISABLED");
  assert.equal((await productionScheduled({ scheduledTime: Date.parse("2026-10-18T04:40:00Z") }, bindings)).status, "WEEKEND");
});

test("async relay rejection reaches catch and failure-record error never masks first cause", async t => {
  const logs = []; t.mock.method(console, "error", value => logs.push(JSON.parse(value)));
  let recorded = null;
  const target = { async finish() {}, async relay() { throw new Error("PRIVATE_STORE_NETWORK_FAILED"); },
    async failure(code, stage) { recorded = { code, stage }; throw new Error("LIVE_CLOUD_SQL_BUDGET"); } };
  const bindings = { ...env, LIVE_DAYS: { idFromName: x => x, get: () => target } };
  const step = { async do(_name, _options, fn) { return fn(); } };
  await assert.rejects(new CloudLive(bindings).run({ payload: { mode: "relay", date } }, step), /PRIVATE_STORE_NETWORK_FAILED/u);
  assert.deepEqual(recorded, { code: "PRIVATE_STORE_NETWORK_FAILED", stage: "RELAY" });
  assert.deepEqual(logs, [{ event: "LIVE_CLOUD_FAILURE_RECORD_FAILED", primaryCode: "PRIVATE_STORE_NETWORK_FAILED", stage: "RELAY", recordingCode: "LIVE_CLOUD_SQL_BUDGET" }]);
});

test("reopen loses unused SQL credits conservatively and durable leases fence duplicate observation", async t => {
  const f = sandbox(t); await f.state.prepare(date, true); f.set(b.start);
  const leases = []; for (const r of f.seed.records.slice(0, 8)) leases.push(await f.state.acquire(date, r.code));
  const before = { ...f.state.meter }, reopened = new ProductionDayState(f.options);
  assert.ok(reopened.meter.r >= before.r && reopened.meter.w >= before.w);
  await assert.rejects(reopened.acquire(date, f.seed.records[0].code), /ALREADY_RESERVED/u);
  let settled = false; const queued = reopened.acquire(date, f.seed.records[8].code).then(v => { settled = true; return v; });
  await Promise.resolve(); assert.equal(settled, false);
  const lease = leases[0], row = observations(f.seed).rows[0]; f.set(lease.minuteSlot.notBefore + 22);
  const calls = [["quote", lease.quoteSlot], ["minute", lease.minuteSlot]].map(([kind, s]) => ({ kind, slot: s.slot, started: s.notBefore, completed: s.notBefore + 22, status: 200 }));
  const payload = { metadata: row, calls };
  reopened.complete(date, row.code, payload); await queued;
  reopened.complete(date, row.code, payload); // exact completion replay is idempotent
  const changed = structuredClone(payload); changed.metadata.scores["A-v1"]++;
  assert.throws(() => reopened.complete(date, row.code, changed), /IMMUTABLE_CONFLICT/u);
});

test("bundle failure closes durable reservation and does not strand later capacity", async t => {
  const f = sandbox(t); let calls = 0;
  const state = new ProductionDayState({ ...f.options, bundle: async () => { if (++calls === 1) throw new Error("LIVE_CLOUD_PIN_UNAVAILABLE"); return {}; } });
  await state.prepare(date, true); f.set(b.start);
  await assert.rejects(state.acquire(date, f.seed.records[0].code), /PIN_UNAVAILABLE/u);
  assert.equal(state.read(`observation:${f.seed.records[0].code}`).reason, "LIVE_CLOUD_PIN_UNAVAILABLE");
  assert.equal(f.db.prepare("SELECT completed FROM leases WHERE code=?").get(f.seed.records[0].code).completed, 1);
  assert.ok(await state.acquire(date, f.seed.records[1].code));
});

test("partial completion rollback preserves slots and immutable observation; failed SQL retains pessimistic prepaid cost", async t => {
  const f = sandbox(t); await f.state.prepare(date, true); f.set(b.start);
  const code = f.seed.records[0].code, lease = await f.state.acquire(date, code), row = observations(f.seed).rows[0];
  f.set(lease.minuteSlot.notBefore + 22);
  const calls = [["quote", lease.quoteSlot], ["minute", lease.minuteSlot]].map(([kind, s]) => ({ kind, slot: s.slot, started: s.notBefore, completed: s.notBefore + 22, status: 200 }));
  calls[1].slot++;
  assert.throws(() => f.state.complete(date, code, { metadata: row, calls }), /RATE_EVIDENCE_INVALID/u);
  assert.equal(f.db.prepare("SELECT body FROM slots WHERE slot=?").get(lease.quoteSlot.slot).body, null);
  assert.equal(f.state.read(`observation:${code}`), null);
  const before = { ...f.state.meter }, credit = { ...f.state.credit };
  assert.throws(() => f.state.q("SELECT missing_column FROM docs"));
  assert.ok(f.state.credit.r <= credit.r - 32 && f.state.credit.w <= credit.w - 16);
  assert.ok(f.state.meter.r >= before.r && f.state.meter.w >= before.w);
});

test("native synthetic harness cannot touch a normal day object or run while production is active", async t => {
  t.mock.method(Date, "now", () => Date.parse("2026-10-19T09:00:00Z"));
  const object = Object.create(LiveDay.prototype);
  object.ctx = { id: { toString: () => "normal-operational-day-id" } };
  object.env = { LIVE_ENABLED: "false", DIAGNOSTIC_ONLY: "true", LIVE_PRODUCTION_ENABLED: "false",
    LIVE_DAYS: { idFromName: name => ({ toString: () => name }) } };
  await assert.rejects(object.isolatedFixture("fixture-only", "create"), /FIXTURE_IDENTITY/u);
  object.env.LIVE_PRODUCTION_ENABLED = "true";
  await assert.rejects(object.isolatedFixture("fixture-only", "create"), /DISABLED_DURING_PRODUCTION/u);
});
