import { DurableObject, WorkflowEntrypoint } from "cloudflare:workers";
import { fixture, calculateFixture, summarize, shards, SPACING_MS, SHARD_SIZE, fetchWithoutRedirects } from "../core.mjs";
import { hashIntradayModelTop } from "../../../lib/intraday-model-top-official-signal.mjs";

const config = { retries: { limit: 1, delay: "1 second", backoff: "constant" }, timeout: "10 minutes" };
const assertSynthetic = env => { if (env.LIVE_ENABLED !== "false" || env.SYNTHETIC_ONLY !== "true") throw new Error("PROBE_FAIL_CLOSED"); };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// No KIS/GitHub credentials or external price endpoints in this deployment.
// A real broker must keep the same single-flight/auth/rate contract but requires
// separate source rights and actual 9443 reachability validation.
export class SyntheticBroker extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env); this.queue = Promise.resolve(); this.inFlight = new Map();
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS calls (id TEXT PRIMARY KEY, started INTEGER NOT NULL, completed INTEGER NOT NULL)");
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS state (id TEXT PRIMARY KEY, value INTEGER NOT NULL)");
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS results (id TEXT PRIMARY KEY, digest TEXT NOT NULL, body TEXT NOT NULL)");
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS shards (id INTEGER PRIMARY KEY, digest TEXT NOT NULL, body TEXT NOT NULL)");
  }
  async fetch(request) {
    assertSynthetic(this.env);
    const url = new URL(request.url), id = url.searchParams.get("id");
    if (url.pathname === "/transport") {
      const checks = [];
      for (const target of ["https://openapi.koreainvestment.com:9443/", "https://api.github.com/rate_limit"]) {
        const startedAt = Date.now();
        try {
          const response = await fetchWithoutRedirects(target, { method: "GET", signal: AbortSignal.timeout(10000) });
          await response.body?.cancel(); checks.push({ host: new URL(target).host, httpStatus: response.status, wallMs: Date.now() - startedAt });
        } catch (error) {
          const reason = /^PROBE_[A-Z_]+$/u.test(error.message ?? "") ? error.message : "PROBE_PUBLIC_TRANSPORT_FAILED";
          checks.push({ host: new URL(target).host, verified: false, reason, wallMs: Date.now() - startedAt });
        }
      }
      return Response.json({ revision: "strict-transport-v8", syntheticOnly: true, checks, actualKisAuthentication: false, actualKisQuotes: 0 });
    }
    if (url.pathname === "/seed-stress") {
      const records = Array.from({ length: 553 }, (_, index) => ({ index, ...fixture(index) }));
      const serialized = JSON.stringify(records), digest = hashIntradayModelTop(records);
      const reread = JSON.parse(serialized);
      if (hashIntradayModelTop(reread) !== digest) throw new Error("PROBE_SEED_HASH_MISMATCH");
      let largestShardBytes = 0;
      for (let offset = 0; offset < reread.length; offset += SHARD_SIZE) {
        largestShardBytes = Math.max(largestShardBytes, new TextEncoder().encode(JSON.stringify(reread.slice(offset, offset + SHARD_SIZE))).byteLength);
      }
      return Response.json({ revision: "free-probe-v6", syntheticOnly: true, symbols: 553, rowsPerSymbol: 260,
        serializedBytes: new TextEncoder().encode(serialized).byteLength, digest, hashRoundTripVerified: true, largestShardBytes,
        memoryLimitExceeded: false, actualKisDataUsed: false, permanentRawStorage: false });
    }
    if (url.pathname === "/batch") {
      const start = Number(url.searchParams.get("start")), count = Number(url.searchParams.get("count"));
      const runId = url.searchParams.get("runId");
      if (!Number.isInteger(start) || !Number.isInteger(count) || start < 0 || count < 1 || count > SHARD_SIZE
        || start + count > 553 || !/^[a-zA-Z0-9_-]{1,48}$/u.test(runId ?? "")) return new Response(null, { status: 400 });
      const existing = this.ctx.storage.sql.exec("SELECT digest,body FROM shards WHERE id=?", start).toArray()[0];
      if (existing) {
        const value = JSON.parse(existing.body);
        if (hashIntradayModelTop(value) !== existing.digest || value.records.length !== count) return new Response(null, { status: 409 });
        return Response.json(value);
      }
      const records = await Promise.all(Array.from({ length: count }, async (_, i) => {
        const index = start + i;
        if (url.searchParams.get("io") === "true") for (const kind of ["quote", "minute"]) {
          const response = await this.fetch(new Request(`https://synthetic/request?id=${runId}-${index}-${kind}`));
          if (!response.ok) throw new Error("PROBE_REQUEST_FAILED"); await response.json();
        }
        // Existing exact score functions, now under the documented 30s DO CPU
        // budget instead of relying on Workflow Free's 10ms burst behavior.
        return calculateFixture(index);
      }));
      const value = { start, records, syntheticOnly: true };
      const response = await this.fetch(new Request("https://synthetic/shard", { method: "POST", body: JSON.stringify(value) }));
      if (!response.ok) throw new Error("PROBE_SHARD_STORE_FAILED");
      return Response.json(value);
    }
    if (url.pathname === "/shard") {
      const value = await request.json(), hash = hashIntradayModelTop(value);
      if (!Number.isInteger(value.start) || value.start < 0 || value.start >= 553 || value.syntheticOnly !== true
        || !Array.isArray(value.records) || value.records.length < 1 || value.records.length > SHARD_SIZE) return new Response(null, { status: 400 });
      const existing = this.ctx.storage.sql.exec("SELECT digest FROM shards WHERE id=?", value.start).toArray()[0];
      if (existing && existing.digest !== hash) return new Response(null, { status: 409 });
      if (!existing) this.ctx.storage.sql.exec("INSERT INTO shards VALUES (?,?,?)", value.start, hash, JSON.stringify(value));
      return Response.json({ hash, disposition: existing ? "existing" : "created" });
    }
    if (url.pathname === "/aggregate") {
      const rows = this.ctx.storage.sql.exec("SELECT digest,body FROM shards ORDER BY id").toArray();
      const records = rows.flatMap(row => {
        const value = JSON.parse(row.body); if (hashIntradayModelTop(value) !== row.digest) throw new Error("PROBE_SHARD_HASH_MISMATCH");
        return value.records;
      });
      const count = Number(url.searchParams.get("count"));
      if (records.length !== count) return Response.json({ reason: "PROBE_PARTIAL_COLLECTION", count: records.length }, { status: 409 });
      const summary = summarize(records);
      if (summary.scoresHash !== url.searchParams.get("hash")) return Response.json({ reason: "PROBE_NODE_WORKER_MISMATCH" }, { status: 409 });
      const network = this.ctx.storage.sql.exec("SELECT COUNT(*) AS calls,MIN(started) AS firstAt,MAX(started) AS lastAt FROM calls").one();
      const spacing = this.ctx.storage.sql.exec("SELECT MIN(gap) AS minimumSpacingMs FROM (SELECT started-LAG(started) OVER (ORDER BY started) AS gap FROM calls)").one();
      return Response.json({ ...summary, network: { ...network, ...spacing }, syntheticOnly: true, eligibleForProduction: false, shards: rows.length });
    }
    if (url.pathname === "/result") {
      if (request.method === "GET") {
        const row = this.ctx.storage.sql.exec("SELECT digest,body FROM results WHERE id='result'").toArray()[0];
        return row ? Response.json({ hash: row.digest, value: JSON.parse(row.body), syntheticOnly: true }) : new Response(null, { status: 404 });
      }
      if (request.method !== "POST") return new Response(null, { status: 405 });
      const text = await request.text(); if (text.length > 20000) return new Response(null, { status: 413 });
      const value = JSON.parse(text);
      if (value.syntheticOnly !== true || value.eligibleForProduction !== false) return new Response(null, { status: 400 });
      const hash = hashIntradayModelTop(value);
      const previous = this.ctx.storage.sql.exec("SELECT digest FROM results WHERE id='result'").toArray()[0];
      if (previous && previous.digest !== hash) return new Response(null, { status: 409 });
      if (!previous) this.ctx.storage.sql.exec("INSERT INTO results VALUES ('result',?,?)", hash, text);
      return Response.json({ hash, disposition: previous ? "existing" : "created", syntheticOnly: true });
    }
    if (url.pathname === "/status") {
      const result = this.ctx.storage.sql.exec("SELECT COUNT(*) AS calls, MIN(started) AS firstAt, MAX(started) AS lastAt FROM calls").one();
      const spacing = this.ctx.storage.sql.exec("SELECT MIN(gap) AS minimumSpacingMs FROM (SELECT started-LAG(started) OVER (ORDER BY started) AS gap FROM calls)").one();
      return Response.json({ ...result, ...spacing, syntheticOnly: true, authentication: "SYNTHETIC_NOT_KIS" });
    }
    if (url.pathname !== "/request" || !/^[a-zA-Z0-9_-]{1,120}$/u.test(id ?? "")) return new Response(null, { status: 400 });
    const reservation = this.queue.then(async () => {
      const previous = this.ctx.storage.sql.exec("SELECT started,completed FROM calls WHERE id=?", id).toArray()[0];
      if (previous?.completed) return { response: Promise.resolve({ ...previous, disposition: "existing" }) };
      if (this.inFlight.has(id)) return { response: this.inFlight.get(id) };
      if (previous) throw new Error("PROBE_INTERRUPTED_REQUEST_REQUIRES_REVIEW");
      while (this.inFlight.size >= 2) await Promise.race(this.inFlight.values());
      const count = this.ctx.storage.sql.exec("SELECT value FROM state WHERE id='count'").toArray()[0]?.value ?? 0;
      if (count >= 2400) throw new Error("PROBE_REQUEST_BUDGET_EXHAUSTED");
      const last = this.ctx.storage.sql.exec("SELECT value FROM state WHERE id='lastStart'").toArray()[0]?.value ?? 0;
      // Timers may wake a millisecond early. Recheck instead of relaxing the
      // 200ms start budget; the test exercises the actual deployed method.
      while (Date.now() < last + SPACING_MS) await sleep(last + SPACING_MS - Date.now());
      const started = Date.now();
      const first = this.ctx.storage.sql.exec("SELECT value FROM state WHERE id='firstStart'").toArray()[0]?.value;
      if (first !== undefined && started > first + 300000) throw new Error("PROBE_RELATIVE_COLLECTION_WINDOW_EXPIRED");
      if (first === undefined) this.ctx.storage.sql.exec("INSERT INTO state VALUES ('firstStart',?)", started);
      // Store the actual start before waiting: durable on eviction/restart.
      this.ctx.storage.sql.exec("INSERT OR REPLACE INTO state VALUES ('lastStart',?)", started);
      this.ctx.storage.sql.exec("INSERT INTO calls VALUES (?,?,0)", id, started);
      this.ctx.storage.sql.exec("INSERT OR REPLACE INTO state VALUES ('count',?)", count + 1);
      // Reserve STARTS, not response completion: allow the existing two-worker
      // policy to hide I/O latency without exceeding five starts/second.
      const response = (async () => {
        while (Date.now() < started + 250) await sleep(started + 250 - Date.now());
        const completed = Date.now();
        this.ctx.storage.sql.exec("UPDATE calls SET completed=? WHERE id=?", completed, id);
        return { started, completed, disposition: "created" };
      })().finally(() => this.inFlight.delete(id));
      this.inFlight.set(id, response);
      return { response }; // Do not flatten the response Promise into the queue.
    });
    this.queue = reservation.then(() => {}, () => {});
    try { return Response.json(await (await reservation).response); } catch { return Response.json({ reason: "PROBE_BROKER_FAILED" }, { status: 503 }); }
  }
}

export class FreeProbe extends WorkflowEntrypoint {
  async run(event, step) {
    assertSynthetic(this.env);
    const p = event.payload ?? {}, startedAt = Date.now();
    if (!/^[a-zA-Z0-9_-]{1,48}$/u.test(p.runId ?? "")) throw new Error("PROBE_RUN_ID_INVALID");
    if (p.mode === "transport-strict") return step.do("strict public transport through broker no credentials", config, async () => {
      const broker = this.env.BROKER.get(this.env.BROKER.idFromName(p.runId));
      const response = await broker.fetch("https://synthetic/transport"); return response.json();
    });
    if (p.mode === "seed-stress") return step.do("verify full synthetic history fits broker memory and hashing budget", config, async () => {
      const broker = this.env.BROKER.get(this.env.BROKER.idFromName(p.runId));
      const response = await broker.fetch("https://synthetic/seed-stress");
      if (!response.ok) throw new Error("PROBE_SEED_STRESS_FAILED"); return response.json();
    });
    if (p.mode === "audit") return step.do("audit synthetic completeness without recollection", config, async () => {
      const broker = this.env.BROKER.get(this.env.BROKER.idFromName(p.runId));
      const network = await (await broker.fetch("https://synthetic/status")).json();
      const response = await broker.fetch(`https://synthetic/aggregate?count=${p.count}&hash=${p.expectedHash}`);
      return { syntheticOnly: true, network, aggregationStatus: response.status, aggregation: await response.json() };
    });
    if (p.mode === "read") return step.do("read immutable synthetic result in later invocation", config, async () => {
      const broker = this.env.BROKER.get(this.env.BROKER.idFromName(p.runId));
      const response = await broker.fetch("https://synthetic/result");
      if (!response.ok) throw new Error("PROBE_RESULT_MISSING");
      const value = await response.json();
      if (hashIntradayModelTop(value.value) !== value.hash) throw new Error("PROBE_STORAGE_HASH_MISMATCH");
      return { ...value, verified: true, operationalPointerChanged: false };
    });
    if (p.mode === "transport") return step.do("public TLS transport only no KIS authentication", config, async () => {
      const checks = [];
      for (const url of ["https://openapi.koreainvestment.com:9443/", "https://api.github.com/rate_limit"]) {
        const start = Date.now();
        try {
          const response = await fetchWithoutRedirects(url, { method: "GET", signal: AbortSignal.timeout(10000) });
          await response.body?.cancel(); checks.push({ host: new URL(url).host, status: response.status, redirectBlocked: response.status >= 300 && response.status < 400, wallMs: Date.now() - start });
        } catch (error) { checks.push({ host: new URL(url).host, status: "TRANSPORT_FAILED", wallMs: Date.now() - start,
          errorName: String(error?.name).slice(0, 40), diagnostic: String(error?.message).slice(0, 160) }); }
      }
      return { syntheticOnly: true, checks, actualKisAuthentication: false, actualKisQuotes: 0 };
    });
    if (p.mode === "batch") {
      const plan = shards(p.count, p.size ?? SHARD_SIZE);
      const ids = await step.do("create bounded synthetic shards", config, async () => {
        const definitions = plan.map((shard, i) => ({ id: `${p.runId}-${i}`, params: { ...shard, runId: p.runId, mode: "shard", io: p.io === true } }));
        // 64 (508) / 70 (553) children, below account active-instance limit.
        if (!p.reuseExisting) await this.env.PROBE.createBatch(definitions);
        return definitions.map(row => row.id);
      });
      // Avoid continuous status polling or holding a laptop connection alive.
      await step.sleep("let server-side shards finish", p.io && !p.reuseExisting ? "230 seconds" : "10 seconds");
      return step.do("verify and aggregate unchanged scores", { ...config, retries: { limit: 3, delay: "10 seconds", backoff: "constant" } }, async () => {
        const broker = this.env.BROKER.get(this.env.BROKER.idFromName(p.runId));
        const response = await broker.fetch(`https://synthetic/aggregate?count=${p.count}&hash=${p.expectedHash}`);
        if (!response.ok) {
          const detail = await response.json();
          throw new Error(detail.reason === "PROBE_PARTIAL_COLLECTION" ? `PROBE_PARTIAL_COLLECTION_${detail.count}` : "PROBE_NODE_WORKER_MISMATCH");
        }
        const summary = await response.json();
        // Retry time is operational metadata, never part of immutable contents.
        const stored = { ...summary, syntheticOnly: true, eligibleForProduction: false, shards: ids.length,
          actualKisRequests: 0, liveActivated: false };
        const post = value => broker.fetch(new Request("https://synthetic/result", { method: "POST", body: JSON.stringify(value) }));
        const first = await post(stored), again = await post(stored), conflict = await post({ ...stored, shards: -1 });
        if (!first.ok || !again.ok || conflict.status !== 409) throw new Error("PROBE_IMMUTABLE_FAILED");
        const reread = await (await broker.fetch("https://synthetic/result")).json();
        if (reread.hash !== hashIntradayModelTop(stored)) throw new Error("PROBE_STORAGE_HASH_MISMATCH");
        return { ...stored, wallMs: Date.now() - startedAt, storage: { createReadHashVerified: true, duplicatePreserved: true, conflictBlocked: true,
          hash: reread.hash, operationalPointerChanged: false } };
      });
    }
    if (p.mode !== "shard" || !Number.isInteger(p.start) || !Number.isInteger(p.count) || p.count < 1 || p.count > SHARD_SIZE || p.start < 0 || p.start + p.count > 553) throw new Error("PROBE_SHARD_INVALID");
    const broker = this.env.BROKER.get(this.env.BROKER.idFromName(p.runId));
    const result = await step.do("collect calculate and persist bounded shard in broker", config, async () => {
      const response = await broker.fetch(`https://synthetic/batch?start=${p.start}&count=${p.count}&io=${p.io === true}&runId=${p.runId}`);
      if (!response.ok) throw new Error("PROBE_SHARD_FAILED"); return response.json();
    });
    return { count: result.records.length, syntheticOnly: true, wallMs: Date.now() - startedAt };
  }
}

// No public trigger, read API, KIS prices or cron; invoke only through the
// authenticated Cloudflare management API / Wrangler / dashboard.
const closedHttp = { fetch() { return new Response(null, { status: 404 }); } };
export default closedHttp;
