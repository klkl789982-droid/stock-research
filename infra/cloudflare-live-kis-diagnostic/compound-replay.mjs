import fs from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { ProductionDayState } from "./production-state.mjs";
import { completeWithReceiptClock, extraWithReceiptClock } from "./receipt-clock.mjs";
import { bounds, productionObservation, kst } from "./production-core.mjs";
import { fixture } from "../cloudflare-live-free-probe/core.mjs";
import { intradaySeedHash } from "../../lib/intraday-market-seed.mjs";
import { hashIntradayModelTop as hash, buildIntradayModelTopSignal } from "../../lib/intraday-model-top-official-signal.mjs";
import { readLatestPrivateLive } from "../../lib/private-live-delivery.mjs";

// LOCAL ONLY. Execute the actual shard retry/slot/transport/model code together
// with SQLite day-state and 139 concurrent four-symbol batches. Replace only
// platform base class, network and clocks. No credential, production URL or
// filesystem persistence is available to this replay. Row costs are MODELLED,
// not native Cloudflare cursors/billing; virtual time is not a latency forecast.
let source = await fs.readFile(new URL("./src/slot-shard.mjs", import.meta.url), "utf8");
source = source.replace('import { DurableObject } from "cloudflare:workers";', 'class DurableObject { constructor(ctx,env){this.ctx=ctx;this.env=env;} }');
source = source.replace("assertDiagnostic, edgeFetch,", "assertDiagnostic,");
source = source.replace("const sleep = ms => new Promise(r => setTimeout(r, ms));", "");
source = source.replace("export class KisSlotShard extends DurableObject", "export function createFixtureShard({Date,sleep,edgeFetch}) { return class KisSlotShard extends DurableObject");
source += "\n}\n";
for (const relative of ["../../../lib/kis-api-client-core.mjs", "../../../lib/intraday-model-top-official-signal.mjs", "../core.mjs"])
  source = source.replaceAll(JSON.stringify(relative), JSON.stringify(new URL(relative, new URL("./src/slot-shard.mjs", import.meta.url)).href));
const { createFixtureShard } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);

function inputs(date, seedDate) {
  const records = Array.from({ length: 553 }, (_, i) => ({ code: String(900000 + i), name: `SYNTHETIC-${i}`, market: "KOSPI", eligible: i < 509,
    officialAsOfDate: seedDate, sourceHash: "b".repeat(64), rows: fixture(i).rows.map((row, index) => [new Date(Date.parse(`${seedDate}T00:00:00Z`) - index * 86400000).toISOString().slice(0, 10).replaceAll("-", ""), ...row.slice(1)]) }));
  const base = { schemaVersion: 1, seedType: "intradayMarketAnalysisSeed", rowOrder: "descending", requestedDate: seedDate,
    generatedAt: `${date}T03:01:00.000Z`, sourceManifest: { modelFormulaHashes: Object.fromEntries(["A-v1", "B-v1", "C-v1", "D-v1"].map(v => [v, "a".repeat(64)])),
      sources: { officialDailyPrice: { normalizedInputHash: "b".repeat(64), availability: { referenceDate: seedDate, availabilityStatus: "OBSERVED",
        availabilityEvidence: "SYSTEM_OBSERVED_BATCH_COLLECTION", outcome: "success", requestedAt: `${date}T03:00:00.000Z`, observedAt: `${date}T03:00:30.000Z`, normalizedInputHash: "b".repeat(64) } } } }, records };
  const seed = { ...base, contentHash: intradaySeedHash(base) };
  return { seed, prepared: { targetDate: date, seedReferenceDate: seedDate, readiness: "READY", universe: 553, eligible: 509,
    codes: records.map(r => r.code), eligibleCodes: records.filter(r => r.eligible).map(r => r.code), seedHash: seed.contentHash } };
}

export async function runCompoundReplay({ responseMs = 35, clockLagMs = 2, retryEvery = 0, retryCount = 2,
  persistentCode = null, startOffset = 0, restartAfter = 0, receiptFix = true, budgetNear = false,
  dropRelayAck = false, transportTimeout = false, retireUnused = true, deferMinute = true, controlMs = 0, dropCompletionEvery = 0 } = {}) {
  const date = "2002-01-03", b = bounds(date), { seed, prepared } = inputs(date, "2001-12-28");
  let now = b.start - 1000, sequence = 0, receiverNow = now, done = false, completed = 0, active = 0, peakActive = 0, peakPending = 0;
  let restarted = false, lostReceipt = false, peakInvocationCalls = 0, batchesOverInvocationDeadline = 0;
  const db = new DatabaseSync(":memory:"), timers = [], calls = [], expectedQuotes = new Map(), attempts = new Map(), batches = [];
  const meter = { queries: 0, usageUpdates: 0, rowsRead: 0, rowsWritten: 0 }, controls = {}, remoteValues = new Map(), ackDropped = new Set(), completedCodes = new Set();
  const enqueue = (ms, resolve) => { const v = { at: now + Math.max(0, ms), sequence: sequence++, resolve }; timers.push(v); return () => { const i = timers.indexOf(v); if (i >= 0) timers.splice(i, 1); }; };
  const wait = ms => new Promise(resolve => enqueue(ms, resolve));
  const sql = { get databaseSize() { return db.prepare("PRAGMA page_count").get().page_count * 4096; }, exec(query, ...args) {
    const rows = db.prepare(query).all(...args), r = rows.length + 1, w = /^(INSERT|UPDATE|DELETE)/u.test(query) ? 2 : 0;
    meter.queries++; meter.rowsRead += r; meter.rowsWritten += w; if (query.startsWith("UPDATE usage")) meter.usageUpdates++;
    return { toArray: () => rows, rowsRead: r, rowsWritten: w };
  } };
  const transaction = fn => { db.exec("BEGIN"); try { const v = fn(); db.exec("COMMIT"); return v; } catch (e) { db.exec("ROLLBACK"); throw e; } };
  const remote = {
    async verifyPrivateRepository() {},
    async read(key) { return remoteValues.has(key) ? { value: structuredClone(remoteValues.get(key)) } : null; },
    async writeImmutable(key, value) {
      if (remoteValues.has(key) && hash(remoteValues.get(key)) !== hash(value)) throw Error("PRIVATE_STORE_IMMUTABLE_CONFLICT");
      remoteValues.set(key, structuredClone(value));
      if (dropRelayAck && !lostReceipt) { lostReceipt = true; throw Error("PRIVATE_STORE_NETWORK_FAILED"); }
    },
    async listKeys(prefix) { const names = new Map(); for (const key of remoteValues.keys()) if (key.startsWith(`${prefix}/`)) { const rest = key.slice(prefix.length + 1), [name] = rest.split("/"); names.set(name, { name, type: rest.includes("/") ? "dir" : "file" }); } return [...names.values()]; },
  };
  const options = { sql, transaction, now: () => receiverNow, wait: async ms => { await wait(ms); receiverNow = now; }, scheduleDeadline: enqueue,
    env: { LIVE_PRODUCTION_ENABLED: "true", LIVE_PRODUCER: "cloud", LIVE_CUTOVER_RECEIPT_HASH: "f".repeat(64) }, remote,
    prepare: async () => ({ ...prepared, remoteCheckedAt: new Date(now).toISOString() }),
    bundle: async (_date, _prepared, code) => ({ record: seed.records.find(r => r.code === code),
      seedContext: { requestedDate: seed.requestedDate, generatedAt: seed.generatedAt, contentHash: seed.contentHash, sourceManifest: seed.sourceManifest },
      authenticationRecord: { accessToken: "SYNTHETIC-NOT-A-TOKEN", generation: 1, expiresAtMs: b.end + 86400000 } }),
  };
  let state = new ProductionDayState(options);
  const broker = { async fetch(input, init) {
    const u = new URL(input), code = u.searchParams.get("code"), path = u.pathname; controls[path] = (controls[path] ?? 0) + 1;
    if (controlMs) await wait(controlMs / 2);
    try {
      receiverNow = now;
      if (path === "/slot-pair-acquire") {
        const p = state.acquire(date, code, { deferMinute }); peakPending = Math.max(peakPending, state.pending.size);
        const lease = await p; if (!lease.existing) { active++; peakActive = Math.max(peakActive, active); }
        return Response.json(lease);
      }
      if (path === "/extra-slot") return Response.json(await extraWithReceiptClock(state, date, code, u.searchParams.get("kind"), retireUnused && init?.body ? JSON.parse(init.body).skipped : []));
      if (path === "/slot-pair-complete") {
        const value = JSON.parse(init.body); receiverNow = now - clockLagMs;
        try {
          const stored = receiptFix ? await completeWithReceiptClock(state, date, code, value) : state.complete(date, code, value);
          if (dropCompletionEvery && (Number(code) - 900000) % dropCompletionEvery === 0 && !ackDropped.has(code)) {
            ackDropped.add(code); throw Object.assign(Error("SYNTHETIC_ACK_LOST"), { lostAck: true });
          }
          return Response.json(stored);
        } finally { if (!completedCodes.has(code)) { completedCodes.add(code); active--; completed++; } }
      }
      throw Error("LIVE_CLOUD_AUTH_INVALIDATED");
    } catch (e) { if (e.lostAck) throw e; return Response.json({ reason: /^[A-Z0-9_]+$/u.test(e.message) ? e.message : "DIAG_REQUEST_FAILED" }, { status: 503 }); }
    finally { if (controlMs) await wait(controlMs / 2); }
  } };
  const FixtureDate = class extends Date { static now() { return now; } };
  const Base = createFixtureShard({ Date: FixtureDate, sleep: wait, edgeFetch: async input => {
    const u = new URL(input), code = u.searchParams.get("FID_INPUT_ISCD"), index = Number(code) - 900000;
    const kind = u.pathname.endsWith("inquire-price") ? "quote" : "minute", key = `${code}:${kind}`, attempt = (attempts.get(key) ?? 0) + 1;
    attempts.set(key, attempt); calls.push({ code, kind, at: now });
    const transient = retryEvery > 0 && index % retryEvery === 0 && kind === "quote" && attempt <= retryCount;
    await wait(transportTimeout && transient ? 15000 : responseMs);
    if (transient && transportTimeout) throw Object.assign(Error("synthetic timeout"), { name: "TimeoutError" });
    if (code === persistentCode || transient) return new Response(null, { status: 500 });
    if (kind === "quote") {
      const q = { ...fixture(index).quote, asOfDate: date, asOfTime: kst(now).time, receivedAt: new Date(now).toISOString() };
      expectedQuotes.set(code, q);
      return Response.json({ rt_cd: "0", output: { stck_shrn_iscd: code, stck_prpr: String(q.price), stck_oprc: String(q.open), stck_hgpr: String(q.high), stck_lwpr: String(q.low), acml_vol: String(q.volume), prdy_vrss: String(q.change), prdy_ctrt: String(q.rate) } });
    }
    return Response.json({ rt_cd: "0", output2: [{ stck_bsop_date: date.replaceAll("-", ""), stck_cntg_hour: u.searchParams.get("FID_INPUT_HOUR_1") }] });
  } });
  class Shard extends Base {
    assertInvocation() {}
    brokerFor() { return broker; }
    minuteQueryTime(timing) { return kst(Date.parse(timing.quoteRequestedAt)).time; }
    projectResult(args) {
      // The real per-symbol formula/quality path, not synthetic score metadata.
      const value = productionObservation(args);
      if (expectedQuotes.has(args.code)) expectedQuotes.get(args.code).asOfTime = value.observedTime;
      return value;
    }
  }
  try {
    await state.prepare(date, true); now = b.start + startOffset; receiverNow = now;
    if (budgetNear) state.meter.w = 33500;
    for (let i = 0; i < prepared.codes.length; i += 4) {
      const codes = prepared.codes.slice(i, i + 4), shard = new Shard({}, { KIS_APP_KEY: "fixture", KIS_APP_SECRET: "fixture" }), budget = { calls: 0, controlCalls: 0 };
      batches.push(shard.fetch(new Request(`https://isolated/collect-batch?run=compound-local&codes=${codes.join(",")}`), budget).then(async response => {
        if (now > b.start + startOffset + 300000) batchesOverInvocationDeadline++;
        const { records } = await response.json(); receiverNow = now;
        const failed = records.filter(r => !["AVAILABLE", "EXCLUDED"].includes(r.status)).map(r => ({ code: r.code, reason: r.reason, failureStage: r.failureStage ?? "UNKNOWN" }));
        state.recordBatchResult(date, `live-${date}`, codes, { status: "complete", output: { attempted: codes.length, successful: codes.length - failed.length, failed } });
        peakInvocationCalls = Math.max(peakInvocationCalls, budget.calls + budget.controlCalls);
        return failed;
      }));
    }
    let batchFailure = null;
    const all = Promise.all(batches).then(results => results.flat(), e => { batchFailure = e.message; return []; }).finally(() => { done = true; });
    for (let cycles = 0; !done && cycles < 40000; cycles++) {
      for (let n = 0; n < 140; n++) await Promise.resolve();
      if (done) break;
      timers.sort((x, y) => x.at - y.at || x.sequence - y.sequence);
      if (!timers.length) throw Error("COMPOUND_REPLAY_DEADLOCK");
      now = timers[0].at;
      while (timers[0]?.at <= now) timers.shift().resolve();
    }
    if (!done) throw Error("COMPOUND_REPLAY_CYCLE_LIMIT");
    const failures = await all, elapsedMs = now - b.start;
    // Reopen completed state before finalize/relay. Mid-flight restart is
    // separately tested: pending request contexts cannot be faithfully kept
    // alive across a platform crash by a local in-process simulator.
    if (restartAfter) { receiverNow = now; state = new ProductionDayState(options); restarted = true; }
    receiverNow = now;
    let finishError = batchFailure, result = null, relayError = null, readback = false, formulaMatch = false;
    try {
      const journal = state.reconcileJournal(date, `live-${date}`, true);
      if (journal.firstFailure) throw Error(journal.firstFailure.reason);
      result = state.finish(date);
      const expected = buildIntradayModelTopSignal({ seed, quotesByCode: expectedQuotes, signalDate: date, collectionStartedAt: result.models[0].collectionStartedAt, collectionCompletedAt: result.models[0].collectionCompletedAt });
      formulaMatch = result.models.every(m => hash(m.records) === hash(expected.top5[m.modelVersion]?.map(({ observationId: _id, ...row }) => { void _id; return row; })));
      try { await state.relay(date); } catch (e) { relayError = e.message; }
      if (relayError) { now += 60001; receiverNow = now; state = new ProductionDayState(options); await state.relay(date); }
      const latest = await readLatestPrivateLive(remote, { now: new Date(now).toISOString() });
      readback = latest?.deliveryHash === result.deliveryHash;
    } catch (e) { finishError = e.message; }
    const starts = calls.map(c => c.at).sort((a, b) => a - b);
    return { syntheticOnly: true, realKisCalls: 0, batches: batches.length, universe: 553, eligible: 509, peakActive, peakPending, completed,
      simulatedMarketCalls: calls.length, reservedSlots: state.critical(() => state.read("allocator"))?.count ?? 0,
      retiredUnused: state.critical(() => state.read("allocator"))?.retiredUnused ?? 0, peakInvocationCalls, elapsedMs, batchesOverInvocationDeadline,
      errors: Object.fromEntries([...new Set(failures.map(f => f.reason))].map(code => [code, failures.filter(f => f.reason === code).length])),
      finishError, outbox: !!result, topRows: result?.models.reduce((n, m) => n + m.records.length, 0) ?? 0, formulaMatch, readback, relayError, restarted,
      minActualStartSpacingMs: starts.length > 1 ? Math.min(...starts.slice(1).map((v, i) => v - starts[i])) : null,
      activeAfter: state.critical(() => state.q("SELECT code FROM leases WHERE completed=0 AND expires>?", now)).length, pendingAfter: state.pending.size,
      immutableFirstIssuance: result ? state.read("outbox").swing.createdAt === result.exportedAt : null,
      meter: { ...state.meter }, sqlModel: meter, sqliteBytes: sql.databaseSize, controls,
      measurement: "LOCAL_VIRTUAL_CLOCK_SQLITE_MODEL_NOT_CLOUD_BILLING_OR_LATENCY", operationalPointerChanged: false };
  } finally { db.close(); }
}
