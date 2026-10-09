import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createKisEodPrivateStore, kisEodPrivateStoreFromEnv } from "../lib/kis-eod-private-store.mjs";
import { runKisEodObservations } from "./observe-kis-eod.mjs";
import { restoreKisEodObservationEvidence } from "../lib/kis-eod-observation.mjs";

const stamp = "2026-10-08T06:40:00.000Z", date = "2026-10-08", repo = "fixture/private-evidence";
function backend(options = {}) {
  const files = new Map(), requests = [], waits = [];
  let transient = options.transient ?? 0;
  const fetchImpl = async (url, init) => {
    requests.push({ url, method: init.method, body: init.body });
    assert.equal(new URL(url).origin, "https://api.github.com"); assert.equal(init.redirect, "error"); assert.ok(init.signal);
    assert.equal(init.headers.Authorization, "Bearer FIXTURE_ONLY_CREDENTIAL");
    if (transient-- > 0) return new Response("PRIVATE_ERROR_NEVER_LOGGED", { status: options.retryStatus ?? 503 });
    if (options.authFailure) return new Response("PRIVATE_ERROR_NEVER_LOGGED", { status: 401 });
    const suffix = new URL(url).pathname.split("/contents/")[1];
    if (!suffix) return Response.json({ private: options.isPrivate !== false, full_name: repo, fork: false, archived: false });
    const key = decodeURIComponent(suffix);
    if (init.method === "GET") {
      if (key.endsWith("/")) {
        const entries = [...files.keys()].filter((file) => file.startsWith(key)).map((file) => ({ type: "file", name: file.slice(key.length) }));
        return entries.length ? Response.json(entries) : new Response("", { status: 404 });
      }
      if (!files.has(key)) return new Response("", { status: 404 });
      const bytes = options.corruptRead ? `${files.get(key)} ` : files.get(key);
      return Response.json({ type: "file", encoding: "base64", size: Buffer.byteLength(bytes), content: Buffer.from(bytes).toString("base64") });
    }
    if (options.readOnly) return new Response("", { status: 403 });
    const payload = JSON.parse(init.body); assert.equal(payload.sha, undefined); assert.equal(payload.branch, "main");
    if (files.has(key)) return new Response("", { status: 409 });
    files.set(key, Buffer.from(payload.content, "base64").toString("utf8"));
    if (options.crashAfterWrite) throw new Error("PRIVATE_ERROR_NEVER_LOGGED");
    return Response.json({ content: { path: key } }, { status: 201 });
  };
  const store = createKisEodPrivateStore({ repository: repo, token: "FIXTURE_ONLY_CREDENTIAL", now: () => stamp, fetchImpl, wait: async (ms) => { waits.push(ms); } });
  return { store, files, requests, waits, options };
}
async function sandbox(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "kis-private-store-"));
  t.after(async () => { assert.ok(path.resolve(root).startsWith(`${path.resolve(os.tmpdir())}${path.sep}kis-private-store-`)); await fs.rm(root, { recursive: true, force: true }); });
  return root;
}
function provider() {
  const calls = [];
  return { calls, async getTradingDay(referenceDate) { return { source: "KIS", operation: "chk-holiday", referenceDate, receivedAt: stamp, isTradingDay: true,
    sourceFields: { bass_dt: referenceDate.replaceAll("-", ""), opnd_yn: "Y", tr_day_yn: "Y" } }; },
  async getHistory(ticker, referenceDate) { calls.push(ticker); return { source: "KIS", sourceOperation: "inquire-daily-itemchartprice", referenceDate, marketDivision: "J", adjustment: "unadjusted",
    priceBasis: "kisDailyBarUnadjusted", requestedAt: stamp, receivedAt: stamp, symbolMapping: { responseCode: ticker },
    rows: [{ basDt: "20261008", srtnCd: ticker, mkp: 100, hipr: 110, lopr: 90, clpr: 105, trqu: 1000, trPrc: 100000, observationStatus: "trading" }] }; } };
}
const run = (root, source, store, options = {}) => runKisEodObservations({ root, provider: source, durableStore: store, now: () => stamp, collectPrivate: true,
  observationEnabled: "true", slot: "15:40", ...options });

test("unconfigured or production-public evidence repository is rejected before requests", () => {
  assert.throws(() => kisEodPrivateStoreFromEnv({}), { code: "PRIVATE_STORE_NOT_CONFIGURED" });
  assert.throws(() => createKisEodPrivateStore({ repository: "klkl789982-droid/stock-research", token: "x" }), { code: "PRIVATE_STORE_NOT_CONFIGURED" });
});
test("private repository is verified and each fresh probe proves write/read/hash", async () => {
  const { store, requests } = backend();
  assert.equal((await store.preflight()).status, "PRIVATE_WRITE_READ_HASH_VERIFIED"); await store.preflight();
  assert.equal(requests.filter((entry) => entry.method === "PUT").length, 2);
});
test("public or newly-public repository refuses any write", async () => {
  const b = backend({ isPrivate: false }); await assert.rejects(b.store.preflight(), { code: "PRIVATE_STORE_REPOSITORY_NOT_PRIVATE" });
  assert.equal(b.requests.some((entry) => entry.method === "PUT"), false);
  const c = backend(); await c.store.preflight(); c.options.isPrivate = false;
  await assert.rejects(c.store.writeImmutable("test/x.json", { a: 1 }), { code: "PRIVATE_STORE_REPOSITORY_NOT_PRIVATE" });
});
test("read-only token cannot pass an earlier successful probe", async () => {
  const b = backend(); await b.store.preflight(); b.options.readOnly = true;
  await assert.rejects(b.store.preflight(), { code: "PRIVATE_STORE_AUTHORIZATION_FAILED" });
});
test("same bytes dedupe and changed bytes never overwrite the immutable original", async () => {
  const b = backend(), value = { sourceFinality: "NOT_CONFIRMED" };
  const a = await b.store.writeImmutable("test/x.json", value), before = [...b.files.values()][0];
  assert.equal((await b.store.writeImmutable("test/x.json", value)).status, "ALREADY_STORED");
  await assert.rejects(b.store.writeImmutable("test/x.json", { changed: true }), { code: "PRIVATE_STORE_IMMUTABLE_CONFLICT" });
  assert.equal([...b.files.values()][0], before); assert.match(a.contentHash, /^[a-f0-9]{64}$/u);
});
test("interrupted response after a successful create recovers by readback without overwriting", async () => {
  const b = backend({ crashAfterWrite: true });
  const result = await b.store.writeImmutable("test/interrupted.json", { original: true });
  assert.equal(result.status, "ALREADY_STORED"); assert.equal(b.files.size, 1); assert.equal(b.waits.length, 1);
});
test("hash mismatch refuses completion and original remote evidence remains", async () => {
  const b = backend({ corruptRead: true });
  await assert.rejects(b.store.writeImmutable("test/hash.json", { original: true }), { code: "PRIVATE_STORE_IMMUTABLE_CONFLICT" });
  assert.equal(b.files.size, 1);
});
test("bounded transient retries succeed; authentication is not blindly retried", async () => {
  const b = backend({ transient: 2, retryStatus: 429 }); await b.store.preflight(); assert.deepEqual(b.waits, [750, 1500]);
  const bad = backend({ authFailure: true }); await assert.rejects(bad.store.preflight(), { code: "PRIVATE_STORE_AUTHORIZATION_FAILED" }); assert.equal(bad.requests.length, 1);
  const exhausted = backend({ transient: 9 }); await assert.rejects(exhausted.store.preflight(), { code: "PRIVATE_STORE_RETRY_EXHAUSTED" }); assert.equal(exhausted.requests.length, 3);
});
test("path escape, URLs and credential-shaped fields never reach Contents PUT", async () => {
  const b = backend();
  await assert.rejects(b.store.writeImmutable("../escape.json", {}), { code: "PRIVATE_STORE_PATH_INVALID" });
  for (const value of [{ appSecret: "x" }, { token: "x" }, { nested: { Authorization: "x" } }, { body: "https://secret.invalid" }])
    await assert.rejects(b.store.writeImmutable("test/secret.json", value), { code: "PRIVATE_STORE_SECRET_REJECTED" });
  assert.equal(b.files.size, 0);
});
test("remote slot claim is create-only across runners and cannot be silently reclaimed", async () => {
  const b = backend(); assert.equal(await b.store.claim(date, "15:40", "owner-1"), true);
  assert.equal(await b.store.claim(date, "15:40", "owner-1"), true); assert.equal(await b.store.claim(date, "15:40", "owner-2"), false);
  assert.equal(b.requests.filter((entry) => entry.method === "PUT").length, 1);
});
test("remote original and marker survive runner disposal; next runner does not recollect", async (t) => {
  const b = backend(), root = await sandbox(t), source = provider();
  assert.equal((await run(root, source, b.store))[0].status, "OBSERVED"); assert.equal(source.calls.length, 3);
  const saved = await b.store.readCompleted(date, "15:40"); assert.equal(saved.artifact.observations.length, 3);
  const next = provider(); assert.equal((await run(await sandbox(t), next, b.store))[0].reason, "ALREADY_OBSERVED"); assert.equal(next.calls.length, 0);
  const restoredRoot = await sandbox(t), restored = await restoreKisEodObservationEvidence({ root: restoredRoot, referenceDate: date, durableStore: b.store });
  assert.equal(restored.restoredCount, 1);
  assert.equal((await restoreKisEodObservationEvidence({ root: restoredRoot, referenceDate: date, durableStore: b.store })).restoredCount, 0);
  const marker = JSON.parse(await fs.readFile(path.join(restoredRoot, ".runtime/kis-eod/observations", date, "1540/completed.json"), "utf8"));
  assert.equal(marker.artifactHash, saved.artifact.artifactHash);
});
test("upload failure retains local original and must not write completed marker", async (t) => {
  const b = backend(), root = await sandbox(t);
  b.store.persistArtifact = async () => { throw new Error("PRIVATE_NETWORK_FAILURE"); };
  assert.equal((await run(root, provider(), b.store))[0].reason, "PRIVATE_STORAGE_FAILED");
  const names = await fs.readdir(path.join(root, ".runtime/kis-eod/observations", date, "1540"));
  assert.equal(names.some((name) => name.endsWith(".json")), true); assert.equal(names.includes("completed.json"), false);
});
test("storage preflight failure prevents even KIS authentication or history calls", async (t) => {
  const root = await sandbox(t), source = provider();
  assert.equal((await run(root, source, { preflight: async () => { throw new Error("x"); } }))[0].reason, "PRIVATE_STORE_PREFLIGHT_FAILED");
  assert.deepEqual(source.calls, []); await assert.rejects(fs.access(path.join(root, ".runtime")), { code: "ENOENT" });
});
test("missed slots persist a safe operational record with no replacement prices", async (t) => {
  const b = backend(), source = provider();
  assert.equal((await run(await sandbox(t), source, b.store, { now: () => "2026-10-08T07:00:00.000Z" }))[0].reason, "MISSED_SLOT_WINDOW");
  assert.deepEqual(source.calls, []); assert.equal([...b.files.keys()].some((key) => key.includes("operations/2026-10-08/1540")), true);
  assert.equal([...b.files.keys()].some((key) => key.includes("journal/")), false);
});
test("reconciliation distinguishes missing scheduled job, crashed claim, holiday and calendar unknown", async () => {
  const b = backend(), calendar = await provider().getTradingDay(date);
  await b.store.claim(date, "15:40", "interrupted");
  const checkedAt = "2026-10-09T06:25:00.000Z", result = await b.store.auditDay(date, calendar, checkedAt);
  assert.equal(result.missingCount, 3); assert.equal(result.unknownCount, 0);
  assert.equal((await b.store.auditDay(date, null, checkedAt)).unknownCount, 3);
  const closed = { ...calendar, isTradingDay: false, sourceFields: { bass_dt: "20261008", opnd_yn: "N", tr_day_yn: "N" } };
  assert.equal((await b.store.auditDay(date, closed, checkedAt)).missingCount, 0);
  await assert.rejects(b.store.auditDay(date, calendar, stamp), { code: "PRIVATE_STORE_AUDIT_TOO_EARLY" });
});
