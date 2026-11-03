import { hashIntradayModelTop as hash } from "../../lib/intraday-model-top-official-signal.mjs";
import { assertPrivateKisEodPayload } from "../../lib/kis-eod-private-store.mjs";
import { deliverPrivateLive } from "../../lib/private-live-delivery.mjs";
import { assertProduction, assertWindow, bounds, aggregateProduction, evaluateCollectionPolicy, isLiveMissingReason, observationFailureReasons, requiredRowIssues, productionPinnedExclusion, nextPairSlots, PRODUCTION_BUDGET, LIVE_BATCH_SIZE } from "./production-core.mjs";
import { buildCloudSwingIntent, persistCloudSwingIntent } from "./cloud-swing.mjs";
import { safeCode } from "./core.mjs";
import { EXECUTION_PREFIX, validExecutionEvent, sealExecutionRecord } from "../../lib/private-live-execution-status.mjs";

// A second, bounded lease has its own SQL identity. Its market symbol and frozen
// seed stay the same; all original observations, rejections and spent slots remain.
const retryTicker = key => /^retry:([0-9A-Z]{6})$/u.exec(key)?.[1];
const observationKey = key => retryTicker(key) ? `retry-observation:${retryTicker(key)}` : `observation:${key}`;
const rejectionKey = key => retryTicker(key) ? `retry-rejection:${retryTicker(key)}` : `rate-rejection:${key}`;

export class ProductionDayState {
  constructor({ sql, env, prepare, bundle, remote, now = Date.now, wait = ms => new Promise(r => setTimeout(r, ms)), transaction = fn => fn(), scheduleDeadline = (ms, fn) => { const timer = setTimeout(fn, ms); timer.unref?.(); return () => clearTimeout(timer); } }) {
    this.sql = sql; this.env = env; this.prepareInput = prepare; this.bundle = bundle; this.remote = remote; this.now = now; this.wait = wait;
    this.transaction = transaction; this.scheduleDeadline = scheduleDeadline; this.pending = new Map(); this.acquiring = new Map(); this.draining = false; this.controlDepth = 0;
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
    return this.write(final ? "final" : "prewarm", { ...value, batchSize: LIVE_BATCH_SIZE, missingRetryEnabled:true, readyAt: new Date(this.now()).toISOString() });
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
  slots(date, code, deferMinute = false) {
    const counter = this.read("allocator") ?? { head: 0, count: 0 };
    const s = nextPairSlots({ now: this.now(), head: counter.head, count: counter.count - (counter.retiredUnused ?? 0), date });
    // New production invocations reserve the minute only AFTER quote success.
    // Existing paired leases/diagnostics remain readable and immutable. Both
    // modes use the same durable220ms grid and same1400 sent/reserved-call cap.
    if (deferMinute) { s.minuteSlot = null; s.head = s.quoteSlot.slot + 1; }
    for (const [kind, slot] of [["quote", s.quoteSlot], ["minute", s.minuteSlot]]) if (slot) this.q("INSERT INTO slots VALUES (?,?,?,NULL)", slot.slot, code, kind);
    this.write("allocator", { head: s.head, count: counter.count + (deferMinute ? 1 : 2), retiredUnused: counter.retiredUnused ?? 0 }, true); return s;
  }
  async acquire(date, code, { deferMinute = false, acquisitionId = null } = {}) {
    this.check(date, true);
    if (acquisitionId !== null && !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(acquisitionId)) throw new Error("LIVE_CLOUD_ACQUISITION_ID_INVALID");
    const retry=retryTicker(code), ticker=retry??code;
    if(retry && (!this.read("missing-retry-plan")?.codes.includes(ticker) || this.read("policy-global-failure")))throw new Error("LIVE_CLOUD_RECOVERY_NOT_ALLOWED");
    const previous = this.read(observationKey(code)); if (previous) return { existing: previous };
    const original = this.finalReceipt ?? this.read("final"); if (!original?.codes.includes(ticker) || retry && !original.eligibleCodes.includes(ticker)) throw new Error("LIVE_CLOUD_NOT_PREPARED");
    this.finalReceipt = original;
    // Only the SAME live caller, still awaiting its first lease response, may
    // reconnect. A new invocation gets a new ID and cannot reclaim this work.
    const intent = this.read(`acquisition:${code}`);
    if (intent && (intent.acquisitionId !== acquisitionId || intent.deferMinute !== deferMinute)) throw new Error("LIVE_CLOUD_ATTEMPT_ALREADY_RESERVED");
    const acquiring = this.acquiring.get(code);
    if (acquiring) {
      if (!acquisitionId || acquiring.acquisitionId !== acquisitionId) throw new Error("LIVE_CLOUD_ATTEMPT_ALREADY_RESERVED");
      return acquiring.promise;
    }
    const grant = this.read(`lease-grant:${code}`);
    if (grant) {
      const lease = this.q("SELECT expires,completed FROM leases WHERE code=?", code)[0];
      if (!acquisitionId || grant.acquisitionId !== acquisitionId || grant.deferMinute !== deferMinute || grant.date !== date
        || !intent || !lease || lease.completed !== 0 || lease.expires !== grant.deadline
        || this.read(`lease-expanded:${code}`)) throw new Error("LIVE_CLOUD_ATTEMPT_ALREADY_RESERVED");
      for (const [kind, slot] of [["quote", grant.slots.quoteSlot], ["minute", grant.slots.minuteSlot]]) if (slot) {
        const reserved = this.q("SELECT code,kind,body FROM slots WHERE slot=?", slot.slot)[0];
        if (!reserved || reserved.code !== code || reserved.kind !== kind || reserved.body !== null) throw new Error("LIVE_CLOUD_ATTEMPT_ALREADY_RESERVED");
      }
      // Replay the exact original reservations, never allocate replacements or
      // infer that their timestamps are current. The caller's existing missed
      // slot path must still retire unused slots through the rate allocator.
      return this.loadLeaseBundle(date, original, code, grant.slots, grant.deadline);
    }
    if (this.pending.has(code)) throw new Error("LIVE_CLOUD_ATTEMPT_ALREADY_RESERVED");
    if (this.q("SELECT code FROM leases WHERE code=?", code).length) throw new Error("LIVE_CLOUD_ATTEMPT_ALREADY_RESERVED");
    if (acquisitionId && !intent) this.write(`acquisition:${code}`, { acquisitionId, deferMinute });
    let job;
    const promise = new Promise((resolve, reject) => {
      job = { date, code, original, resolve, reject, deferMinute, acquisitionId }; this.pending.set(code, job);
      // One absolute deadline notification, never repeated SQL polling.
      job.cancel = this.scheduleDeadline(Math.max(0, bounds(date).end - this.now() + 1), () => {
        if (this.pending.get(code) !== job) return;
        this.pending.delete(code); reject(new Error("LIVE_CLOUD_WINDOW_EXPIRED"));
      });
    });
    this.acquiring.set(code, { acquisitionId, promise });
    this.drain();
    try { return await promise; }
    finally { if (this.acquiring.get(code)?.promise === promise) this.acquiring.delete(code); }
  }
  async loadLeaseBundle(date, original, code, slots, deadline) {
    try {
      const ticker=retryTicker(code)??code, data = await this.bundle(date, original, ticker);
      this.check(date, true);
      if(retryTicker(code) && (data.record?.eligible!==true || data.record?.code!==ticker || data.seedContext?.contentHash!==original.seedHash))throw new Error("LIVE_CLOUD_PIN_INVALID");
      if (data.record?.eligible === false) {
        const excluded = productionPinnedExclusion({ code, input: data.record, seedContext: data.seedContext, seedReferenceDate: original.seedReferenceDate, signalDate: date });
        this.write(`pinned-exclusion:${code}`, { digest: hash(excluded) });
      }
      return { ...data, ...slots, deadline, signalDate: date, seedReferenceDate: original.seedReferenceDate };
    } catch (error) {
      try { this.critical(() => this.write(observationKey(code), { code:retryTicker(code)??code, reason: safeCode(error), rawPricesStored: false })); }
      catch (recordError) { console.error(JSON.stringify({ event: "LIVE_BUNDLE_FAILURE_RECORD_FAILED", primaryCode: safeCode(error), recordingCode: safeCode(recordError) })); }
      try { this.critical(() => this.q("UPDATE leases SET completed=1 WHERE code=?", code)); }
      catch (releaseError) { console.error(JSON.stringify({ event: "LIVE_BUNDLE_LEASE_RELEASE_FAILED", primaryCode: safeCode(error), recordingCode: safeCode(releaseError) })); }
      this.drain(); throw error;
    }
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
            try {
              const s = this.slots(job.date, job.code, job.deferMinute); this.q("INSERT INTO leases VALUES (?,?,0)", job.code, deadline);
              if (job.acquisitionId) this.write(`lease-grant:${job.code}`, { date: job.date, acquisitionId: job.acquisitionId, deferMinute: job.deferMinute, slots: s, deadline });
              return s;
            }
            finally { this.inTransaction = false; }
          });
          this.pending.delete(job.code); job.cancel();
          // Never hold the queue/transaction across broker network I/O.
          Promise.resolve().then(() => this.loadLeaseBundle(job.date, job.original, job.code, slots, deadline)).then(job.resolve, job.reject);
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
  extra(date, code, kind, skipped = []) {
    this.check(date, true);
    if (!["quote", "minute"].includes(kind) || !this.q("SELECT code FROM leases WHERE code=? AND completed=0", code).length) throw new Error("LIVE_CLOUD_LEASE_INVALID");
    if (!Array.isArray(skipped) || skipped.length > 3 || new Set(skipped).size !== skipped.length || skipped.some(s => !Number.isSafeInteger(s))) throw new Error("LIVE_CLOUD_SKIP_INVALID");
    // A slow quote may miss its preallocated minute slot without making an
    // API request. Retire ONLY expired, unused cells owned by this exact lane.
    // Keep their tombstones + gross allocation count forever; never reuse IDs
    // or refund a sent/failed HTTP call. Replacement and credit are atomic.
    this.reserve(1024, 256);
    return this.transaction(() => {
      this.inTransaction = true;
      try {
        const state = this.read("allocator"); let retiredUnused = state.retiredUnused ?? 0;
        for (const slot of skipped) {
          const row = this.q("SELECT code,kind,body FROM slots WHERE slot=?", slot)[0];
          if (!row || row.code !== code || row.kind !== kind || this.now() <= slot * 220 + 20) throw new Error("LIVE_CLOUD_SKIP_INVALID");
          if (row.body) { if (JSON.parse(row.body).retiredUnused === true) continue; throw new Error("LIVE_CLOUD_SKIP_INVALID"); }
          this.q("UPDATE slots SET body=? WHERE slot=?", JSON.stringify({ retiredUnused: true, recordedAt: this.now() }), slot); retiredUnused++;
        }
        const first = Math.max(state.head, Math.ceil((this.now() + 200) / 220));
        if (state.count - retiredUnused >= PRODUCTION_BUDGET.marketCalls || first * 220 + 20 >= bounds(date).end) throw new Error("LIVE_CLOUD_RETRY_BUDGET");
        this.q("INSERT INTO slots VALUES (?,?,?,NULL)", first, code, kind);
        // Reconnection is for an unreceived initial grant only. Once the owner
        // advances to minute/retry reservation, never replay that grant again.
        if (this.read(`acquisition:${code}`) && !this.read(`lease-expanded:${code}`)) this.write(`lease-expanded:${code}`, { slot: first, kind });
        this.write("allocator", { head: first + 1, count: state.count + 1, retiredUnused }, true);
        return { slot: first, notBefore: first * 220 };
      } finally { this.inTransaction = false; }
    });
  }
  complete(date, code, value) {
    try { return this.critical(() => {
      this.reserve(2048, 512);
      return this.transaction(() => {
        this.inTransaction = true;
        try { return this.completeReserved(date, code, value); } finally { this.inTransaction = false; }
      });
    }); } catch (error) {
      if(error.rateIssue)try{this.critical(()=>this.write(rejectionKey(code),{code:retryTicker(code)??code,issue:error.rateIssue,
        startOffsetMs:error.startOffsetMs??null,completionAheadMs:error.completionAheadMs??null}));}catch{/* metadata cannot replace the primary failure */}
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
    const retry=retryTicker(code);
    if (value.metadata?.code !== (retry??code) || !Array.isArray(value.calls) || value.calls.length > 16 || value.metadata.rawPricesStored !== false) throw new Error("LIVE_CLOUD_METADATA_INVALID");
    if(retry && !value.metadata.reason && (requiredRowIssues(value.metadata,date).length || !["quote","minute"].every(kind=>value.calls.some(c=>c.kind===kind && c.status===200 && !c.failure
      && c.started===Date.parse(value.metadata[`${kind}RequestedAt`]) && c.completed===Date.parse(value.metadata[`${kind}ReceivedAt`])))))throw new Error("LIVE_CLOUD_RECOVERY_EVIDENCE_INVALID");
    if (!this.q("SELECT code FROM leases WHERE code=?", code).length) throw new Error("LIVE_CLOUD_LEASE_INVALID");
    for (const c of value.calls) {
      const s = this.q("SELECT code,kind,body FROM slots WHERE slot=?", c.slot)[0];
      const issue=!s||s.code!==code||s.kind!==c.kind?"SLOT_IDENTITY":!Number.isSafeInteger(c.started)||!Number.isSafeInteger(c.completed)?"TIMESTAMP_INVALID"
        :c.started<c.slot*220?"START_BEFORE_SLOT":c.started>c.slot*220+20?"START_AFTER_SLOT":c.completed<c.started?"RESPONSE_BEFORE_REQUEST":c.completed>this.now()?"RESPONSE_AFTER_RECEIVER_CLOCK":null;
      if(issue)throw Object.assign(new Error("LIVE_CLOUD_RATE_EVIDENCE_INVALID"),{rateIssue:issue,
        startOffsetMs:Number.isSafeInteger(c.started)?c.started-c.slot*220:null,completionAheadMs:Number.isSafeInteger(c.completed)?c.completed-this.now():null});
      if (s.body && JSON.parse(s.body).retiredUnused === true) throw new Error("LIVE_CLOUD_RETIRED_SLOT_USED");
      const body = JSON.stringify(c); if (s.body && s.body !== body) throw new Error("LIVE_CLOUD_HTTP_CONFLICT");
      this.q("UPDATE slots SET body=? WHERE slot=?", body, c.slot);
    }
    // Late/error attempts are retained, never accepted as valid observations.
    this.write(observationKey(code), value.metadata);
    if(retry)try{observationFailureReasons(value.metadata);}
    catch(error){this.failure(safeCode(error),"BATCH_COLLECTION");}
    if(retry && !value.metadata.reason){
      const plan=this.read("missing-retry-plan");
      this.write(`retry-proof:${retry}`,{date,planHash:hash(plan),observationHash:hash(value.metadata)});
    }
    this.q("UPDATE leases SET completed=1 WHERE code=?", code); return { stored: true };
  }
  finish(date) {
    return this.critical(() => this.finishReserved(date));
  }
  currentOutbox() {
    const head=this.read("publication-head");
    const outbox=this.read(head?.revision>1?`outbox-revision:${head.revision}`:"outbox");
    if (head && (outbox?.delivery.publication?.revision!==head.revision || outbox.delivery.deliveryHash!==head.deliveryHash)) throw new Error("LIVE_CLOUD_HASH_MISMATCH");
    return outbox;
  }
  receiptKey(outbox) {
    const revision=outbox?.delivery.publication?.revision;
    return revision>1?`receipt-revision:${revision}`:"receipt";
  }
  retainedObservations(date,diagnostic=false) {
    const byCode=new Map();
    for(const stored of this.q("SELECT id,digest,body FROM docs WHERE id>='observation:' AND id<'observation;' ORDER BY id LIMIT 554")){
      const row=JSON.parse(stored.body);
      if (hash(row)!==stored.digest || stored.id!==`observation:${row.code}`) throw new Error("LIVE_CLOUD_HASH_MISMATCH");
      byCode.set(row.code,row);
    }
    const plan=this.read("missing-retry-plan"), recovered=new Set();
    if(plan){
      if(plan.date!==date || !Array.isArray(plan.codes) || !plan.codes.length || plan.codes.length>4 || new Set(plan.codes).size!==plan.codes.length)throw new Error("LIVE_CLOUD_RECOVERY_EVIDENCE_INVALID");
      const first=this.read(plan.revision===1?"outbox":`outbox-revision:${plan.revision}`),scope=first?.delivery.publication;
      if(scope?.status!=="PARTIAL" || scope.revision!==plan.revision || first.delivery.deliveryHash!==plan.sourceDeliveryHash
        || first.evidence.prepared.seedHash!==plan.seedHash || this.read(this.receiptKey(first))?.deliveryHash!==plan.sourceDeliveryHash
        || plan.codes.some(ticker=>!scope.missing.some(row=>row.ticker===ticker)))throw new Error("LIVE_CLOUD_RECOVERY_EVIDENCE_INVALID");
      for(const ticker of plan.codes){
        const key=`retry:${ticker}`, row=this.read(observationKey(key));
        if(!row)continue;
        if(row.code!==ticker || this.q("SELECT completed FROM leases WHERE code=?",key)[0]?.completed!==1)throw new Error("LIVE_CLOUD_RECOVERY_EVIDENCE_INVALID");
        try{observationFailureReasons(row);}
        catch(error){if(diagnostic)continue;throw error;}
        if(row.reason)continue;
        const proof=this.read(`retry-proof:${ticker}`);
        if(proof?.date!==date || proof.planHash!==hash(plan) || proof.observationHash!==hash(row)
          || this.read(rejectionKey(key)) || requiredRowIssues(row,date).length)throw new Error("LIVE_CLOUD_RECOVERY_EVIDENCE_INVALID");
        byCode.set(ticker,row);recovered.add(ticker);
      }
    }
    return {observations:[...byCode.values()],recovered};
  }
  claimMissingRetries(date) {
    return this.critical(()=>{
      const end=bounds(date).end;
      if(this.now()<bounds(date).start || this.now()+30000>=end || this.read("missing-retry-plan"))return [];
      const outbox=this.currentOutbox(), pub=outbox?.delivery.publication;
      if(pub?.status!=="PARTIAL" || this.read(this.receiptKey(outbox))?.deliveryHash!==outbox.delivery.deliveryHash)return [];
      const {prepared,coverage}=this.policyInputs(date,`live-${date}`);
      if(prepared.missingRetryEnabled!==true || coverage.status!=="PARTIAL" || coverage.universeHash!==pub.universeHash)return [];
      const allocator=this.read("allocator")??{count:0},remaining=PRODUCTION_BUDGET.marketCalls-allocator.count+(allocator.retiredUnused??0);
      const codes=coverage.missing.filter(({ticker,reason})=>{
        if(!pub.missing.some(m=>m.ticker===ticker) || this.q("SELECT completed FROM leases WHERE code=?",ticker)[0]?.completed!==1)return false;
        const original=this.read(observationKey(ticker));
        if(original?.status==="AVAILABLE" || original?.status==="EXCLUDED")return false;
        if(reason==="LIVE_CLOUD_RATE_EVIDENCE_INVALID")return this.read(rejectionKey(ticker))?.issue==="RESPONSE_AFTER_RECEIVER_CLOCK";
        return original?.reason===reason && /^(?:DIAG_(?:UNKNOWN_TRANSPORT_FAILURE|TRANSPORT_(?:CONNECTION_RESET|TIMEOUT|SOCKET|DNS|CONNECTION_REFUSED))|KIS_(?:BUSINESS_NETWORK_ERROR|RATE_LIMITED|HTTP_(?:408|429|5[0-9]{2})))$/u.test(reason);
      }).slice(0,Math.max(0,Math.min(4,Math.floor(remaining/2)))).map(row=>row.ticker);
      if(codes.length){
        this.freezeExecution(date,`POLICY_R${pub.revision}`,"COMPLETE");
        this.write("missing-retry-plan",{date,codes,seedHash:prepared.seedHash,sourceDeliveryHash:outbox.delivery.deliveryHash,revision:pub.revision,claimedAt:new Date(this.now()).toISOString()});
      }
      return codes;
    });
  }
  policyInputs(date,runId) {
    this.check(date);
    const prepared=this.read("final");
    if (!prepared || prepared.targetDate!==date || !/^[a-f0-9]{40}$/u.test(prepared.inputCommit??"")
      || !Number.isFinite(Date.parse(prepared.readyAt)) || Date.parse(prepared.readyAt)>=bounds(date).start
      || !Number.isFinite(Date.parse(prepared.remoteCheckedAt)) || Date.parse(prepared.remoteCheckedAt)>=bounds(date).start)
      throw new Error("LIVE_CLOUD_PIN_INVALID");
    const owner=this.read("batch-journal-owner");
    if (owner && owner.runId!==runId) throw new Error("LIVE_CLOUD_DATE_CONFLICT");
    const archived=this.read("batch-reconciliation");
    if (archived && (archived.runId??`live-${date}`)!==runId) throw new Error("LIVE_CLOUD_DATE_CONFLICT");
    let journal=archived ? this.reconcileBatches(date,archived,false) : this.reconcileJournal(date,runId,false,true);
    // The cutoff snapshot is immutable. A late original child may replace its
    // placeholder only for this evaluation; all real errors still reach policy.
    if(archived && journal.batches.some(batch=>batch.workflowStatus==="unknown")){
      const batches=journal.batches.map((batch,index)=>batch.workflowStatus==="unknown"?this.read(`batch-result:${index}`)??batch:batch);
      const firstFailure=batches.flatMap(batch=>batch.failures.map(row=>({...row,batchId:batch.id})))[0]??null;
      journal=this.reconcileBatches(date,{...journal,batches,firstFailure},false);
    }
    const failures=journal.batches.flatMap(batch=>batch.failures);
    const {observations,recovered}=this.retainedObservations(date);
    for (const stored of this.q("SELECT id,digest,body FROM docs WHERE id>='rate-rejection:' AND id<'rate-rejection;' ORDER BY id LIMIT 554")) {
      const row=JSON.parse(stored.body);
      if (hash(row)!==stored.digest || stored.id!==`rate-rejection:${row.code}`) throw new Error("LIVE_CLOUD_HASH_MISMATCH");
      failures.push({code:row.code,reason:"LIVE_CLOUD_RATE_EVIDENCE_INVALID",failureStage:"COLLECTION",...(!recovered.has(row.code)?{evidenceSource:"RATE_REJECTION"}:{})});
    }
    const failed=this.read("last-failure");
    // An earlier private relay/old finalize verdict is not a collection input.
    const previousPolicyVerdict=failed?.stage==="FINALIZE" && failed.code==="LIVE_CLOUD_REQUIRED_INPUT_MISSING";
    const globalFailure=this.read("policy-global-failure") ?? (failed && failed.stage!=="RELAY" && !previousPolicyVerdict ? failed : null);
    const options={failures,globalFailure};
    return {prepared,observations,options,coverage:evaluateCollectionPolicy(prepared,observations,options)};
  }
  publicationStatus(date,runId) {
    return this.critical(()=>{
      if(this.read("date")?.date!==date)throw new Error("LIVE_CLOUD_NOT_PREPARED");
      return this.policyInputs(date,runId).coverage;
    });
  }
  refreshPublication(date,runId) {
    return this.critical(()=>{
      this.check(date);
      const existing=this.currentOutbox(), previous=existing?.delivery.publication;
      if(existing && (!previous || previous.status==="COMPLETE")) return {status:"OUTBOX_FROZEN",publication:previous??null};
      const {prepared,observations,options,coverage}=this.policyInputs(date,runId);
      if (previous) {
        const priorMissing=new Set(previous.missing.map(row=>row.ticker));
        if (previous.universeHash!==coverage.universeHash || coverage.missing.some(row=>!priorMissing.has(row.ticker))) throw new Error("LIVE_CLOUD_REVISION_CONFLICT");
        const pending=new Set(coverage.missing.map(row=>row.ticker));
        const retained=new Map(observations.filter(row=>!pending.has(row.code)).map(row=>[row.code,hash(row)]));
        if(existing.evidence.observations.some(row=>retained.get(row.code)!==hash(row))) throw new Error("LIVE_CLOUD_REVISION_CONFLICT");
        const receipt=this.read(this.receiptKey(existing));
        if (receipt && (receipt.status!=="PRIVATE_RELAY_VERIFIED" || receipt.deliveryHash!==existing.delivery.deliveryHash)) throw new Error("LIVE_CLOUD_REVISION_CONFLICT");
        if (coverage.validCount===previous.validCount || !receipt) return {status:"OUTBOX_FROZEN",publication:previous};
      }
      if (coverage.status==="WITHHELD") return {status:"WITHHELD",coverage};
      const now=new Date(this.now()).toISOString(), revision=(previous?.revision??0)+1;
      const result=aggregateProduction(prepared,observations,now,{...options,revision,previousDeliveryHash:existing?.delivery.deliveryHash??null,firstIssuedAt:previous?.firstIssuedAt??now});
      // Keep every immutable outbox and change the selected revision in the same SQLite transaction.
      this.reserve(512,128);
      this.transaction(()=>{
        this.inTransaction=true;
        try {
          this.write(revision===1?"outbox":`outbox-revision:${revision}`,result);
          this.write("publication-head",{revision,deliveryHash:result.delivery.deliveryHash},true);
        } finally { this.inTransaction=false; }
      });
      return {status:"OUTBOX_FROZEN",publication:result.delivery.publication};
    });
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
  async relay(date, remote = this.remote, {watchdog=false,watchSlot=null}={}) {
    this.critical(() => this.check(date));
    const outbox = this.critical(() => this.currentOutbox()); if (!outbox) throw new Error("LIVE_CLOUD_NO_OUTBOX");
    const publication=outbox.delivery.publication,receiptKey=this.receiptKey(outbox), receipt = this.critical(() => this.read(receiptKey));
    if (receipt) return publication?{...receipt,publication}:receipt;
    const blocked=publication&&this.critical(()=>this.read("policy-global-failure"));
    if(blocked)throw new Error(safeCode(blocked));
    // Early network failures must not consume the approved close-time relay
    // slots. Preserve the original early counter; at most four late attempts
    // cover the closing parent plus15:31/33/35. Both counters survive restart.
    const late=this.now()>bounds(date).end;
    if(watchdog){const scheduled=Date.parse(`${date}T${watchSlot?.slice(0,2)}:${watchSlot?.slice(2)}:00+09:00`);
      if(!["1415","1515"].includes(watchSlot)||!Number.isFinite(scheduled)||this.now()<scheduled||this.now()>scheduled+120000)throw Error("LIVE_CLOUD_WATCH_RELAY_SLOT_INVALID");
    }
    const key=watchdog?"relay-watch-attempt":late?"relay-late-attempt":"relay-attempt",limit=watchdog?2:late?4:3;
    const attempt = this.critical(() => this.read(key)) ?? { count: 0, next: 0 };
    if (attempt.count >= limit || attempt.next > this.now()) throw new Error("LIVE_CLOUD_RELAY_BACKOFF");
    this.critical(() => this.write(key, { count: attempt.count + 1, next: this.now() + 60000 }, true));
    await remote.writeImmutable(`cloud-live-score-evidence-v1/${date}/${outbox.evidence.contentHash}.json`, outbox.evidence);
    // Freeze selections/first issuance before delivery. Restart or relay retry
    // cannot regenerate the five-session record with a later creation time.
    if (!publication && !outbox.swing) throw new Error("LIVE_CLOUD_SWING_OUTBOX_MISSING");
    if (!publication) await persistCloudSwingIntent(remote, outbox.swing);
    const result = await deliverPrivateLive(remote, outbox.delivery, { clock: () => new Date(this.now()).toISOString() });
    // Only the verified canonical COMPLETE head can create its performance intent.
    if (publication?.status==="COMPLETE") {
      if (!result.publishedAt) throw new Error("LIVE_CLOUD_SWING_ISSUANCE_INVALID");
      const swing=buildCloudSwingIntent(outbox.evidence,outbox.delivery,result.publishedAt);
      await persistCloudSwingIntent(remote,swing);
    }
    this.critical(() => this.write(receiptKey, result));return publication?{...result,publication}:result;
  }
  reconcileBatches(date, value, persist=true) {
    return this.critical(() => {
      this.check(date);
      const prepared = this.read("final");
      const runId = value?.runId ?? `live-${date}`, runPattern = new RegExp(`^live-${date}(?:-recovery-[A-Za-z0-9_-]{1,24})?$`, "u");
      const size=prepared?.batchSize??8;
      if (!prepared || ![4,8].includes(size) || value?.schemaVersion !== 1 || value.date !== date || !runPattern.test(runId ?? "") || !Array.isArray(value.batches) || value.batches.length !== Math.ceil(prepared.codes.length / size))
        throw new Error("LIVE_CLOUD_CHILD_RESULTS_INVALID");
      const flattened = [], failed = new Set();
      for (const [index, batch] of value.batches.entries()) {
        const expected = prepared.codes.slice(index * size, index * size + size);
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
      return persist?this.write("batch-reconciliation", value):value;
    });
  }
  failure(code, stage = "UNSPECIFIED_LEGACY") { return this.critical(() => {
    if(stage!=="RELAY" && !isLiveMissingReason(code) && !(stage==="FINALIZE" && code==="LIVE_CLOUD_REQUIRED_INPUT_MISSING")
      && !this.read("policy-global-failure")) this.write("policy-global-failure",{code,stage});
    const prior = this.read("last-failure");
    return prior ?? this.write("last-failure", { code, stage, at: new Date(this.now()).toISOString() });
  }); }
  // Child invocations write one immutable price-free outcome. The parent reads
  // these local SQL records instead of issuing70+ Workflow status API calls.
  fixedBatch(date, runId, codes) {
      this.check(date);const p=this.read("final"),size=p?.batchSize??8;
      const at=Array.isArray(codes)?p?.codes.indexOf(codes[0]):-1;
      if(!p||![4,8].includes(size)||!new RegExp(`^live-${date}(?:-recovery-[A-Za-z0-9_-]{1,24})?$`,"u").test(runId??"")
        ||!Array.isArray(codes)||at<0||at%size||JSON.stringify(codes)!==JSON.stringify(p.codes.slice(at,at+size)))throw new Error("LIVE_CLOUD_CHILD_RESULTS_INVALID");
      const owner=this.read("batch-journal-owner");if(owner&&owner.runId!==runId)throw new Error("LIVE_CLOUD_DATE_CONFLICT");
      return { prepared: p, index: at / size, owner };
  }
  recoverBatchAcknowledgement(date, runId, codes, reason) {
    return this.critical(() => {
      const { prepared } = this.fixedBatch(date, runId, codes);
      if (!["DIAG_UNKNOWN_TRANSPORT_FAILURE","DIAG_TRANSPORT_CONNECTION_RESET","DIAG_TRANSPORT_SOCKET","DIAG_TRANSPORT_TIMEOUT"].includes(reason)
        || prepared.targetDate !== date || prepared.readiness !== "READY" || this.read("date")?.date !== date || this.read("policy-global-failure"))
        throw new Error("LIVE_CLOUD_ACK_UNVERIFIED");
      for (const code of codes) {
        const row = this.read(`observation:${code}`);
        if (row?.code !== code || row.reason || row.failureStage || this.read(`rate-rejection:${code}`)
          || this.q("SELECT completed FROM leases WHERE code=?", code)[0]?.completed !== 1)
          throw new Error("LIVE_CLOUD_ACK_UNVERIFIED");
        if (prepared.eligibleCodes.includes(code)) {
          if (requiredRowIssues(row,date).length) throw new Error("LIVE_CLOUD_ACK_UNVERIFIED");
        } else {
          const excluded={...row};delete excluded.retryEvidence;
          if (excluded.status !== "EXCLUDED" || excluded.seedHash !== prepared.seedHash || excluded.seedReferenceDate !== prepared.seedReferenceDate
            || this.read(`pinned-exclusion:${code}`)?.digest !== hash(excluded)) throw new Error("LIVE_CLOUD_ACK_UNVERIFIED");
        }
      }
      const output = {attempted:codes.length, successful:codes.length, failed:[], sourcePricesIncluded:false, recoveredFetchError:reason};
      this.storeBatchResult(date,runId,codes,{status:"complete",output},reason);
      return output;
    });
  }
  recordBatchResult(date, runId, codes, result) {
    return this.storeBatchResult(date,runId,codes,result,null);
  }
  storeBatchResult(date, runId, codes, result, recoveredFetchError) {
    return this.critical(()=>{
      const { index, owner } = this.fixedBatch(date,runId,codes),output=result?.output;
      if(!["complete","errored"].includes(result?.status)||result.status==="complete"&&(!output||output.attempted!==codes.length||!Number.isSafeInteger(output.successful)
        ||output.successful<0||!Array.isArray(output.failed)||output.successful+output.failed.length!==codes.length
        ||new Set(output.failed.map(r=>r.code)).size!==output.failed.length||output.failed.some(r=>!codes.includes(r.code)||safeCode({code:r.reason})!==r.reason))
        ||result.status==="errored"&&safeCode({code:result.reason})!==result.reason)throw new Error("LIVE_CLOUD_CHILD_RESULTS_INVALID");
      const failures=result.status==="complete"?output.failed.map(r=>({code:r.code,reason:r.reason,failureStage:["LEASE_ACQUIRE","LEASED_SETUP","COLLECTION"].includes(r.failureStage)?r.failureStage:"UNKNOWN"}))
        :codes.map(code=>({code,reason:result.reason,failureStage:"UNKNOWN"}));
      const value={id:`${runId}-batch${index}`,codes,workflowStatus:result.status,attempted:result.status==="complete"?codes.length:0,
        successful:result.status==="complete"?output.successful:0,failures,...(recoveredFetchError?{recoveredFetchError}:{})};
      if(!owner)this.write("batch-journal-owner",{runId});
      this.write(`batch-result:${index}`,value);return{status:"BATCH_RESULT_STORED",index};
    });
  }
  reconcileJournal(date,runId,deadline=false,inspect=false) {
    return this.critical(()=>{
      this.check(date);const p=this.read("final"),size=p?.batchSize??8;
      if(!p||![4,8].includes(size)||!new RegExp(`^live-${date}(?:-recovery-[A-Za-z0-9_-]{1,24})?$`,"u").test(runId??""))throw new Error("LIVE_CLOUD_NOT_PREPARED");
      const owner=this.read("batch-journal-owner");if(owner&&owner.runId!==runId)throw new Error("LIVE_CLOUD_DATE_CONFLICT");
      const batches=[];let missing=0;
      for(let i=0;i<p.codes.length;i+=size){const index=i/size,codes=p.codes.slice(i,i+size),stored=this.read(`batch-result:${index}`);
        if(stored)batches.push(stored);else{missing++;batches.push({id:`${runId}-batch${index}`,codes,workflowStatus:"unknown",attempted:0,successful:0,
          failures:codes.map(code=>({code,reason:"LIVE_CLOUD_CHILD_RESULT_MISSING",failureStage:"UNKNOWN"}))});}}
      if(missing&&!deadline&&!inspect)return{ready:false,pendingBatches:missing,totalBatches:batches.length};
      const firstFailure=batches.flatMap(batch=>batch.failures.map(r=>({...r,batchId:batch.id})))[0]??null;
      const inventory={schemaVersion:1,date,runId,batches,firstFailure};
      if(inspect)return this.reconcileBatches(date,inventory,false);
      this.reconcileBatches(date,inventory);
      // Workflow step output retains every failure separately from the first
      // durable error. A nonrequired quote error must not hide lease failures.
      const failureSummary=batches.flatMap(batch=>batch.failures.map(row=>({code:row.code,reason:row.reason,
        failureStage:row.failureStage,required:p.eligibleCodes.includes(row.code)})));
      return{ready:true,pendingBatches:missing,totalBatches:batches.length,firstFailure,failureSummary};
    });
  }
  freezeExecution(date, event, workflowState = "RUNNING", error = undefined) {
    return this.critical(() => {
      assertProduction(this.env);
      if (!validExecutionEvent(event) || this.read("date")?.date !== date) throw new Error("LIVE_CLOUD_DATE_CONFLICT");
      const frozen = this.read(`execution-status:${event}`); if (frozen) return frozen;
      if(event==="POLICY_GLOBAL_BLOCKED"){
        const plan=this.read("missing-retry-plan"), blocked=this.read("policy-global-failure");
        let prior;
        if(plan)for(let n=this.read("publication-head")?.revision??plan.revision;n>=plan.revision;n--){
          const saved=this.read(`execution-status:POLICY_R${n}`);
          if(saved?.delivery.verified){prior=saved;break;}
        }
        if(!prior?.delivery.verified || !blocked || isLiveMissingReason(blocked.code))throw new Error("LIVE_CLOUD_RECOVERY_EVIDENCE_INVALID");
        // The prior issued snapshot is independently verified. Reading the failed
        // retry as a normal observation would hide the global warning itself.
        const body={...prior,event,recordedAt:new Date(this.now()).toISOString(),workflowState:"ERRORED",error:{code:blocked.code,stage:blocked.stage}};
        delete body.recordHash;
        return this.write(`execution-status:${event}`,sealExecutionRecord(body));
      }
      const revision=event.startsWith("POLICY_R")?Number(event.slice(8)):null;
      const initial=this.read("prewarm"), final=this.read("final");
      const outbox=revision?this.read(revision===1?"outbox":`outbox-revision:${revision}`):this.currentOutbox(),receipt=this.read(this.receiptKey(outbox));
      const publication=outbox?.delivery.publication;
      const coverage=event.startsWith("POLICY_W") ? this.publicationStatus(date,`live-${date}`)
        : publication ? {status:publication.status,targetCount:publication.targetCount,validCount:publication.validCount,missing:publication.missing,universeHash:publication.universeHash} : null;
      if (event.startsWith("POLICY_W") && (coverage.status!=="WITHHELD" || event!==`POLICY_W${coverage.missing.length}`)
        || event.startsWith("POLICY_R") && (!receipt || event!==`POLICY_R${publication?.revision}`)) throw new Error("LIVE_CLOUD_REVISION_CONFLICT");
      const {observations}=this.retainedObservations(date);
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
      // A failed batch can still contain valid durable per-symbol records.
      // Count each symbol once in this diagnostic DTO. Reconciliation remains
      // failed and the original quality/publication gates remain unchanged.
      const failedCodes=new Set([...observedFailed,...reconciledFailures.keys()].filter(code=>!["AVAILABLE","EXCLUDED"].includes(byCode.get(code)?.status)));
      const allowedStages=["PREPARE","FINAL_INPUT","CREATE_BATCHES","BATCH_COLLECTION","FINALIZE","RELAY"];
      const value=sealExecutionRecord({schemaVersion:coverage?2:1,...(coverage?{coverage}:{}),namespace:EXECUTION_PREFIX,source:"CLOUDFLARE_DURABLE_STATE",signalDate:date,runId:`live-${date}`,
        recordedAt:new Date(this.now()).toISOString(),event,workflowState,
        error:failure?{code:safeCode({code:failure.code}),stage:allowedStages.includes(failure.stage)?failure.stage:"UNKNOWN"}:null,
        input:{initialReady:!!initial,finalReady:!!final,seedReferenceDate:final?.seedReferenceDate??initial?.seedReferenceDate??null,
          checkedAt:final?.remoteCheckedAt??initial?.remoteCheckedAt??null,initialReadyAt:initial?.readyAt??null,finalReadyAt:final?.readyAt??null},
        collection:{expected:553,eligible:final?.eligible??null,available,excluded,failed:failedCodes.size,missing:553-available-excluded-failedCodes.size,
          requiredMissing:coverage?coverage.missing.length:final?.eligibleCodes?final.eligibleCodes.filter(c=>byCode.get(c)?.status!=="AVAILABLE").length:null,
          activeLeases:this.q("SELECT code FROM leases WHERE completed=0 AND expires>?",this.now()).length,firstRequestedAt:first,lastReceivedAt:last},
        validation:{outboxFrozen:!!outbox,deliveryHash:outbox?.delivery?.deliveryHash??null,frozenAt:outbox?.delivery?.exportedAt??null},
        delivery:{verified:receipt?.status==="PRIVATE_RELAY_VERIFIED",deliveryHash:receipt?.deliveryHash??null}});
      return this.write(`execution-status:${event}`,value);
    });
  }
  incidentStatus(qualityAudit=false) {
    return this.critical(() => {
      const prepared = this.read("final"), expected = prepared?.codes ?? [];
      const {observations,recovered}=this.retainedObservations(prepared?.targetDate,true);
      const leases = this.q("SELECT code,expires,completed FROM leases WHERE code<'retry:' ORDER BY code LIMIT 554"), reconciliation = this.read("batch-reconciliation");
      const seen = new Set(observations.map(r => r.code));
      const reconciledFailures = new Map((reconciliation?.batches ?? []).flatMap(batch => batch.failures).map(row => [row.code, row]));
      const failed = new Map(observations.filter(r => !["AVAILABLE", "EXCLUDED"].includes(r.status)).map(r => [r.code, { reason: r.reason, failureStage: r.failureStage ?? "UNKNOWN" }]));
      for (const [code, row] of reconciledFailures) if (!seen.has(code)) failed.set(code, row);
      const rateRows=this.q("SELECT digest,body FROM docs WHERE id>='rate-rejection:' AND id<'rate-rejection;' ORDER BY id LIMIT 554").map(r=>{const v=JSON.parse(r.body);if(hash(v)!==r.digest)throw new Error("LIVE_CLOUD_HASH_MISMATCH");return v;});
      const rateRejections=rateRows.slice(0,5),rateIssueCounts={};for(const row of rateRows)rateIssueCounts[row.issue]=(rateIssueCounts[row.issue]??0)+1;
      const failedSamples=observations.filter(r=>!["AVAILABLE","EXCLUDED"].includes(r.status)).slice(0,5).map(r=>({code:r.code,reason:r.reason,
        failureStage:r.failureStage??"UNKNOWN",failedEndpoint:r.failedEndpoint??null,httpStatus:r.httpStatus??null,providerFailureCode:r.providerFailureCode??null}));
      let quality;
      if(qualityAudit && prepared){const byCode=new Map(observations.map(row=>[row.code,row]));
        const rejected=prepared.eligibleCodes.flatMap(code=>{const issues=requiredRowIssues(byCode.get(code),prepared.targetDate);return issues.length?[{code,issues}]:[];});
        quality={targetDate:prepared.targetDate,checked:prepared.eligibleCodes.length,passed:prepared.eligibleCodes.length-rejected.length,rejected};}
      return { ...this.status(), ...(quality?{quality}:{}), rateRejections, rateIssueCounts, failedSamples, lastFailure: this.read("last-failure"), universe: expected.length, eligible: prepared?.eligible ?? null,
        seedReferenceDate: prepared?.seedReferenceDate ?? null, inputCommit: prepared?.inputCommit ?? null,
        completed: observations.filter(r => ["AVAILABLE", "EXCLUDED"].includes(r.status)).length,recoveredCodes:[...recovered],globalFailure:this.read("policy-global-failure"),
        failed: [...failed].map(([code, row]) => ({ code, reason: row.reason, failureStage: row.failureStage })),
        missing: expected.filter(code => !seen.has(code) && !reconciledFailures.has(code)),
        leases: leases.map(r => ({ code: r.code, status: r.completed ? "COMPLETED" : r.expires <= this.now() ? "EXPIRED_NOT_REUSABLE" : "ACTIVE" })),
        observationTimeBounds: observations.length ? {
          first: observations.map(r => r.quoteRequestedAt).filter(Boolean).sort()[0] ?? null,
          last: observations.map(r => r.minuteReceivedAt).filter(Boolean).sort().at(-1) ?? null } : null,
        sourcePricesIncluded: false };
    });
  }
  status() { return this.critical(() => { const outbox=this.currentOutbox(); return { prepared: Boolean(this.read("prewarm")), finalInputReady: Boolean(this.read("final")),
    outbox: Boolean(outbox), publication:outbox?.delivery.publication??null,receipt: this.read(this.receiptKey(outbox)), meteredSql: { ...this.meter }, runtimeCursorSql: { ...this.cursorUsage }, usageUpdates: this.usageUpdates,
    sqliteBytes: this.sql.databaseSize, retainedBytesLimit: PRODUCTION_BUDGET.retainedBytesPerDay,
    waitingInMemory: this.pending.size, rawPricesStored: false }; }); }
}
