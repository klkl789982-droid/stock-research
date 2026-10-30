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
import { completeWithReceiptClock } from "./receipt-clock.mjs";

const date = "2026-10-19", seedDate = "2026-10-16", b = bounds(date);
const env = { LIVE_PRODUCTION_ENABLED: "true", LIVE_PRODUCER: "cloud", LIVE_CUTOVER_RECEIPT_HASH: "a".repeat(64) };
// Load the real Workflow implementation. Replace only Cloudflare base classes
// and the already separately tested shard transport shell, not orchestration.
let workflowSource = await fs.readFile(new URL("./src/production.mjs", import.meta.url), "utf8");
workflowSource = workflowSource.replace('import { DurableObject, WorkflowEntrypoint } from "cloudflare:workers";', 'class DurableObject { constructor(ctx,env){this.ctx=ctx;this.env=env;} } class WorkflowEntrypoint {constructor(env){this.env=env;}}');
workflowSource = workflowSource.replace('import { KisSlotShard } from "./slot-shard.mjs";', 'class KisSlotShard {}');
for (const relative of ["../production-state.mjs", "../production-core.mjs", "../production-fixture.mjs", "../core.mjs", "../relay-budget.mjs", "../batch-creation.mjs", "../watchdog.mjs", "../receipt-clock.mjs", "../../../lib/kis-eod-private-store.mjs", "../../../lib/private-live-execution-status.mjs"])
  workflowSource = workflowSource.replaceAll(JSON.stringify(relative), JSON.stringify(new URL(relative, new URL("./src/production.mjs", import.meta.url)).href));
const { CloudLive, LiveDay, productionScheduled, batchResult, assertIsolatedProductionFixture } = await import(`data:text/javascript;base64,${Buffer.from(workflowSource).toString("base64")}`);
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
function reconciliation(seed, changes = new Map(),size=4) {
  const batches = [];
  for (let i = 0; i < seed.records.length; i += size) {
    const codes = seed.records.slice(i, i + size).map(row => row.code), failures = codes.flatMap(code => changes.has(code) ? [{ code, reason: changes.get(code), failureStage: "LEASE_ACQUIRE" }] : []);
    batches.push({ id: `live-${date}-batch${i / size}`, codes, workflowStatus: "complete", attempted: codes.length,
      successful: codes.length - failures.length, failures });
  }
  const firstFailure = batches.flatMap(batch => batch.failures.map(row => ({ ...row, batchId: batch.id })))[0] ?? null;
  return { schemaVersion: 1, date, batches, firstFailure };
}
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
    r => r.map((x, i) => i ? x : { ...x, minuteReceivedAt: `${date}T06:30:00.001Z` }), r => r.map((x, i) => i ? x : { ...x, observedDate: seedDate }),
    r => r.map((x, i) => i ? x : { ...x, observedTime: "13:59:59" }), r => r.map((x, i) => i ? x : { ...x, observedTime: "14:00:02" }),
    r => r.map((x, i) => i ? x : { ...x, originalRecordHash: null })]) {
    assert.throws(() => aggregateProduction(p, mutation(f.rows), `${date}T05:06:00.000Z`), /LIVE_CLOUD_/u);
  }
});

test("pinned exclusions need no live quote while eligible quote validation and complete Universe remain strict", async t => {
  const f = sandbox(t), seed = f.seed, input = seed.records.at(-1);
  const excluded = productionObservation({ code: input.code, input, seedContext: seed, signalDate: date });
  assert.equal(excluded.status, "EXCLUDED"); assert.equal(excluded.scores, null);
  assert.equal(excluded.observedDate, undefined); assert.equal(excluded.exclusionBasis, "PINNED_EOD_INELIGIBLE");
  const timing = { quoteRequestedAt: `${date}T05:00:01.000Z`, quoteReceivedAt: `${date}T05:00:01.010Z`, minuteRequestedAt: `${date}T05:00:01.200Z`, minuteReceivedAt: `${date}T05:00:01.210Z` };
  assert.throws(() => productionObservation({ code: seed.records[0].code, input: seed.records[0], seedContext: seed, signalDate: date, timing,
    quote: { rt_cd: "0", output: { stck_prpr: "0" } } }), /KIS_INVALID_QUOTE/u);
  await f.state.prepare(date, true);
  const rows = observations(seed).rows;
  for (const row of rows) f.state.write(`observation:${row.code}`, row);
  f.state.reconcileBatches(date, reconciliation(seed)); f.set(b.start + 360000);
  const delivery = f.state.finish(date);
  assert.equal(delivery.models.length, 4);
  assert.ok(delivery.models.every(model => model.records.length === 5 && model.records.every(row => seed.records.find(r => r.code === row.ticker).eligible)));
  const evidence = f.state.read("outbox").evidence;
  assert.equal(evidence.observations.length, 553);
  assert.equal(evidence.observations.filter(row => row.status === "EXCLUDED").length, 45);
  assert.equal(evidence.observations.filter(row => row.status === "AVAILABLE").length, 508);
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
  assert.equal(budget.workflowSteps.total, 620); assert.equal(budget.sqlRowsRead.total, 1520000); assert.equal(budget.sqlRowsWritten.total, 57000);
  assert.ok(PRODUCTION_BUDGET.workflowStorageGbMonths >= 140 * 65536 * 3 * 2 / 1e9, "retention reserve must include measured per-instance state, not only step outputs");
  assert.ok(PRODUCTION_BUDGET.workflowStorageGbMonths >= 5341184 * 3 * 2 / 1e9, "reserve the measured full-run footprint and three-day retention with headroom");
  assert.deepEqual(LIVE_CRONS, ["40,50 4 * * MON-FRI", "6,8,10 5 * * MON-FRI", "31,33,35 6 * * MON-FRI","0,5,15,25,30,35,40,45,59 4-6 * * MON-FRI"]);
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
  assert.throws(() => f.state.finish(date), /CHILD_RESULTS_UNVERIFIED/u);
  f.set(b.end + 1); await assert.rejects(f.state.acquire(date, f.seed.records[1].code), /WINDOW_EXPIRED/u);
});

test("outbox freezes before failed relay; restart+retry delivers identical hashes without recollecting", async t => {
  const f = sandbox(t); await f.state.prepare(date, true);
  const observed = observations(f.seed).rows;
  for (const r of observed) f.state.write(`observation:${r.code}`, r);
  f.state.reconcileBatches(date, reconciliation(f.seed));
  f.set(b.end + 1000); const first = f.state.finish(date);
  f.remote.failNext(); await assert.rejects(f.state.relay(date), /NETWORK_FAILED/u);
  const frozen = f.state.read("outbox"); f.set(b.end + 61001);
  const reopened = new ProductionDayState(f.options); assert.equal((await reopened.relay(date)).status, "PRIVATE_RELAY_VERIFIED");
  assert.deepEqual(reopened.read("outbox"), frozen);
  assert.equal((await readLatestPrivateLive(f.remote.store, { now: `${date}T06:40:00.000Z` })).deliveryHash, first.deliveryHash);
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
  f.set(b.end + 1000); f.state.reconcileBatches(date, reconciliation(f.seed)); f.state.finish(date);
  t.diagnostic(JSON.stringify({ syntheticOnly: true, symbols: next, collectionSpanMs: last - b.start,
    fakeSqlRowsReadUpper: f.state.meter.r, fakeSqlRowsWrittenUpper: f.state.meter.w, sqliteBytes: f.sql.databaseSize,
    realKisCalls: 0, billedCloudflareRowsMeasured: false }));
});
test("all553 completions with a2ms receiver-clock lag preserve full TOP5/model/swing contracts", async t => {
  const f=sandbox(t);await f.state.prepare(date,true);f.set(b.start);let waits=0;
  f.state.wait=async ms=>{assert.equal(f.state.controlDepth,0);f.set(f.state.now()+ms);waits++;};
  const readyRows=observations(f.seed).rows;
  for(const row of readyRows){
    const lease=await f.state.acquire(date,row.code),stamp=n=>new Date(n).toISOString();
    f.set(lease.minuteSlot.notBefore);
    const metadata={...row,observedTime:new Date(lease.quoteSlot.notBefore+9*3600000).toISOString().slice(11,19),
      quoteRequestedAt:stamp(lease.quoteSlot.notBefore),quoteReceivedAt:stamp(lease.quoteSlot.notBefore+2),minuteRequestedAt:stamp(lease.minuteSlot.notBefore),minuteReceivedAt:stamp(lease.minuteSlot.notBefore+2)};
    const calls=[["quote",lease.quoteSlot],["minute",lease.minuteSlot]].map(([kind,s])=>({kind,slot:s.slot,started:s.notBefore,completed:s.notBefore+2,status:200}));
    await completeWithReceiptClock(f.state,date,row.code,{metadata,calls});
    assert.equal(f.state.read(`observation:${row.code}`).minuteReceivedAt,metadata.minuteReceivedAt);
  }
  assert.equal(waits,553);f.state.reconcileBatches(date,reconciliation(f.seed,new Map(),4));
  const delivery=f.state.finish(date);assert.equal(delivery.models.reduce((n,m)=>n+m.records.length,0),20);
  for(const model of delivery.models){const expected=readyRows.filter(r=>r.status==="AVAILABLE").sort((a,b)=>b.scores[model.modelVersion]-a.scores[model.modelVersion]||a.code.localeCompare(b.code)).slice(0,5);
    assert.deepEqual(model.records.map(r=>[r.ticker,r.score]),expected.map(r=>[r.code,r.scores[model.modelVersion]]));}
  assert.equal(f.state.read("outbox").swing.selections.length,20);assert.ok(f.state.meter.w<40000);
});

test("actual Workflow precreates139 paced fixed children and uses durable outcomes without status fan-in", async t => {
  let now = b.start - 1200000; t.mock.method(Date, "now", () => now);
  const batches = [], events = [], metadata = [], target = { async publishExecution(_date,event) { metadata.push(event); }, async prepare(_date, final) {
    events.push(final ? "FINAL_INPUT" : "PREWARM"); if (!final) throw new Error("LIVE_CLOUD_INPUT_NOT_READY");
    assert.equal(now, b.start - 60000); return { codes: Array.from({ length: 553 }, (_, i) => String(100000 + i)),batchSize:4 };
  }, async reconcileJournal(){events.push("RECONCILE");return{ready:true,firstFailure:null};},
  async finish() { assert.ok(now >= b.start+360000); events.push("FINISH"); }, async relay() { events.push("RELAY"); return { status: "PRIVATE_RELAY_VERIFIED" }; }, async failure() { assert.fail("Unexpected workflow failure"); } };
  const bindings = { ...env, LIVE_DAYS: { idFromName: x => x, get: () => target }, LIVE: { async createBatch({instances:defs}) { assert.ok(now < b.start);assert.ok(defs.length<=50); batches.push(...defs);return{created:defs.map(d=>({id:d.id})),errors:[]}; },
    async get() { assert.fail("parent must never fan in Workflow status lookups"); } } };
  const step = { async do(_name, _options, fn) { return fn(); }, async sleepUntil(_name, at) { now = Math.max(now, at.getTime()); }, async sleep() { now += 10000; } };
  const result = await new CloudLive(bindings).run({ payload: { mode: "day", date } }, step);
  assert.equal(result.status, "PRIVATE_RELAY_VERIFIED"); assert.equal(batches.length, 139);
  assert.equal(new Set(batches.map(d => d.id)).size, 139); assert.deepEqual(events, ["PREWARM", "FINAL_INPUT", "RECONCILE", "FINISH", "RELAY"]);
  assert.deepEqual(metadata,["PREPARATION","READY","VALIDATED","DELIVERED"]);
  assert.equal(batches.filter(d=>d.params.reportStatus).length,1,"only one batch may publish progress metadata");
});

test("four-symbol journals survive restart, reject conflict/missing inputs and preserve old eight-symbol receipts",async t=>{
 const f=sandbox(t);await f.state.prepare(date,true);const run=`live-${date}`,codes=f.seed.records.map(r=>r.code);
 assert.equal(f.state.read("final").batchSize,4);assert.equal(f.state.reconcileJournal(date,run).pendingBatches,139);
 for(let i=0;i<codes.length;i+=4){const group=codes.slice(i,i+4);f.state.recordBatchResult(date,run,group,{status:"complete",output:{attempted:group.length,successful:group.length,failed:[]}});}
 const reopened=new ProductionDayState(f.options),ready=reopened.reconcileJournal(date,run);assert.equal(ready.ready,true);assert.equal(ready.totalBatches,139);assert.equal(ready.firstFailure,null);
 reopened.recordBatchResult(date,run,codes.slice(0,4),{status:"complete",output:{attempted:4,successful:4,failed:[]}});
 assert.throws(()=>reopened.recordBatchResult(date,run,codes.slice(0,4),{status:"errored",reason:"KIS_HTTP_500"}),/IMMUTABLE_CONFLICT/);
 assert.throws(()=>reopened.finish(date),/COMPLETION_MISMATCH/);
 const old=sandbox(t);old.state.write("final",prepared(old.seed));
 for(let i=0;i<codes.length;i+=8){const group=codes.slice(i,i+8);old.state.recordBatchResult(date,run,group,{status:"complete",output:{attempted:group.length,successful:group.length,failed:[]}});}
 assert.equal(old.state.reconcileJournal(date,run).totalBatches,70);
});

test("final deadline records absent journals as failures without pretending the children completed",async t=>{
 const f=sandbox(t);await f.state.prepare(date,true);const run=`live-${date}`;
 assert.equal(f.state.reconcileJournal(date,run).ready,false);f.set(b.end+1);
 const result=f.state.reconcileJournal(date,run,true);assert.equal(result.ready,true);assert.equal(result.pendingBatches,139);
 assert.equal(result.firstFailure.reason,"LIVE_CLOUD_CHILD_RESULT_MISSING");assert.throws(()=>f.state.finish(date),/CHILD_RESULT_MISSING/);
 const record=f.state.freezeExecution(date,"FAILURE_DAY","ERRORED",{code:"LIVE_CLOUD_CHILD_RESULT_MISSING",stage:"BATCH_COLLECTION"});
 assert.equal(record.collection.failed,553);assert.equal(record.collection.missing,0);assert.equal(record.delivery.verified,false);
});

test("rate rejection keeps exact non-secret cause and never accepts an over20ms request",async t=>{
 const f=sandbox(t);await f.state.prepare(date,true);f.set(b.start);const code=f.seed.records[0].code,lease=await f.state.acquire(date,code);
 f.set(lease.minuteSlot.notBefore+1000);const started=lease.quoteSlot.notBefore+21;
 assert.throws(()=>f.state.complete(date,code,{metadata:{code,rawPricesStored:false,reason:"DIAG_COLLECTION_DEADLINE"},calls:[{slot:lease.quoteSlot.slot,kind:"quote",started,completed:started+1,status:200}]}),/RATE_EVIDENCE_INVALID/);
 assert.equal(f.state.read(`rate-rejection:${code}`).issue,"START_AFTER_SLOT");assert.equal(f.state.read(`observation:${code}`),null);
});

test("late relay waits without collecting; approved1531 cron is delivery-only",async()=>{
 let observations=0;const target={status:async()=>({outbox:false}),reconcileJournal:async()=>({ready:false}),finish:async()=>{observations++;},relay:async()=>{observations++;},publishExecution:async()=>{observations++;}};
 const result=await new CloudLive({...env,LIVE_DAYS:{idFromName:x=>x,get:()=>target}}).run({payload:{mode:"relay",date,relaySlot:"31"}},{do:(_n,_o,fn)=>fn()});
 assert.equal(result.status,"WAITING_FOR_BATCHES");assert.equal(observations,0);
 const created=[];await productionScheduled({scheduledTime:Date.parse(`${date}T06:31:00Z`)},{...env,LIVE:{create:async d=>created.push(d)}});
 assert.equal(created[0].params.mode,"relay");assert.equal(created[0].params.relaySlot,"31");
});

test("shared watch cron dispatches only fixed watch slots, not the day or collection workflow",async()=>{
 const calls=[],bindings={...env,LIVE_DAYS:{idFromName:x=>x,get:()=>({watch:async(...args)=>calls.push(args)})},LIVE:{create:async()=>assert.fail("watch dispatch cannot create a collector")}};
 const cron="0,5,15,25,30,35,40,45,59 4-6 * * MON-FRI";
 await productionScheduled({cron,scheduledTime:Date.parse(`${date}T05:15:00Z`)},bindings);assert.equal(calls[0][1],"1415");
 assert.equal((await productionScheduled({cron,scheduledTime:Date.parse(`${date}T04:05:00Z`)},bindings)).status,"WATCH_UNUSED_MINUTE");assert.equal(calls.length,1);
});

test("three exhausted early relay attempts cannot consume the approved close-time retry budget",async t=>{
 const f=sandbox(t);await f.state.prepare(date,true);
 // Already frozen synthetic result: only attempt bookkeeping and immutable
 // transfer are exercised here; never manufacture operational observations.
 const rows=observations(f.seed).rows,value=aggregateProduction(prepared(f.seed),rows,`${date}T05:06:00.000Z`);
 f.state.write("outbox",value);f.state.write("relay-attempt",{count:3,next:0},true);
 f.set(b.start+600000);await assert.rejects(f.state.relay(date),/RELAY_BACKOFF/);
 f.set(b.end+60000);f.remote.failNext();await assert.rejects(f.state.relay(date),/NETWORK_FAILED/);
 assert.equal(f.state.read("relay-late-attempt").count,1);assert.equal(f.state.read("relay-attempt").count,3);
 f.set(b.end+180000);const reopened=new ProductionDayState(f.options),delivered=await reopened.relay(date);
 assert.equal(delivered.status,"PRIVATE_RELAY_VERIFIED");assert.equal(delivered.deliveryHash,value.delivery.deliveryHash);
 assert.equal(reopened.read("relay-late-attempt").count,2);assert.equal(reopened.read("outbox").delivery.exportedAt,value.delivery.exportedAt);
 const blocked=sandbox(t);await blocked.state.prepare(date,true);blocked.state.write("outbox",value);blocked.set(b.end+300000);
 blocked.state.write("relay-late-attempt",{count:4,next:0},true);await assert.rejects(blocked.state.relay(date),/RELAY_BACKOFF/);
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
  const target = { async publishExecution() {}, async status(){return{outbox:true};},async finish() {}, async relay() { throw new Error("PRIVATE_STORE_NETWORK_FAILED"); },
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

test("bundle and diagnostic write failures still close the durable lease and settle queued work", async t => {
  const f = sandbox(t); const code=f.seed.records[0].code;let rejectBundle;
  const logs=[];t.mock.method(console,"error",value=>logs.push(JSON.parse(value)));
  const state=new ProductionDayState({...f.options,bundle:async(_date,_prepared,ticker)=>{
    if(ticker===code)return new Promise((_resolve,reject)=>{rejectBundle=reject;});return {};
  }});
  await state.prepare(date,true); f.set(b.start);
  const write=state.write.bind(state);
  state.write=(id,...args)=>{if(id===`observation:${code}`)throw new Error("LIVE_CLOUD_STORAGE_BUDGET");return write(id,...args);};
  const first=assert.rejects(state.acquire(date,code),/PIN_UNAVAILABLE/);
  for(const row of f.seed.records.slice(1,8))await state.acquire(date,row.code);
  const queued=state.acquire(date,f.seed.records[8].code);
  assert.equal(state.pending.size,1,"ninth symbol must actually wait behind eight durable leases");
  rejectBundle(new Error("LIVE_CLOUD_PIN_UNAVAILABLE"));await first;
  assert.equal(f.db.prepare("SELECT completed FROM leases WHERE code=?").get(code).completed,1);
  assert.equal(state.read(`observation:${code}`),null,"missing evidence must not become a successful observation");
  await assert.rejects(state.acquire(date,code),/ALREADY_RESERVED/);
  assert.ok(await queued);assert.equal(state.pending.size,0);
  assert.deepEqual(logs,[{event:"LIVE_BUNDLE_FAILURE_RECORD_FAILED",primaryCode:"LIVE_CLOUD_PIN_UNAVAILABLE",recordingCode:"LIVE_CLOUD_STORAGE_BUDGET"}]);
  assert.throws(()=>state.finish(date),/CHILD_RESULTS_UNVERIFIED/);
});

test("final EOD failure retains the exact input cause instead of a generic wrapper", async t => {
  let now=b.start-1200000;t.mock.method(Date,"now",()=>now);
  const recorded=[],target={prepare:async()=>{throw new Error("DIAG_EOD_STATUS_INCONSISTENT");},publishExecution:async()=>{},failure:async(code,stage)=>{recorded.push({code,stage});}};
  const bindings={...env,LIVE_DAYS:{idFromName:x=>x,get:()=>target}};
  const step={do:(_n,_o,fn)=>fn(),sleepUntil:async(_n,at)=>{now=Math.max(now,at.getTime());},sleep:async()=>{now+=10000;}};
  await assert.rejects(new CloudLive(bindings).run({payload:{mode:"day",date}},step),/DIAG_EOD_STATUS_INCONSISTENT/);
  assert.deepEqual(recorded,[{code:"DIAG_EOD_STATUS_INCONSISTENT",stage:"FINAL_INPUT"}]);
});

test("a recovery batch cannot publish progress into the regular execution metadata", async t => {
  t.mock.method(Date,"now",()=>b.start+1000);let publications=0;
  const target={publishExecution:async()=>{publications++;},recordBatchResult:async()=>{}};
  const bindings={...env,LIVE_DAYS:{idFromName:x=>x,get:()=>target},LIVE_BATCHES:{idFromName:x=>x,get:()=>({fetch:async()=>Response.json({records:[{code:"100000",status:"AVAILABLE"}]})})}};
  const result=await new CloudLive(bindings).run({payload:{mode:"batch",date,runId:`live-${date}-recovery-test`,codes:["100000"],reportStatus:true}},{do:(_n,_o,fn)=>fn()});
  assert.equal(result.successful,1);assert.equal(publications,0);
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

test("terminal observation storage failure releases one of eight leases for the next queued symbol", async t => {
  const f = sandbox(t); await f.state.prepare(date, true); f.set(b.start);
  const leases = [];
  for (const record of f.seed.records.slice(0, 8)) leases.push(await f.state.acquire(date, record.code));
  const queued = f.state.acquire(date, f.seed.records[8].code), code = f.seed.records[0].code, row = observations(f.seed).rows[0], lease = leases[0];
  f.set(lease.minuteSlot.notBefore + 22);
  const calls = [["quote", lease.quoteSlot], ["minute", lease.minuteSlot]].map(([kind, slot]) => ({ kind, slot: slot.slot,
    started: slot.notBefore, completed: slot.notBefore + 22, status: 200 }));
  const write = f.state.write.bind(f.state);
  f.state.write = (id, value, mutable) => id === `observation:${code}` ? (() => { throw new Error("LIVE_CLOUD_STORAGE_BUDGET"); })() : write(id, value, mutable);
  assert.throws(() => f.state.complete(date, code, { metadata: row, calls }), /STORAGE_BUDGET/u);
  assert.equal(f.db.prepare("SELECT completed FROM leases WHERE code=?").get(code).completed, 1);
  assert.ok(await queued);
});

test("same-day recovery adopts only immutable pre-1400 input and keeps late observations inside the close bound", async t => {
  const primary = sandbox(t); await primary.state.prepare(date, true);
  const source = primary.state.recoverySource(date), recovery = sandbox(t, primary.seed);
  recovery.set(b.start + 60 * 60 * 1000 + 5000);
  assert.deepEqual(recovery.state.adoptPrepared(date, source), source);
  assert.throws(() => recovery.state.adoptPrepared(date, { ...source, readyAt: new Date(b.start + 1).toISOString() }), /RECOVERY_INPUT_INVALID/u);
  const delayed = observations(primary.seed).rows.map(row => ({ ...row, observedTime: "15:00:01", quoteRequestedAt: `${date}T06:00:01.000Z`,
    quoteReceivedAt: `${date}T06:00:01.010Z`, minuteRequestedAt: `${date}T06:00:01.200Z`, minuteReceivedAt: `${date}T06:00:01.210Z` }));
  for (const row of delayed) recovery.state.write(`observation:${row.code}`, row);
  const result = reconciliation(primary.seed), runId = `live-${date}-recovery-test`;
  result.runId = runId; result.batches = result.batches.map((batch, index) => ({ ...batch, id: `${runId}-batch${index}` }));
  recovery.state.reconcileBatches(date, result);
  assert.equal(recovery.state.finish(date).models[0].officialSignalTime, "14:00:00");
});

test("native synthetic harness is isolated, production-compatible off-window and blocked during observation", async t => {
  t.mock.method(Date, "now", () => Date.parse("2026-10-19T09:00:00Z"));
  const object = Object.create(LiveDay.prototype);
  object.ctx = { id: { toString: () => "normal-operational-day-id" } };
  object.env = { ...env, LIVE_ENABLED: "false", DIAGNOSTIC_ONLY: "true",
    LIVE_DAYS: { idFromName: name => ({ toString: () => name }) } };
  await assert.rejects(object.isolatedFixture("fixture-only", "create"), /FIXTURE_IDENTITY/u);
  assert.doesNotThrow(() => assertIsolatedProductionFixture(object.env, Date.parse("2026-10-19T06:36:00Z")));
  assert.throws(() => assertIsolatedProductionFixture(object.env, Date.parse("2026-10-19T05:00:00Z")), /WINDOW_EXCLUDED/u);
});

test("frozen stage metadata is price-free, immutable across restarts and leaves result pointers alone",async t=>{
  const f=sandbox(t);await f.state.prepare(date,true);f.set(b.end+1000);
  const row=observations(f.seed).rows[0];f.state.write(`observation:${row.code}`,row);
  f.state.failure("LIVE_CLOUD_SQL_BUDGET","FINALIZE");
  const before={...f.state.cursorUsage},r=f.state.freezeExecution(date,"RECONCILE","ERRORED");
  assert.equal(r.collection.available,1);assert.equal(r.collection.missing,552);assert.equal(r.collection.requiredMissing,507);
  assert.equal(r.error.code,"LIVE_CLOUD_SQL_BUDGET");assert.equal(r.input.finalReady,true);
  assert.equal(f.state.read("outbox"),null);assert.equal(f.state.read("receipt"),null);assert.equal(f.remote.values.size,0);
  assert.ok(!/"(?:price|rows|open|high|low|close|volume|accessToken)"/u.test(JSON.stringify(r)));
  f.set(b.end+90000);assert.deepEqual(new ProductionDayState(f.options).freezeExecution(date,"RECONCILE","ERRORED"),r);
  t.diagnostic(JSON.stringify({metadataOnly:true,nativeLocalCursorBefore:before,nativeLocalCursorAfter:f.state.cursorUsage}));
});

test("failed child inventory never double-counts already valid observations or prevents error publication",async t=>{
  const f=sandbox(t);await f.state.prepare(date,true);f.set(b.end+1000);
  const rows=observations(f.seed).rows;
  for(const row of rows.slice(0,8))f.state.write(`observation:${row.code}`,row);
  const inventory=reconciliation(f.seed);
  inventory.batches=inventory.batches.map(batch=>({...batch,workflowStatus:"errored",attempted:0,successful:0,
    failures:batch.codes.map(code=>({code,reason:"LIVE_CLOUD_CHILD_ERRORED",failureStage:"UNKNOWN"}))}));
  inventory.firstFailure={...inventory.batches[0].failures[0],batchId:inventory.batches[0].id};
  f.state.reconcileBatches(date,inventory);f.state.failure("LIVE_CLOUD_CHILD_ERRORED","BATCH_COLLECTION");
  const result=f.state.freezeExecution(date,"FAILURE_DAY","ERRORED");
  assert.equal(result.collection.available,8);assert.equal(result.collection.failed,545);assert.equal(result.collection.missing,0);
  assert.equal(result.validation.outboxFrozen,false);assert.throws(()=>f.state.finish(date),/CHILD_ERRORED/);
});

test("COMPLETE child failures and queued restarts remain failures instead of disappearing behind finalize",()=>{
  const complete={id:`live-${date}-batch0`,params:{codes:["100000","100001"]}};
  assert.deepEqual(batchResult(complete,{status:"COMPLETE",output:{attempted:2,successful:1,failed:[{code:"100001",reason:"LIVE_CLOUD_SQL_BUDGET"}]}}),
    {id:complete.id,codes:complete.params.codes,workflowStatus:"complete",attempted:2,successful:1,failures:[{code:"100001",reason:"LIVE_CLOUD_SQL_BUDGET",failureStage:"UNKNOWN"}]});
  assert.deepEqual(batchResult(complete,{status:"queued"}).failures,
    complete.params.codes.map(code=>({code,reason:"LIVE_CLOUD_CHILD_NOT_COMPLETE",failureStage:"UNKNOWN"})));
  assert.ok(batchResult(complete,{status:"complete",output:{attempted:2,successful:2,failed:[{code:"999999",reason:"KIS_HTTP_500"}]}})
    .failures.every(row=>row.reason==="LIVE_CLOUD_CHILD_OUTPUT_INVALID"));
});

test("batch reconciliation accounts for unleased failures and preserves the first cause across finalize and relay",async t=>{
  const f=sandbox(t);await f.state.prepare(date,true);const rows=observations(f.seed).rows,failedCode=rows[1].code;
  f.state.write(`observation:${rows[0].code}`,rows[0]);
  const evidence=reconciliation(f.seed,new Map([[failedCode,"LIVE_CLOUD_SQL_BUDGET"]]));
  f.state.reconcileBatches(date,evidence);f.state.failure("LIVE_CLOUD_SQL_BUDGET","BATCH_COLLECTION");
  f.state.failure("LIVE_CLOUD_INCOMPLETE","FINALIZE");f.state.failure("LIVE_CLOUD_INCOMPLETE","RELAY");
  f.set(b.end+1000);
  assert.throws(()=>f.state.finish(date),/LIVE_CLOUD_SQL_BUDGET/u);
  const status=f.state.incidentStatus();
  assert.deepEqual(status.failed,[{code:failedCode,reason:"LIVE_CLOUD_SQL_BUDGET",failureStage:"LEASE_ACQUIRE"}]);
  assert.equal(status.missing.length,551);assert.equal(status.lastFailure.code,"LIVE_CLOUD_SQL_BUDGET");
  const record=f.state.freezeExecution(date,"FAILURE_RELAY06","RUNNING",{code:"LIVE_CLOUD_INCOMPLETE",stage:"RELAY"});
  assert.deepEqual(record.error,{code:"LIVE_CLOUD_SQL_BUDGET",stage:"BATCH_COLLECTION"});
  assert.equal(record.collection.available,1);assert.equal(record.collection.failed,1);assert.equal(record.collection.missing,551);
});

test("day parent rejects COMPLETE children with failed output before finalize",async t=>{
  let now=b.start-1200000;t.mock.method(Date,"now",()=>now);const definitions=[];let finishCalled=false,recorded=null;
  const target={async publishExecution(){},async prepare(_date,final){if(!final)throw Error("LIVE_CLOUD_INPUT_NOT_READY");return{codes:Array.from({length:553},(_,i)=>String(100000+i))};},
    async failure(code,stage){recorded??={code,stage};return recorded;},async reconcileJournal(){return{ready:true,firstFailure:{reason:"LIVE_CLOUD_SQL_BUDGET"}};},async finish(){finishCalled=true;},async relay(){assert.fail("relay must not run");}};
  const bindings={...env,LIVE_DAYS:{idFromName:x=>x,get:()=>target},LIVE:{async createBatch({instances:rows}){definitions.push(...rows);return{created:rows.map(d=>({id:d.id})),errors:[]};},async get(id){const d=definitions.find(row=>row.id===id);
    return{async status(){const failed=id.endsWith("batch1")?[{code:d.params.codes[0],reason:"LIVE_CLOUD_SQL_BUDGET"}]:[];return{status:"complete",output:{attempted:d.params.codes.length,successful:d.params.codes.length-failed.length,failed}};}};}}};
  const step={do:(_n,_o,fn)=>fn(),sleepUntil:async(_n,at)=>{now=Math.max(now,at.getTime());},sleep:async()=>{now+=10000;}};
  await assert.rejects(new CloudLive(bindings).run({payload:{mode:"day",date}},step),/LIVE_CLOUD_SQL_BUDGET/u);
  assert.deepEqual(recorded,{code:"LIVE_CLOUD_SQL_BUDGET",stage:"BATCH_COLLECTION"});assert.equal(finishCalled,false);
});

test("metadata-only reconciliation never prepares, collects, freezes result or relays result",async()=>{
  const calls=[];const target={async publishExecution(...args){calls.push(args);return{status:"EXECUTION_METADATA_STORED"};}};
  const bindings={...env,LIVE_DAYS:{idFromName:x=>x,get:()=>target},LIVE:{async get(id){assert.equal(id,`live-${date}`);return{async status(){return{status:"errored",error:{name:"WorkflowInternalError"}};}};}}};
  const result=await new CloudLive(bindings).run({payload:{mode:"publish-execution-status",date}},{do:(_n,_o,fn)=>fn()});
  assert.equal(result.status,"EXECUTION_METADATA_STORED");assert.deepEqual(calls,[[date,"RECONCILE","ERRORED"]]);
});

test("collection starts before telemetry and telemetry rejection never masks collector failure",async t=>{
  t.mock.method(Date,"now",()=>b.start+1000);t.mock.method(console,"error",()=>{});const calls=[];
  const target={async publishExecution(){calls.push("metadata");throw Error("PRIVATE_STORE_NETWORK_FAILED");},async failure(code){calls.push(code);}};
  const bindings={...env,LIVE_DAYS:{idFromName:x=>x,get:()=>target},LIVE_BATCHES:{idFromName:x=>x,get:()=>({fetch:async()=>{calls.push("collector");throw Error("LIVE_CLOUD_BATCH_FAILED");}})}};
  await assert.rejects(new CloudLive(bindings).run({payload:{mode:"batch",date,codes:["100000"],reportStatus:true}},{sleepUntil:async()=>{},do:(_n,_o,fn)=>fn()}),/LIVE_CLOUD_BATCH_FAILED/);
  assert.deepEqual(calls,["collector","metadata","LIVE_CLOUD_BATCH_FAILED"]);
});
