import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import http from "node:http";
import { buildKisEodCandidate, KIS_EOD_MODEL_VERSIONS } from "../lib/kis-eod-pipeline.mjs";
import { sha256Canonical } from "../lib/snapshot-quality-pipeline.mjs";
import { persistPrivateModelBundle, queryPrivateModelTop, readPrivateModelHead, storePrivateModelBlob, readPrivateModelBlob,
  recordPrivateModelOperation } from "../lib/kis-eod-private-models.mjs";
import { createKisEodPrivateStore } from "../lib/kis-eod-private-store.mjs";
import { createPrivateTopServer } from "./serve-kis-eod-private-top.mjs";

const hashBytes = (value) => createHash("sha256").update(`${JSON.stringify(value, null, 2)}\n`).digest("hex");
export function memoryPrivateStore() {
  const files = new Map(); let writes = 0, crashAt = Infinity;
  return { files, get writes() { return writes; }, set crashAt(value) { crashAt = value; },
    async verifyPrivateRepository() {}, async preflight() { return { status: "PRIVATE_WRITE_READ_HASH_VERIFIED" }; },
    async read(key) { const value = files.get(key); return value ? { value: structuredClone(value), contentHash: hashBytes(value) } : null; },
    async writeImmutable(key, value) {
      const prior = files.get(key);
      if (prior && hashBytes(prior) !== hashBytes(value)) throw Object.assign(new Error("PRIVATE_STORE_IMMUTABLE_CONFLICT"), { code: "PRIVATE_STORE_IMMUTABLE_CONFLICT" });
      if (!prior) { if (++writes === crashAt) throw new Error("SIMULATED_INTERRUPT"); files.set(key, structuredClone(value)); }
      return { status: prior ? "ALREADY_STORED" : "STORED_AND_VERIFIED", contentHash: hashBytes(value) };
    },
    async listKeys(folder) {
      const entries = new Map();
      for (const key of files.keys()) if (key.startsWith(`${folder}/`)) {
        const parts = key.slice(folder.length + 1).split("/"); entries.set(parts[0], { name: parts[0], type: parts.length > 1 ? "dir" : "file" });
      }
      return [...entries.values()];
    } };
}

export function modelFixture(date = "2026-10-08", count = 3) {
  const started = `${date}T06:40:00.000Z`, completed = `${date}T06:50:00.000Z`;
  const stocks = Array.from({ length: count }, (_, index) => ({ code: String(index + 1).padStart(6, "0"), name: `합성 종목 ${index}`, market: "KOSPI" }));
  const histories = stocks.map(({ code }, index) => {
    const rows = [], day = new Date(`${date}T00:00:00Z`);
    while (rows.length < 260) {
      if (![0, 6].includes(day.getUTCDay())) {
        const close = 2000 - rows.length + index;
        rows.push({ basDt: day.toISOString().slice(0, 10).replaceAll("-", ""), mkp: close - 4, hipr: close + 8, lopr: close - 8, clpr: close, trqu: 10000 + rows.length, trPrc: close * 10000, fltRt: 1 });
      }
      day.setUTCDate(day.getUTCDate() - 1);
    }
    return { ticker: code, rows, adjustment: "unadjusted", marketDivision: "J", priceBasis: "KIS_UNADJUSTED_DAILY_CLOSE", receivedAt: `${date}T06:45:00.000Z`, symbolMapping: { status: "VERIFIED_RESPONSE_TICKER", requestedCode: code, responseCode: code } };
  });
  const hashes = Object.fromEntries(KIS_EOD_MODEL_VERSIONS.map((version) => [version, sha256Canonical(version)]));
  const input = { referenceDate: date, now: completed, universeRecords: stocks, expectedUniverseCount: count,
    historiesByCode: new Map(histories.map((history) => [history.ticker, history.rows])), sourceMetadataByCode: new Map(histories.map((history) => [history.ticker, history])),
    officialSnapshot: { asOfDate: "2026-10-07", records: stocks.map(({ code }) => ({ code, qualityEligibility: { status: "eligible", exclusions: [] } })), sourceManifest: { modelFormulaHashes: hashes } },
    formulaHashes: hashes, adjustmentPolicy: "unadjusted", collectionStartedAt: started, collectionCompletedAt: completed,
    observationType: "LIVE_COLLECTION", calendarEvidence: { source: "KIS", operation: "chk-holiday", referenceDate: date, isTradingDay: true, receivedAt: started } };
  return { input, candidate: buildKisEodCandidate(input), raw: { namespace: "kis-provisional-eod-private-inputs", referenceDate: date, histories } };
}

test("all five frozen versions TOP5/10/20 are private, input-linked and deterministic", async () => {
  const store = memoryPrivateStore(), bundle = modelFixture("2026-10-08", 25);
  const result = await persistPrivateModelBundle({ store, ...bundle, runId: "fixture-run" });
  assert.equal(result.status, "PRIVATE_STORED_AND_VERIFIED");
  for (const version of KIS_EOD_MODEL_VERSIONS) for (const limit of [5, 10, 20]) {
    const query = await queryPrivateModelTop(store, { version, limit });
    assert.equal(query.stocks.length, limit); assert.equal(query.eligibleCount, 25); assert.equal(query.modelVersion, version);
    assert.ok(query.stocks.every((record, index) => record.rank === index + 1));
    assert.doesNotMatch(JSON.stringify(query), /clpr|trqu|histories|authorization|token|mkp|hipr|lopr/iu);
    assert.deepEqual(query, await queryPrivateModelTop(store, { version, limit }));
  }
  const writes = store.writes;
  await persistPrivateModelBundle({ store, ...bundle, runId: "fixture-run" });
  assert.equal(store.writes, writes);
});

test("older date and concurrent promotions never overwrite newer latest head", async () => {
  const store = memoryPrivateStore(), older = modelFixture(), newer = modelFixture("2026-10-12");
  await Promise.all([persistPrivateModelBundle({ store, ...newer, runId: "new" }), persistPrivateModelBundle({ store, ...older, runId: "old" })]);
  assert.equal((await readPrivateModelHead(store)).referenceDate, "2026-10-12");
  const count = store.files.size;
  await persistPrivateModelBundle({ store, ...older, runId: "old-late" });
  assert.equal((await readPrivateModelHead(store)).referenceDate, "2026-10-12"); assert.ok(store.files.size >= count);
});

test("partial failures, altered inputs, fixture promotion and timestamp conflicts fail closed", async () => {
  const store = memoryPrivateStore(), bundle = modelFixture();
  const partial = structuredClone(bundle.input); partial.historiesByCode.delete("000002");
  await assert.rejects(persistPrivateModelBundle({ store, raw: bundle.raw, candidate: buildKisEodCandidate(partial) }), { code: "PRIVATE_MODEL_CANDIDATE_NOT_READY" });
  bundle.raw.histories[0].rows[0].clpr += 1;
  await assert.rejects(persistPrivateModelBundle({ store, ...bundle }), { code: "PRIVATE_MODEL_INPUT_MISMATCH" });
  const alteredMetadata = modelFixture(); alteredMetadata.raw.histories[0].receivedAt = "2026-10-08T06:49:00.000Z";
  await assert.rejects(persistPrivateModelBundle({ store, ...alteredMetadata }), { code: "PRIVATE_MODEL_INPUT_MISMATCH" });
  const fixture = modelFixture(); fixture.candidate.observationType = "TEST_FIXTURE";
  await assert.rejects(persistPrivateModelBundle({ store, ...fixture }), { code: "PRIVATE_MODEL_CANDIDATE_NOT_READY" });
  assert.equal(await readPrivateModelHead(store), null);
});

test("interruption and failed operation retain previous latest; corrupted latest never silently falls back", async () => {
  const store = memoryPrivateStore(); await persistPrivateModelBundle({ store, ...modelFixture(), runId: "ok" });
  store.crashAt = store.writes + 2;
  await assert.rejects(persistPrivateModelBundle({ store, ...modelFixture("2026-10-12"), runId: "interrupted" }));
  assert.equal((await readPrivateModelHead(store)).referenceDate, "2026-10-08");
  await recordPrivateModelOperation(store, { status: "FAILED", reason: "KIS_DATA_DELAYED", checkedAt: "2026-10-12T07:00:00.000Z", referenceDate: "2026-10-12", runId: "failed" });
  const result = await queryPrivateModelTop(store);
  assert.equal(result.lastOperation.status, "FAILED"); assert.equal(result.referenceDate, "2026-10-08");
  const key = [...store.files.keys()].find((value) => value.includes("/heads/")); store.files.get(key).inputHash = "0".repeat(64);
  await assert.rejects(queryPrivateModelTop(store), { code: "PRIVATE_MODEL_HEAD_INVALID" });
});

test("fragmented private payload retains Unicode, bytes, credential scanning and exact hashes", async () => {
  const store = memoryPrivateStore(), source = { payload: "한국어🟠".repeat(120000) };
  const descriptor = await storePrivateModelBlob(store, "model-top/fixture", source);
  assert.ok(descriptor.chunks.length > 1); assert.deepEqual(await readPrivateModelBlob(store, "model-top/fixture", descriptor), source);
  assert.ok([...store.files.values()].every((value) => Buffer.byteLength(JSON.stringify(value, null, 2)) < 900000));
  await assert.rejects(storePrivateModelBlob(store, "model-top/fixture", { nested: { token: "DO_NOT_STORE" } }), { code: "PRIVATE_STORE_SECRET_REJECTED" });
  store.files.get(descriptor.chunks[0].key).text += "x";
  await assert.rejects(readPrivateModelBlob(store, "model-top/fixture", descriptor), { code: "PRIVATE_MODEL_HASH_MISMATCH" });
  await assert.rejects(readPrivateModelBlob(store, "model-top/live", descriptor), { code: "PRIVATE_MODEL_PATH_INVALID" });
});

test("real adapter directory list is bounded, path constrained and token never exposed", async () => {
  const requests = [], store = createKisEodPrivateStore({ repository: "fixture/private", token: "FIXTURE_ONLY", fetchImpl: async (url, init) => {
    requests.push({ url, method: init.method });
    if (!url.includes("/contents/")) return Response.json({ private: true, full_name: "fixture/private" });
    return Response.json([{ type: "dir", name: "2026-10-08" }]);
  } });
  assert.deepEqual(await store.listKeys("model-top/live/heads"), [{ name: "2026-10-08", type: "dir" }]);
  await assert.rejects(store.listKeys("../outside"), { code: "PRIVATE_STORE_PATH_INVALID" });
  assert.ok(requests.every((request) => request.method === "GET"));
});

test("local-only private API blocks hostile Host/Origin and never returns raw prices", async (t) => {
  const store = memoryPrivateStore(); await persistPrivateModelBundle({ store, ...modelFixture(), runId: "test" });
  const server = createPrivateTopServer({ store }); await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`, url = `${base}/api/kis-eod-private-top-stocks?model=B&limit=5`;
  assert.equal((await (await fetch(url)).json()).stocks.length, 3);
  assert.equal((await fetch(url, { headers: { Origin: "https://hostile.invalid" } })).status, 403);
  const hostileHostStatus = await new Promise((resolve, reject) => {
    const request = http.get(url, { headers: { Host: "hostile.invalid" } }, (response) => { response.resume(); resolve(response.statusCode); });
    request.on("error", reject);
  });
  assert.equal(hostileHostStatus, 403);
  const invalidTargetStatus = await new Promise((resolve, reject) => {
    const request = http.get({ hostname: "127.0.0.1", port: server.address().port, path: "http://[invalid" }, (response) => { response.resume(); resolve(response.statusCode); });
    request.on("error", reject);
  });
  assert.equal(invalidTargetStatus, 400);
  assert.equal((await fetch(`${url}&model=A`)).status, 400);
  assert.equal((await fetch(`${base}/api/kis-eod-private-top-stocks?limit=100`)).status, 400);
  assert.equal((await fetch(url, { method: "POST" })).status, 404);
});

test("no resolved private data is an accumulating state, not fabricated scores", async () => {
  const result = await queryPrivateModelTop(memoryPrivateStore());
  assert.equal(result.status, "DATA_ACCUMULATING"); assert.deepEqual(result.stocks, []); assert.equal(result.referenceDate, null);
});
