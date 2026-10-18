import { hashIntradayModelTop as hash } from "../../lib/intraday-model-top-official-signal.mjs";
import { assertPrivateKisEodPayload } from "../../lib/kis-eod-private-store.mjs";
import { deliverPrivateLive } from "../../lib/private-live-delivery.mjs";
import { assertProduction, assertWindow, bounds, aggregateProduction, nextPairSlots, PRODUCTION_BUDGET } from "./production-core.mjs";

export class ProductionDayState {
  constructor({ sql, env, prepare, bundle, remote, now = Date.now, wait = ms => new Promise(r => setTimeout(r, ms)) }) {
    this.sql = sql; this.env = env; this.prepareInput = prepare; this.bundle = bundle; this.remote = remote; this.now = now; this.wait = wait;
    this.serial = Promise.resolve();
    sql.exec("CREATE TABLE IF NOT EXISTS docs (id TEXT PRIMARY KEY,digest TEXT NOT NULL,body TEXT NOT NULL)").toArray();
    sql.exec("CREATE TABLE IF NOT EXISTS leases (code TEXT PRIMARY KEY,expires INTEGER NOT NULL,completed INTEGER NOT NULL)").toArray();
    sql.exec("CREATE INDEX IF NOT EXISTS active_lease ON leases(completed,expires)").toArray();
    sql.exec("CREATE TABLE IF NOT EXISTS slots (slot INTEGER PRIMARY KEY,code TEXT NOT NULL,kind TEXT NOT NULL,body TEXT)").toArray();
    sql.exec("CREATE TABLE IF NOT EXISTS usage (id INTEGER PRIMARY KEY,r INTEGER NOT NULL,w INTEGER NOT NULL)").toArray();
    const prior = sql.exec("SELECT r,w FROM usage WHERE id=1").toArray()[0];
    this.meter = prior ? { r: prior.r + 1, w: prior.w } : { r: 1, w: 2 };
    if (!prior) sql.exec("INSERT INTO usage VALUES (1,1,2)").toArray();
  }
  q(query, ...args) {
    if (this.meter.r + 1000 > PRODUCTION_BUDGET.sqlRowsRead || this.meter.w + 1000 > PRODUCTION_BUDGET.sqlRowsWritten) throw new Error("LIVE_CLOUD_SQL_BUDGET");
    const c = this.sql.exec(query, ...args), rows = c.toArray();
    if (!Number.isFinite(c.rowsRead) || !Number.isFinite(c.rowsWritten)) throw new Error("LIVE_CLOUD_SQL_METER_UNAVAILABLE");
    // Integer-primary-key UPDATE avoids REPLACE/delete/index churn. Reserve2
    // reads+writes for the meter itself, and verify that bound in real cursors.
    this.meter.r += c.rowsRead + 2; this.meter.w += c.rowsWritten + 2;
    const m = this.sql.exec("UPDATE usage SET r=?,w=? WHERE id=1", this.meter.r, this.meter.w); m.toArray();
    if (m.rowsRead > 2 || m.rowsWritten > 2) throw new Error("LIVE_CLOUD_SQL_METER_CHANGED");
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
    const prior = this.read("date"); if (prior && prior.date !== date) throw new Error("LIVE_CLOUD_DATE_CONFLICT");
    if (!prior) this.write("date", { date });
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
  slots(date, code) {
    const counter = this.read("allocator") ?? { head: 0, count: 0 };
    const s = nextPairSlots({ now: this.now(), head: counter.head, count: counter.count, date });
    for (const [kind, slot] of [["quote", s.quoteSlot], ["minute", s.minuteSlot]]) this.q("INSERT INTO slots VALUES (?,?,?,NULL)", slot.slot, code, kind);
    this.write("allocator", { head: s.head, count: counter.count + 2 }, true); return s;
  }
  async acquire(date, code) {
    this.check(date, true);
    const previous = this.read(`observation:${code}`); if (previous) return { existing: previous };
    const original = this.read("final"); if (!original?.codes.includes(code)) throw new Error("LIVE_CLOUD_NOT_PREPARED");
    const operation = this.serial.then(async () => {
      while (this.q("SELECT code FROM leases WHERE completed=0 AND expires>?", this.now()).length >= 8) {
        await this.wait(50); this.check(date, true);
      }
      if (this.q("SELECT code FROM leases WHERE code=?", code).length) throw new Error("LIVE_CLOUD_ATTEMPT_ALREADY_RESERVED");
      const s = this.slots(date, code), deadline = bounds(date).end;
      this.q("INSERT INTO leases VALUES (?,?,0)", code, deadline);
      // Raw prior history and the pinned bearer cross only an internal DO
      // binding into shard RAM. They are never a Workflow result or SQL record.
      const data = await this.bundle(date, original, code);
      return { ...data, ...s, deadline, signalDate: date, seedReferenceDate: original.seedReferenceDate };
    });
    this.serial = operation.then(() => {}, () => {}); return operation;
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
    this.check(date);
    if (value.metadata?.code !== code || !Array.isArray(value.calls) || value.calls.length > 16 || value.metadata.rawPricesStored !== false) throw new Error("LIVE_CLOUD_METADATA_INVALID");
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
    this.check(date);
    const existing = this.read("outbox"); if (existing) return existing.delivery;
    const prepared = this.read("final"); if (!prepared) throw new Error("LIVE_CLOUD_NOT_PREPARED");
    const observations = prepared.codes.map(code => this.read(`observation:${code}`));
    if (observations.some(r => !r)) throw new Error("LIVE_CLOUD_INCOMPLETE");
    const result = aggregateProduction(prepared, observations, new Date(this.now()).toISOString());
    this.write("outbox", result); return result.delivery;
  }
  async relay(date) {
    this.check(date);
    const outbox = this.read("outbox"); if (!outbox) throw new Error("LIVE_CLOUD_NO_OUTBOX");
    const receipt = this.read("receipt"); if (receipt) return receipt;
    const attempt = this.read("relay-attempt") ?? { count: 0, next: 0 };
    if (attempt.count >= 3 || attempt.next > this.now()) throw new Error("LIVE_CLOUD_RELAY_BACKOFF");
    this.write("relay-attempt", { count: attempt.count + 1, next: this.now() + 60000 }, true);
    await this.remote.writeImmutable(`cloud-live-score-evidence-v1/${date}/${outbox.evidence.contentHash}.json`, outbox.evidence);
    const result = await deliverPrivateLive(this.remote, outbox.delivery, { now: new Date(this.now()).toISOString() });
    return this.write("receipt", result);
  }
  status() { return { prepared: Boolean(this.read("prewarm")), finalInputReady: Boolean(this.read("final")),
    outbox: Boolean(this.read("outbox")), receipt: this.read("receipt"), meteredSql: this.meter, rawPricesStored: false }; }
}
