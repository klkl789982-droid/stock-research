import { hashIntradayModelTop as hash } from "../../lib/intraday-model-top-official-signal.mjs";
import { assertPrivateKisEodPayload } from "../../lib/kis-eod-private-store.mjs";
import { deliverPrivateLive } from "../../lib/private-live-delivery.mjs";
import { assertProduction, assertWindow, bounds, aggregateProduction, nextPairSlots, PRODUCTION_BUDGET } from "./production-core.mjs";
import { persistCloudSwingIntent } from "./cloud-swing.mjs";
import { safeCode } from "./core.mjs";
import { EXECUTION_PREFIX, EXECUTION_EVENTS, sealExecutionRecord } from "../../lib/private-live-execution-status.mjs";

export class ProductionDayState {
  constructor({ sql, env, prepare, bundle, remote, now = Date.now, wait = ms => new Promise(r => setTimeout(r, ms)), transaction = fn => fn(), scheduleDeadline = (ms, fn) => { const timer = setTimeout(fn, ms); timer.unref?.(); return () => clearTimeout(timer); } }) {
    this.sql = sql; this.env = env; this.prepareInput = prepare; this.bundle = bundle; this.remote = remote; this.now = now; this.wait = wait;
    this.transaction = transaction; this.scheduleDeadline = scheduleDeadline; this.pending = new Map(); this.draining = false; this.controlDepth = 0;
    this.credit = { r: 0, w: 0 }; this.cursorUsage = { r: 0, w: 0 }; this.usageUpdates = 0;
    sql.exec("CREATE TABLE IF NOT EXISTS docs (id TEXT PRIMARY KEY,digest TEXT NOT NULL,body TEXT NOT NULL)").toArray();
    sql.exec("CREATE TABLE IF NOT EXISTS leases (code TEXT PRIMARY KEY,expires INTEGER NOT NULL,completed INTEGER NOT NULL)").toArray();
    sql.exec("CREATE INDEX IF NOT EXISTS active_lease ON leases(completed,expires)").toArray();
    sql.exec("CREATE TABLE IF NOT EXISTS slots (slot INTEGER PRIMARY KEY,code TEXT NOT NULL,kind TEXT NOT NULL,body TEXT)").toArray();
    sql.exec("CREATE TABLE IF NOT EXISTS usage (id INTEGER PRIMARY KEY,r INTEGER NOT NULL,w INTEGER NOT NULL)").toArray();
    const prior = sql.exec("SELECT r,w FROM usage WHERE id=1").toArray()[0];
    this.meter = prior ? { r: prior.r + 1, w: prior.w } : { r: 1, w: 2 };
    if (!prior) sql.exec("INSERT INTO usage VALUES (1,1,2)").toArray();
    // Prepay startup/schema/index overhead on every reopen. Unused credit is
    // deliberately lost on restart; the persisted high-water mark never resets.
    this.reserve(128, 32, true);
  }
  critical(fn) { this.controlDepth++; try { return fn(); } finally { this.controlDepth--; } }
  reserve(r, w, critical = this.controlDepth > 0) {
    const limitR = PRODUCTION_BUDGET.sqlRowsRead - (critical ? 64 : 20000);
    const limitW = PRODUCTION_BUDGET.sqlRowsWritten - (critical ? 64 : 6000);
    const addR = this.credit.r < r ? Math.max(1024, r) : 0, addW = this.credit.w < w ? Math.max(128, w) : 0;
    if (this.meter.r + addR + (addR || addW ? 2 : 0) > limitR || this.meter.w + addW + (addR || addW ? 2 : 0) > limitW) throw new Error("LIVE_CLOUD_SQL_BUDGET");
    if (!addR && !addW) return;
    const next = { r: this.meter.r + addR + 2, w: this.meter.w + addW + 2 };
    const m = this.sql.exec("UPDATE usage SET r=?,w=? WHERE id=1", next.r, next.w); m.toArray();
    if (!Number.isFinite(m.rowsRead) || !Number.isFinite(m.rowsWritten) || m.rowsRead > 2 || m.rowsWritten > 2) throw new Error("LIVE_CLOUD_SQL_METER_CHANGED");
    this.meter = next; this.credit.r += addR; this.credit.w += addW; this.usageUpdates++;
  }
  q(query, ...args) {
    // Indexed point reads / at most eight active leases. Aggregate diagnostics
    // use an explicit bounded scan rather than this hot-path allowance.
    const maxRead = query.includes("COUNT(") || query.includes("SUM(") || query.includes("LIMIT 554") ? 2048 : 32, maxWrite = 16;
    if (this.inTransaction && (this.credit.r < maxRead || this.credit.w < maxWrite)) throw new Error("LIVE_CLOUD_SQL_RESERVATION_REQUIRED");
    this.reserve(maxRead, maxWrite);
    // Reserve the individual statement BEFORE executing it. If SQLite throws
    // or returns no cursor telemetry, retain the entire pessimistic charge.
    this.credit.r -= maxRead; this.credit.w -= maxWrite;
    const c = this.sql.exec(query, ...args), rows = c.toArray();
    if (!Number.isFinite(c.rowsRead) || !Number.isFinite(c.rowsWritten)) throw new Error("LIVE_CLOUD_SQL_METER_UNAVAILABLE");
    this.credit.r += maxRead - c.rowsRead; this.credit.w += maxWrite - c.rowsWritten;
    this.cursorUsage.r += c.rowsRead; this.cursorUsage.w += c.rowsWritten;
    if (c.rowsRead > maxRead || c.rowsWritten > maxWrite) throw new Error("LIVE_CLOUD_SQL_QUERY_BOUND");
    return rows;
  }
  read(id) {
    const row = this.q("SELECT digest,body FROM docs WHERE id=?", id)[0]; if (!row) return null;
    const value = JSON.parse(row.body); if (hash(value) !== row.digest) throw new Error("LIVE_CLOUD_HASH_MISMATCH"); return value;
  }
  write(id, value, mutable = false) {
    assertPrivateKisEodPayload(value);
    const visit = node => { if (!node || typeof node !== "object") return; for (const [k, v] of Object.entries(node)) {
      if (["price", "volume", "open", "high", "low", "close", "rows", "output", "output2", "payload", "authenticationRecord", "accessToken"].includes(k)) throw new Error("LIVE_CLOUD_RAW_STORAGE_REJECTED"); visit(v);
    } }; visit(value);
    const body = JSON.stringify(value), digest = hash(value), prior = this.read(id);
    if (prior && !mutable) { if (hash(prior) !== digest) throw new Error("LIVE_CLOUD_IMMUTABLE_CONFLICT"); return prior; }
    if (this.sql.databaseSize + Buffer.byteLength(body) + 8192 > PRODUCTION_BUDGET.retainedBytesPerDay) throw new Error("LIVE_CLOUD_STORAGE_BUDGET");
    this.q("INSERT OR REPLACE INTO docs VALUES (?,?,?)", id, digest, body); return value;
  }
  check(date, collection = false) {
    assertProduction(this.env);
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(date ?? "")) throw new Error("LIVE_CLOUD_DATE_INVALID");
    const prior = this.dateReceipt ?? this.read("date"); if (prior && prior.date !== date) throw new Error("LIVE_CLOUD_DATE_CONFLICT");
    if (!prior) this.write("date", { date });
    this.dateReceipt = prior ?? { date };
    if (this.read("revoked")) throw new Error("LIVE_CLOUD_OWNER_REVOKED");
    if (collection) assertWindow(date, this.now());
  }
  async prepare(date, final = false) {
    this.check(date);
    if (this.now() >= bounds(date).start) throw new Error("LIVE_CLOUD_INPUT_LATE");
    if (final && this.now() < bounds(date).start - 60000) throw new Error("LIVE_CLOUD_FINAL_TOO_EARLY");
    const saved = this.read(final ? "final" : "prewarm"); if (saved) return saved;
    const value = await this.prepareInput(date);
    if (this.now() >= bounds(date).start || value.readiness !== "READY" || value.targetDate !== date || value.universe !== 553
      || !Number.isFinite(Date.parse(value.remoteCheckedAt)) || Date.parse(value.remoteCheckedAt) >= bounds(date).start) throw new Error("LIVE_CLOUD_INPUT_NOT_READY");
    // Receipt is written only after all fresh input/auth/calendar checks finish.
    return this.write(final ? "final" : "prewarm", { ...value, readyAt: new Date(this.now()).toISOString() });
  }
  recoverySource(date) {
    return this.critical(() => {
      this.check(date);
      if (this.read("outbox") || this.read("receipt")) throw new Error("LIVE_CLOUD_RECOVERY_NOT_ALLOWED");
      const prepared = this.read("final");
      if (!prepared) throw new Error("LIVE_CLOUD_NOT_PREPARED");
      return prepared;
    });
  }
  adoptPrepared(date, prepared) {
    return this.critical(() => {
      this.check(date, true);
      if (prepared?.targetDate !== date || prepared.readiness !== "READY" || prepared.universe !== 553
        || !Array.isArray(prepared.codes) || prepared.codes.length !== 553 || new Set(prepared.codes).size !== 553
        || !Array.isArray(prepared.eligibleCodes) || prepared.eligibleCodes.length !== prepared.eligible
        || !Number.isFinite(Date.parse(prepared.readyAt)) || Date.parse(prepared.readyAt) >= bounds(date).start) throw new Error("LIVE_CLOUD_RECOVERY_INPUT_INVALID");
      this.write("prewarm", prepared); return this.write("final", prepared);
    });
  }
  slots(date, code) {
    const counter = this.read("allocator") ?? { head: 0, count: 0 };
    const s = nextPairSlots({ now: this.now(), head: counter.head, count: counter.count, date });
    for (const [kind, slot] of [["quote", s.quoteSlot], ["minute", s.minuteSlot]]) this.q("INSERT INTO slots VALUES (?,?,?,NULL)", slot.slot, code, kind);
    this.write("allocator", { head: s.head, count: counter.count + 2 }, true); return s;
  }
  async acquire(date, code) {
    this.check(date, true);
    const previous = this.read(`observation:${code}`); if (previous) return { existing: previous };
    const original = this.finalReceipt ?? this.read("final"); if (!original?.codes.includes(code)) throw new Error("LIVE_CLOUD_NOT_PREPARED");
    this.finalReceipt = original;
    if (this.pending.has(code)) throw new Error("LIVE_CLOUD_ATTEMPT_ALREADY_RESERVED");
    return new Promise((resolve, reject) => {
      const job = { date, code, original, resolve, reject }; this.pending.set(code, job);
      // One absolute deadline notification, never repeated SQL polling.
      job.cancel = this.scheduleDeadline(Math.max(0, bounds(date).end - this.now() + 1), () => {
        if (this.pending.get(code) !== job) return;
        this.pending.delete(code); reject(new Error("LIVE_CLOUD_WINDOW_EXPIRED"));
      });
      this.drain();
    });
  }
  drain() {
    if (this.draining) return; this.draining = true;
    try {
      while (this.pending.size) {
        const job = this.pending.values().next().value;
        try {
          this.check(job.date, true);
          if (this.q("SELECT code FROM leases WHERE code=?", job.code).length) throw new Error("LIVE_CLOUD_ATTEMPT_ALREADY_RESERVED");
          if (this.q("SELECT code FROM leases WHERE completed=0 AND expires>?", this.now()).length >= 8) break;
          // Persist slots+allocator+lease atomically before any market call.
          // Accounting credit is committed BEFORE the transaction, so aborted
          // SQL and unused credits after a crash are still conservatively paid.
          this.reserve(512, 128);
          const deadline = bounds(job.date).end;
          const slots = this.transaction(() => {
            this.inTransaction = true;
            try { const s = this.slots(job.date, job.code); this.q("INSERT INTO leases VALUES (?,?,0)", job.code, deadline); return s; }
            finally { this.inTransaction = false; }
          });
          this.pending.delete(job.code); job.cancel();
          // Never hold the queue/transaction across broker network I/O.
          Promise.resolve().then(() => this.bundle(job.date, job.original, job.code)).then(data => job.resolve({ ...data, ...slots, deadline,
            signalDate: job.date, seedReferenceDate: job.original.seedReferenceDate }), error => {
            try { this.critical(() => this.write(`observation:${job.code}`, { code: job.code, reason: safeCode(error), rawPricesStored: false })); }
            catch (recordError) { console.error(JSON.stringify({ event: "LIVE_BUNDLE_FAILURE_RECORD_FAILED", primaryCode: safeCode(error), recordingCode: safeCode(recordError) })); }
            // Releasing an already attempted symbol is independent of its
            // diagnostic write. Keep the durable lease row as a duplicate
            // fence; never delete/reclaim it or turn missing input into success.
            try { this.critical(() => this.q("UPDATE leases SET completed=1 WHERE code=?", job.code)); }
            catch (releaseError) { console.error(JSON.stringify({ event: "LIVE_BUNDLE_LEASE_RELEASE_FAILED", primaryCode: safeCode(error), recordingCode: safeCode(releaseError) })); }
            job.reject(error); this.drain();
          });
        } catch (error) {
          this.pending.delete(job.code); job.cancel(); job.reject(error);
          // Fail all waiting calls on owner/window/budget failure without a
          // fresh database query per waiter. Active completions remain allowed.
          if (/SQL_|WINDOW_|OWNER_|DISABLED/.test(error.message)) {
            for (const pending of this.pending.values()) { pending.cancel(); pending.reject(error); }
            this.pending.clear(); break;
          }
        }
      }
    } finally { this.draining = false; }
  }
  extra(date, code, kind) {
    this.check(date, true);
    if (!["quote", "minute"].includes(kind) || !this.q("SELECT code FROM leases WHERE code=? AND completed=0", code).length) throw new Error("LIVE_CLOUD_LEASE_INVALID");
    const state = this.read("allocator"), first = Math.max(state.head, Math.ceil((this.now() + 200) / 220));
    if (state.count >= PRODUCTION_BUDGET.marketCalls || first * 220 + 20 >= bounds(date).end) throw new Error("LIVE_CLOUD_RETRY_BUDGET");
    this.q("INSERT INTO slots VALUES (?,?,?,NULL)", first, code, kind);
    this.write("allocator", { head: first + 1, count: state.count + 1 }, true); return { slot: first, notBefore: first * 220 };
  }
  complete(date, code, value) {
    try { return this.critical(() => {
      this.reserve(2048, 512);
      return this.transaction(() => {
        this.inTransaction = true;
        try { return this.completeReserved(date, code, value); } finally { this.inTransaction = false; }
      });
    }); } catch (error) {
      // A terminal observation/storage error must not retain one of the eight
      // active leases until cutoff. The immutable child result and parent
      // reconciliation preserve the failure even when its observation row
      // could not be stored.
      try { this.critical(() => this.q("UPDATE leases SET completed=1 WHERE code=?", code)); } catch { /* original failure remains primary */ }
      throw error;
    }
    finally { this.drain(); }
  }
  completeReserved(date, code, value) {
    this.check(date);
    if (value.metadata?.code !== code || !Array.isArray(value.calls) || value.calls.length > 16 || value.metadata.rawPricesStored !== false) throw new Error("LIVE_CLOUD_METADATA_INVALID");
    if (!this.q("SELECT code FROM leases WHERE code=?", code).length) throw new Error("LIVE_CLOUD_LEASE_INVALID");
    for (const c of value.calls) {
      const s = this.q("SELECT code,kind,body FROM slots WHERE slot=?", c.slot)[0];
      if (!s || s.code !== code || s.kind !== c.kind || !Number.isSafeInteger(c.started) || c.started < c.slot * 220 || c.started > c.slot * 220 + 20
        || !Number.isSafeInteger(c.completed) || c.completed < c.started || c.completed > this.now()) throw new Error("LIVE_CLOUD_RATE_EVIDENCE_INVALID");
      const body = JSON.stringify(c); if (s.body && s.body !== body) throw new Error("LIVE_CLOUD_HTTP_CONFLICT");
      this.q("UPDATE slots SET body=? WHERE slot=?", body, c.slot);
    }
    // Late/error attempts are retained, never accepted as valid observations.
    this.write(`observation:${code}`, value.metadata);
    this.q("UPDATE leases SET completed=1 WHERE code=?", code); return { stored: true };
  }
  finish(date) {
    return this.critical(() => this.finishReserved(date));
  }
  finishReserved(date) {
    this.check(date);
    const existing = this.read("outbox"); if (existing) return existing.delivery;
    const prepared = this.read("final"); if (!prepared) throw new Error("LIVE_CLOUD_NOT_PREPARED");
    const reconciliation = this.read("batch-reconciliation");
    if (!reconciliation) throw new Error("LIVE_CLOUD_CHILD_RESULTS_UNVERIFIED");
    if (reconciliation.firstFailure) throw new Error(reconciliation.firstFailure.reason);
    const observations = prepared.codes.map(code => this.read(`observation:${code}`));
    if (observations.some(r => !r)) throw new Error("LIVE_CLOUD_COMPLETION_MISMATCH");
    const result = aggregateProduction(prepared, observations, new Date(this.now()).toISOString());
    this.write("outbox", result); return result.delivery;
  }
  async relay(date, remote = this.remote) {
    this.critical(() => this.check(date));
    const outbox = this.critical(() => this.read("outbox")); if (!outbox) throw new Error("LIVE_CLOUD_NO_OUTBOX");
    const receipt = this.critical(() => this.read("receipt")); if (receipt) return receipt;
    const attempt = this.critical(() => this.read("relay-attempt")) ?? { count: 0, next: 0 };
    if (attempt.count >= 3 || attempt.next > this.now()) throw new Error("LIVE_CLOUD_RELAY_BACKOFF");
    this.critical(() => this.write("relay-attempt", { count: attempt.count + 1, next: this.now() + 60000 }, true));
    await remote.writeImmutable(`cloud-live-score-evidence-v1/${date}/${outbox.evidence.contentHash}.json`, outbox.evidence);
    // Freeze selections/first issuance before delivery. Restart or relay retry
    // cannot regenerate the five-session record with a later creation time.
    if (!outbox.swing) throw new Error("LIVE_CLOUD_SWING_OUTBOX_MISSING");
    await persistCloudSwingIntent(remote, outbox.swing);
    const result = await deliverPrivateLive(remote, outbox.delivery, { now: new Date(this.now()).toISOString() });
    return this.critical(() => this.write("receipt", result));
  }
  reconcileBatches(date, value) {
    return this.critical(() => {
      this.check(date);
      const prepared = this.read("final");
      const runId = value?.runId ?? `live-${date}`, runPattern = new RegExp(`^live-${date}(?:-recovery-[A-Za-z0-9_-]{1,24})?$`, "u");
      if (!prepared || value?.schemaVersion !== 1 || value.date !== date || !runPattern.test(runId ?? "") || !Array.isArray(value.batches) || value.batches.length !== Math.ceil(prepared.codes.length / 8))
        throw new Error("LIVE_CLOUD_CHILD_RESULTS_INVALID");
      const flattened = [], failed = new Set();
      for (const [index, batch] of value.batches.entries()) {
        const expected = prepared.codes.slice(index * 8, index * 8 + 8);
        if (batch.id !== `${runId}-batch${index}` || !Array.isArray(batch.codes) || JSON.stringify(batch.codes) !== JSON.stringify(expected)
          || !["complete", "errored", "terminated", "queued", "running", "waiting", "paused", "unknown"].includes(batch.workflowStatus)
          || !Array.isArray(batch.failures) || new Set(batch.failures.map(row => row.code)).size !== batch.failures.length
          || batch.failures.some(row => !expected.includes(row.code) || failed.has(row.code)
            || safeCode({ code: row.reason }) !== row.reason || !["LEASE_ACQUIRE","LEASED_SETUP","COLLECTION","UNKNOWN"].includes(row.failureStage)))
          throw new Error("LIVE_CLOUD_CHILD_RESULTS_INVALID");
        if (batch.workflowStatus === "complete" && (!Number.isSafeInteger(batch.attempted) || batch.attempted !== expected.length
          || !Number.isSafeInteger(batch.successful) || batch.successful < 0 || batch.successful + batch.failures.length !== batch.attempted))
          throw new Error("LIVE_CLOUD_CHILD_RESULTS_INVALID");
        if (batch.workflowStatus !== "complete" && (batch.attempted !== 0 || batch.successful !== 0 || batch.failures.length !== expected.length))
          throw new Error("LIVE_CLOUD_CHILD_RESULTS_INVALID");
        for (const row of batch.failures) failed.add(row.code);
        flattened.push(...batch.codes);
      }
      if (JSON.stringify(flattened) !== JSON.stringify(prepared.codes)) throw new Error("LIVE_CLOUD_CHILD_RESULTS_INVALID");
      const expectedFirst = value.batches.flatMap(batch => batch.failures.map(row => ({ ...row, batchId: batch.id })))[0] ?? null;
      if (JSON.stringify(value.firstFailure ?? null) !== JSON.stringify(expectedFirst)) throw new Error("LIVE_CLOUD_CHILD_RESULTS_INVALID");
      return this.write("batch-reconciliation", value);
    });
  }
  failure(code, stage = "UNSPECIFIED_LEGACY") { return this.critical(() => {
    const prior = this.read("last-failure");
    return prior ?? this.write("last-failure", { code, stage, at: new Date(this.now()).toISOString() });
  }); }
  freezeExecution(date, event, workflowState = "RUNNING", error = undefined) {
    return this.critical(() => {
      assertProduction(this.env);
      if (!EXECUTION_EVENTS.includes(event) || this.read("date")?.date !== date) throw new Error("LIVE_CLOUD_DATE_CONFLICT");
      const frozen = this.read(`execution-status:${event}`); if (frozen) return frozen;
      const initial=this.read("prewarm"), final=this.read("final"), outbox=this.read("outbox"), receipt=this.read("receipt");
      const observations=this.q("SELECT digest,body FROM docs WHERE id>='observation:' AND id<'observation;' ORDER BY id LIMIT 554").map(r=>{
        const value=JSON.parse(r.body);if(hash(value)!==r.digest)throw new Error("LIVE_CLOUD_HASH_MISMATCH");return value;
      });
      const byCode=new Map(observations.map(r=>[r.code,r])), expected=final?.codes??[];
      if(observations.length>553||byCode.size!==observations.length||expected.length&&observations.some(r=>!expected.includes(r.code)))throw new Error("LIVE_CLOUD_INCOMPLETE");
      const available=observations.filter(r=>r.status==="AVAILABLE").length,excluded=observations.filter(r=>r.status==="EXCLUDED").length;
      const first=observations.map(r=>r.quoteRequestedAt).filter(Boolean).sort()[0]??null,last=observations.map(r=>r.minuteReceivedAt).filter(Boolean).sort().at(-1)??null;
      // The first durable collection/control error is primary. Finalize and
      // relay wrappers must not replace it with LIVE_CLOUD_INCOMPLETE.
      const failure=this.read("last-failure")??error??null;
      const reconciliation=this.read("batch-reconciliation");
      const reconciledFailures=new Map((reconciliation?.batches??[]).flatMap(batch=>batch.failures).map(row=>[row.code,row]));
      const observedFailed=observations.filter(r=>!["AVAILABLE","EXCLUDED"].includes(r.status)).map(r=>r.code);
      const failedCodes=new Set([...observedFailed,...reconciledFailures.keys()]);
      const allowedStages=["PREPARE","FINAL_INPUT","CREATE_BATCHES","BATCH_COLLECTION","FINALIZE","RELAY"];
      const value=sealExecutionRecord({schemaVersion:1,namespace:EXECUTION_PREFIX,source:"CLOUDFLARE_DURABLE_STATE",signalDate:date,runId:`live-${date}`,
        recordedAt:new Date(this.now()).toISOString(),event,workflowState,
        error:failure?{code:safeCode({code:failure.code}),stage:allowedStages.includes(failure.stage)?failure.stage:"UNKNOWN"}:null,
        input:{initialReady:!!initial,finalReady:!!final,seedReferenceDate:final?.seedReferenceDate??initial?.seedReferenceDate??null,
          checkedAt:final?.remoteCheckedAt??initial?.remoteCheckedAt??null,initialReadyAt:initial?.readyAt??null,finalReadyAt:final?.readyAt??null},
        collection:{expected:553,eligible:final?.eligible??null,available,excluded,failed:failedCodes.size,missing:553-available-excluded-failedCodes.size,
          requiredMissing:final?.eligibleCodes?final.eligibleCodes.filter(c=>byCode.get(c)?.status!=="AVAILABLE").length:null,
          activeLeases:this.q("SELECT code FROM leases WHERE completed=0 AND expires>?",this.now()).length,firstRequestedAt:first,lastReceivedAt:last},
        validation:{outboxFrozen:!!outbox,deliveryHash:outbox?.delivery?.deliveryHash??null,frozenAt:outbox?.delivery?.exportedAt??null},
        delivery:{verified:receipt?.status==="PRIVATE_RELAY_VERIFIED",deliveryHash:receipt?.deliveryHash??null}});
      return this.write(`execution-status:${event}`,value);
    });
  }
  incidentStatus() {
    return this.critical(() => {
      const prepared = this.read("final"), expected = prepared?.codes ?? [];
      const observations = this.q("SELECT digest,body FROM docs WHERE id>='observation:' AND id<'observation;' ORDER BY id LIMIT 554").map(r => {
        const value = JSON.parse(r.body); if (hash(value) !== r.digest) throw new Error("LIVE_CLOUD_HASH_MISMATCH"); return value;
      });
      const leases = this.q("SELECT code,expires,completed FROM leases ORDER BY code LIMIT 554"), reconciliation = this.read("batch-reconciliation");
      const seen = new Set(observations.map(r => r.code));
      const reconciledFailures = new Map((reconciliation?.batches ?? []).flatMap(batch => batch.failures).map(row => [row.code, row]));
      const failed = new Map(observations.filter(r => !["AVAILABLE", "EXCLUDED"].includes(r.status)).map(r => [r.code, { reason: r.reason, failureStage: r.failureStage ?? "UNKNOWN" }]));
      for (const [code, row] of reconciledFailures) if (!seen.has(code)) failed.set(code, row);
      return { ...this.status(), lastFailure: this.read("last-failure"), universe: expected.length, eligible: prepared?.eligible ?? null,
        seedReferenceDate: prepared?.seedReferenceDate ?? null, inputCommit: prepared?.inputCommit ?? null,
        completed: observations.filter(r => ["AVAILABLE", "EXCLUDED"].includes(r.status)).length,
        failed: [...failed].map(([code, row]) => ({ code, reason: row.reason, failureStage: row.failureStage })),
        missing: expected.filter(code => !seen.has(code) && !reconciledFailures.has(code)),
        leases: leases.map(r => ({ code: r.code, status: r.completed ? "COMPLETED" : r.expires <= this.now() ? "EXPIRED_NOT_REUSABLE" : "ACTIVE" })),
        observationTimeBounds: observations.length ? {
          first: observations.map(r => r.quoteRequestedAt).filter(Boolean).sort()[0] ?? null,
          last: observations.map(r => r.minuteReceivedAt).filter(Boolean).sort().at(-1) ?? null } : null,
        sourcePricesIncluded: false };
    });
  }
  status() { return this.critical(() => ({ prepared: Boolean(this.read("prewarm")), finalInputReady: Boolean(this.read("final")),
    outbox: Boolean(this.read("outbox")), receipt: this.read("receipt"), meteredSql: { ...this.meter }, runtimeCursorSql: { ...this.cursorUsage }, usageUpdates: this.usageUpdates,
    sqliteBytes: this.sql.databaseSize, retainedBytesLimit: PRODUCTION_BUDGET.retainedBytesPerDay,
    waitingInMemory: this.pending.size, rawPricesStored: false })); }
}
