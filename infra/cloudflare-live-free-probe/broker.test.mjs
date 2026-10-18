import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { summarize, calculateFixture } from "./core.mjs";

// Exercise the actual deployed class with native SQLite and Web Request/Response.
// Only the Cloudflare base class / SQL cursor shell is replaced; no price API.
let source = await fs.readFile(new URL("./src/index.mjs", import.meta.url), "utf8");
source = source.replace('import { DurableObject, WorkflowEntrypoint } from "cloudflare:workers";',
  'class DurableObject { constructor(ctx,env) { this.ctx=ctx; this.env=env; } } class WorkflowEntrypoint {}');
source = source.replace('"../core.mjs"', JSON.stringify(new URL("./core.mjs", import.meta.url).href));
source = source.replace('"../../../lib/intraday-model-top-official-signal.mjs"', JSON.stringify(new URL("../../lib/intraday-model-top-official-signal.mjs", import.meta.url).href));
const { SyntheticBroker, FreeProbe } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
function sandbox(t) {
  const db = new DatabaseSync(":memory:"); t.after(() => db.close());
  const ctx = { storage: { sql: { exec(query, ...args) {
    const rows = db.prepare(query).all(...args);
    return { toArray: () => rows, one: () => { assert.equal(rows.length, 1); return rows[0]; } };
  } } } };
  const env = { LIVE_ENABLED: "false", SYNTHETIC_ONLY: "true" };
  return { db, ctx, env, broker: new SyntheticBroker(ctx, env) };
}
const post = (path, value) => new Request(`https://synthetic/${path}`, { method: "POST", body: JSON.stringify(value) });
test("actual broker preserves create-only hashes, duplicates and conflicts across re-instantiation", async t => {
  const f = sandbox(t), value = { count: 8, syntheticOnly: true, eligibleForProduction: false };
  const first = await (await f.broker.fetch(post("result", value))).json();
  const reopened = new SyntheticBroker(f.ctx, f.env);
  const duplicate = await (await reopened.fetch(post("result", value))).json();
  assert.equal(first.hash, duplicate.hash); assert.equal(duplicate.disposition, "existing");
  assert.equal((await reopened.fetch(post("result", { ...value, count: 1 }))).status, 409);
  assert.equal((await (await reopened.fetch(new Request("https://synthetic/result"))).json()).hash, first.hash);
});
test("actual rate broker overlaps 250ms I/O with five starts/second and deduplicates stored batches", async t => {
  const f = sandbox(t), url = "https://synthetic/batch?start=0&count=2&io=true&runId=local_rate";
  const response = await f.broker.fetch(new Request(url)); assert.equal(response.status, 200);
  const status = await (await f.broker.fetch(new Request("https://synthetic/status"))).json();
  assert.equal(status.calls, 4); assert.ok(status.minimumSpacingMs >= 200);
  const calls = f.db.prepare("SELECT * FROM calls ORDER BY started").all();
  assert.ok(calls[1].started < calls[0].completed, "network wait must not serialize the global start queue");
  assert.ok(calls.every(row => row.completed >= row.started + 250));
  await new SyntheticBroker(f.ctx, f.env).fetch(new Request(url));
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM calls").get().n, 4);
});
test("partial, duplicate-symbol, content conflict and tampered shard data cannot aggregate", async t => {
  const f = sandbox(t), rows = [calculateFixture(0)], hash = summarize(rows).scoresHash;
  const aggregate = () => f.broker.fetch(new Request(`https://synthetic/aggregate?count=1&hash=${hash}`));
  assert.equal((await aggregate()).status, 409);
  assert.equal((await f.broker.fetch(post("shard", { start: 0, records: rows, syntheticOnly: true }))).status, 200);
  assert.equal((await aggregate()).status, 200);
  assert.equal((await f.broker.fetch(post("shard", { start: 0, records: [calculateFixture(1)], syntheticOnly: true }))).status, 409);
  f.db.prepare("UPDATE shards SET digest=? WHERE id=0").run("a".repeat(64));
  await assert.rejects(aggregate(), /PROBE_SHARD_HASH_MISMATCH/u);
});
test("actual Workflow fanout/fanin stores and reuses exact results without per-child status polling", async t => {
  const f = sandbox(t);
  f.env.BROKER = { idFromName: name => name, get: () => ({ fetch: input => f.broker.fetch(input instanceof Request ? input : new Request(input)) }) };
  const step = { async do(_name, ...args) { return args.at(-1)(); }, async sleep() {} };
  f.env.PROBE = { async createBatch(definitions) {
    for (const definition of definitions) {
      const child = new FreeProbe(); child.env = f.env;
      await child.run({ payload: definition.params }, step);
    }
  } };
  const parent = new FreeProbe(); parent.env = f.env;
  const payload = { mode: "batch", runId: "local_e2e", count: 16, io: false,
    expectedHash: summarize(Array.from({ length: 16 }, (_, i) => calculateFixture(i))).scoresHash };
  const first = await parent.run({ payload }, step);
  assert.equal(first.storage.createReadHashVerified, true); assert.equal(first.storage.conflictBlocked, true);
  const again = await parent.run({ payload: { ...payload, reuseExisting: true } }, step);
  assert.equal(first.storage.hash, again.storage.hash); assert.equal(again.actualKisRequests, 0);
});
test("full synthetic history is hashed intact and shard payloads stay below one MiB", async t => {
  const f = sandbox(t);
  const result = await (await f.broker.fetch(new Request("https://synthetic/seed-stress"))).json();
  assert.equal(result.symbols, 553); assert.equal(result.rowsPerSymbol, 260);
  assert.equal(result.hashRoundTripVerified, true); assert.ok(result.largestShardBytes < 1024 ** 2);
  assert.equal(result.actualKisDataUsed, false); assert.equal(result.permanentRawStorage, false);
});
test("late synthetic starts and interrupted unknown requests fail closed without replacing history", async t => {
  const f = sandbox(t);
  f.db.prepare("INSERT INTO state VALUES ('firstStart',?)").run(Date.now() - 300001);
  assert.equal((await f.broker.fetch(new Request("https://synthetic/request?id=late"))).status, 503);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM calls").get().n, 0);
  f.db.prepare("INSERT INTO calls VALUES ('unknown',1,0)").run();
  assert.equal((await new SyntheticBroker(f.ctx, f.env).fetch(new Request("https://synthetic/request?id=unknown"))).status, 503);
  assert.equal(f.db.prepare("SELECT started,completed FROM calls WHERE id='unknown'").get().completed, 0);
});
test("synthetic broker cannot be activated for real collection by changing its environment", async t => {
  const f = sandbox(t); f.env.LIVE_ENABLED = "true";
  await assert.rejects(f.broker.fetch(new Request("https://synthetic/status")), /PROBE_FAIL_CLOSED/u);
});
