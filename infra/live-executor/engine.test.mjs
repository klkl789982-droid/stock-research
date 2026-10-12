import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createLocalExecutionStore } from "./store.mjs";
import { createExecutor, clockKst, buildShadowResult } from "./engine.mjs";
import { startPrivateApi } from "./api.mjs";
import { intradaySeedHash } from "../../lib/intraday-market-seed.mjs";
import { buildIntradayModelTopSignal } from "../../lib/intraday-model-top-official-signal.mjs";

const signalDate = "2026-10-13", seedDate = "2026-10-12";
const formulaEvidence = Object.fromEntries(["A-v1", "B-v1", "C-v1", "D-v1"].map((version, index) => [version, String(index + 1).repeat(64)]));
function fixtureSeed() {
  const records = ["000660", "005930"].map((code, index) => ({ code, name: `Synthetic ${code}`, market: "KOSPI", eligible: true,
    rows: Array.from({ length: 260 }, (_, i) => {
      const date = new Date(Date.parse(`${seedDate}T00:00:00Z`) - i * 86400000).toISOString().slice(0, 10).replaceAll("-", "");
      const close = 1000 + index * 100 + (260 - i) * 2 + Math.sin(i / 4) * 15;
      return [date, close - 5, close + 10, close - 10, close, 100000 + (260 - i) * 100];
    }) }));
  const base = { schemaVersion: 1, seedType: "intradayMarketAnalysisSeed", rowOrder: "descending", requestedDate: seedDate,
    sourceManifest: { modelFormulaHashes: formulaEvidence }, records };
  return { ...base, contentHash: intradaySeedHash(base) };
}
async function sandbox(t, { time = "14:30:10", failedOnce = null, holiday = false, publish = null } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "tb-live-engine-"));
  t.after(async () => {
    assert.ok(directory.startsWith(`${path.resolve(os.tmpdir())}${path.sep}tb-live-engine-`));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const store = createLocalExecutionStore(directory), seed = fixtureSeed(), collected = [], received = new Map();
  let currentMs = Date.parse(`${signalDate}T${time}+09:00`), rejectFormula = false, failure = failedOnce;
  const source = {
    calendar: async (date) => ({ isTradingDay: !holiday, referenceDate: date, source: "TEST_FIXTURE" }),
    async collectQuote(code) {
      collected.push(code);
      if (failure === code) { failure = null; throw new Error("KIS_HTTP_503"); }
      const stock = seed.records.find((item) => item.code === code), previous = stock.rows[0][4];
      const quote = { code, source: "TEST_FIXTURE", priceBasis: "testOnly", asOfDate: clockKst(currentMs).date, asOfTime: clockKst(currentMs).time,
        receivedAt: new Date(currentMs).toISOString(), open: previous + 1, high: previous + 25, low: previous - 5, price: previous + 20, volume: 160000, change: 20, rate: 20 / previous * 100 };
      received.set(code, quote); return quote;
    },
  };
  const options = { store, source, loadSeed: async () => seed, verifyFormula: async (previous) => {
    if (rejectFormula) throw new Error("MODEL_FORMULA_HASH_MISMATCH");
    if (previous) assert.deepEqual(previous, formulaEvidence);
    return formulaEvidence;
  }, now: () => currentMs, expectedUniverseCount: 2, publish };
  return { store, seed, source, collected, received, options, executor: createExecutor(options),
    setTime: (time) => { currentMs = Date.parse(`${signalDate}T${time}+09:00`); }, rejectFormula: () => { rejectFormula = true; } };
}

test("preparation validates seed, calendar and formula without consuming observation prices", async (t) => {
  const f = await sandbox(t, { time: "14:12:00" });
  const result = await f.executor.advance({ date: signalDate });
  assert.equal(result.status, "PREPARED"); assert.deepEqual(f.collected, []);
  assert.equal((await f.store.read(`live/${signalDate}/${signalDate}/prepared.json`)).eligibleCount, 2);
  assert.equal(await f.store.read("live/latest.json"), null);
});
test("three prewarm failures recover without consuming the LIVE collection retry budget", async (t) => {
  const f = await sandbox(t, { time: "14:10:00" });
  const calendar = f.source.calendar;
  let preparationRequests = 0;
  f.source.calendar = async (date) => {
    if (++preparationRequests <= 3) throw new Error("KIS_HTTP_503");
    return calendar(date);
  };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    f.setTime(`14:${10 + attempt}:00`);
    const failed = await f.executor.advance({ date: signalDate });
    assert.equal(failed.status, "FAILED");
    assert.equal(failed.preparationAttempts, attempt + 1);
    assert.equal(failed.attempts, 0);
    assert.deepEqual(f.collected, []);
  }
  f.setTime("14:13:00");
  const prepared = await f.executor.advance({ date: signalDate });
  assert.equal(prepared.status, "PREPARED");
  assert.equal(prepared.preparationAttempts, 4);
  assert.equal(prepared.attempts, 0);
  f.setTime("14:15:00");
  assert.equal((await f.executor.advance({ date: signalDate })).status, "PREPARED");
  assert.equal(preparationRequests, 4);
  f.setTime("14:30:00");
  const complete = await f.executor.advance({ date: signalDate });
  assert.equal(complete.status, "STORED");
  assert.equal(complete.attempts, 1);
  assert.equal(complete.preparationAttempts, 4);
  assert.equal(f.collected.length, 2);
});
test("preparation retries are bounded separately for live and shadow", async (t) => {
  for (const [mode, limit] of [["live", 25], ["shadow", 3]]) {
    const f = await sandbox(t, { time: "14:00:00" });
    let requests = 0;
    f.source.calendar = async () => { requests += 1; throw new Error("KIS_HTTP_503"); };
    for (let attempt = 0; attempt < limit; attempt += 1) {
      f.setTime(`14:${String(attempt).padStart(2, "0")}:00`);
      const failed = await f.executor.advance({ mode, date: signalDate });
      assert.equal(failed.preparationAttempts, attempt + 1);
      assert.equal(failed.attempts, 0);
    }
    f.setTime(`14:${String(limit).padStart(2, "0")}:00`);
    const exhausted = await f.executor.advance({ mode, date: signalDate });
    assert.equal(exhausted.status, "FAILED");
    assert.equal(exhausted.preparationAttempts, limit);
    assert.equal(requests, limit);
    assert.deepEqual(f.collected, []);
    if (mode === "live") {
      f.setTime("14:35:01");
      assert.equal((await f.executor.advance({ mode, date: signalDate })).status, "MISSED");
      assert.equal(requests, limit);
    }
  }
});
test("an unprepared expired LIVE run records missed status without calendar or seed requests even during backoff", async (t) => {
  const f = await sandbox(t, { time: "14:34:50" });
  let requests = 0;
  f.source.calendar = async () => { requests += 1; throw new Error("KIS_HTTP_503"); };
  assert.equal((await f.executor.advance({ date: signalDate })).status, "FAILED");
  assert.equal(requests, 1);
  f.setTime("14:35:01");
  const expired = await f.executor.advance({ date: signalDate });
  assert.equal(expired.status, "MISSED");
  assert.equal(expired.reason, "OFFICIAL_SIGNAL_OUTSIDE_COLLECTION_WINDOW");
  assert.equal(requests, 1);
  assert.deepEqual(f.collected, []);
  const neverPrepared = await sandbox(t, { time: "15:00:00" });
  neverPrepared.source.calendar = async () => { throw new Error("UNEXPECTED_CALENDAR_REQUEST"); };
  const result = await neverPrepared.executor.advance({ date: signalDate });
  assert.equal(result.status, "MISSED");
  assert.equal(result.preparationAttempts, 0);
});
test("LIVE uses unchanged model engine scores, ranks, hashes and recorded timestamps", async (t) => {
  const f = await sandbox(t);
  const result = await f.executor.advance({ date: signalDate });
  assert.equal(result.status, "STORED"); assert.equal(f.collected.length, 2);
  const pointer = await f.store.read("live/latest.json"), actual = await f.store.read(pointer.artifactKey);
  const expected = buildIntradayModelTopSignal({ seed: f.seed, quotesByCode: f.received, signalDate,
    collectionStartedAt: actual.collectionStartedAt, collectionCompletedAt: actual.collectionCompletedAt });
  assert.deepEqual(actual, expected);
  for (const version of Object.keys(formulaEvidence)) assert.equal(actual.rankingUniverse[version].count, 2);
  assert.equal(actual.observationType, "LIVE_OBSERVATION");
  assert.equal(actual.records[0].quote.asOfTime, "14:30:10");
});
test("after-hours shadow keeps the actual time and cannot update the LIVE namespace", async (t) => {
  const f = await sandbox(t, { time: "16:12:34" });
  assert.equal((await f.executor.advance({ mode: "shadow", date: signalDate, runId: "research-run" })).status, "STORED");
  const pointer = await f.store.read("shadow/latest.json"), result = await f.store.read(pointer.artifactKey);
  assert.equal(result.observationType, "CURRENT_TIME_SHADOW");
  assert.equal(result.eligibleForOfficialSignal, false); assert.equal(result.eligibleForOutcomes, false);
  assert.equal(result.records[0].quote.asOfTime, "16:12:34");
  assert.equal(await f.store.read("live/latest.json"), null);
  assert.deepEqual(result, buildShadowResult(f.seed, f.received, signalDate, result.collectionStartedAt, result.collectionCompletedAt));
});
test("partial collection preserves previous success and retries only missing quotes", async (t) => {
  const f = await sandbox(t, { failedOnce: "005930" });
  const prior = { signalDate: "2026-10-12", artifactKey: "live/previous/result.json", contentHash: "a".repeat(64) };
  await f.store.writeMutable("live/latest.json", prior);
  const first = await f.executor.advance({ date: signalDate });
  assert.equal(first.status, "PARTIAL"); assert.equal(first.successful, 1); assert.equal(first.failed, 1);
  assert.deepEqual(await f.store.read("live/latest.json"), prior);
  f.setTime("14:30:30");
  assert.equal((await f.executor.advance({ date: signalDate })).status, "STORED");
  assert.equal(f.collected.filter((code) => code === "000660").length, 1);
  assert.equal(f.collected.filter((code) => code === "005930").length, 2);
});
test("a restarted executor reads immutable success without recollecting or recalculating", async (t) => {
  const f = await sandbox(t);
  await f.executor.advance({ date: signalDate });
  const original = await f.store.read("live/latest.json"), calls = f.collected.length;
  f.setTime("18:00:00");
  const restarted = createExecutor({ ...f.options, loadSeed: async () => { throw new Error("DO_NOT_RELOAD"); }, source: { collectQuote: async () => { throw new Error("DO_NOT_RECOLLECT"); } } });
  assert.equal((await restarted.advance({ date: signalDate })).status, "STORED");
  assert.equal(f.collected.length, calls); assert.deepEqual(await f.store.read("live/latest.json"), original);
});
test("a crash after the final allowed collection can resume complete saved inputs after the window", async (t) => {
  const f = await sandbox(t), base = `live/${signalDate}/${signalDate}`;
  await f.executor.prepare("live", signalDate);
  for (const item of f.seed.records) await f.store.writeImmutable(`${base}/quotes/${item.code}.json`, await f.source.collectQuote(item.code));
  await f.store.writeMutable(`${base}/status.json`, { attempts: 3, status: "COLLECTING", collectionStartedAt: `${signalDate}T05:30:10.000Z` });
  f.setTime("18:00:00");
  const result = await createExecutor(f.options).advance({ date: signalDate });
  assert.equal(result.status, "STORED");
  assert.equal(f.collected.length, 2);
  assert.equal((await f.store.read((await f.store.read("live/latest.json")).artifactKey)).records[0].quote.asOfTime, "14:30:10");
});
test("shadow refuses malformed source and receipt timestamps instead of interpreting NaN as valid", async (t) => {
  const f = await sandbox(t, { time: "16:12:34" });
  for (const item of f.seed.records) await f.source.collectQuote(item.code);
  for (const field of ["asOfTime", "receivedAt"]) {
    const quotes = new Map([...f.received].map(([code, quote]) => [code, { ...quote }]));
    quotes.get("000660")[field] = "invalid";
    assert.throws(() => buildShadowResult(f.seed, quotes, signalDate, "2026-10-13T07:12:34.000Z", "2026-10-13T07:12:34.000Z"), /SHADOW_QUOTE_TIMESTAMP_INVALID/u);
  }
});
test("an expired LIVE window cannot recollect missing prices or fabricate a result", async (t) => {
  const f = await sandbox(t, { time: "14:35:01" });
  const result = await f.executor.advance({ date: signalDate });
  assert.equal(result.status, "MISSED"); assert.deepEqual(f.collected, []);
  assert.equal(await f.store.read("live/latest.json"), null);
});
test("verified holiday and formula mismatch prevent price collection", async (t) => {
  const holiday = await sandbox(t, { holiday: true });
  assert.equal((await holiday.executor.advance({ date: signalDate })).status, "MARKET_CLOSED");
  assert.deepEqual(holiday.collected, []);
  const formula = await sandbox(t);
  formula.rejectFormula();
  assert.equal((await formula.executor.advance({ date: signalDate })).reason, "MODEL_FORMULA_HASH_MISMATCH");
  assert.deepEqual(formula.collected, []);
});
test("publication failure is retried from stored evidence without repeating collection", async (t) => {
  let attempts = 0;
  const f = await sandbox(t, { publish: async () => { if (++attempts === 1) throw new Error("PUBLICATION_NETWORK_ERROR"); return { status: "PUBLISHED", publicationVerified: true }; } });
  const initial = await f.executor.advance({ date: signalDate });
  assert.equal(initial.status, "STORED"); assert.equal(initial.publication, "FAILED");
  const original = await f.store.read("live/latest.json");
  f.setTime("16:00:00");
  assert.equal((await f.executor.advance({ date: signalDate })).publication, "VERIFIED");
  assert.equal(f.collected.length, 2); assert.equal(attempts, 2);
  assert.deepEqual(await f.store.read("live/latest.json"), original);
  assert.deepEqual((await f.store.read("live/outbox.json")).dates, []);
});
test("loopback API authenticates all queries and returns only model summaries", async (t) => {
  const f = await sandbox(t, { time: "16:12:34" });
  await f.executor.advance({ mode: "shadow", date: signalDate });
  const token = "synthetic-private-query-token-only-1234567890";
  const api = await startPrivateApi({ store: f.store, token });
  t.after(() => api.close());
  const headers = { Authorization: `Bearer ${token}` };
  assert.equal((await fetch(`${api.url}/top`)).status, 401);
  assert.equal((await fetch(`${api.url}/top`, { headers: { Authorization: "Bearer invalid" } })).status, 401);
  assert.equal((await fetch(`${api.url}/top?limit=500`, { headers })).status, 400);
  assert.equal((await fetch(`${api.url}/top?model=E`, { headers })).status, 400);
  assert.equal((await fetch(`${api.url}/top`, { method: "POST", headers })).status, 405);
  assert.equal((await fetch(`${api.url}/top`, { headers: { ...headers, Origin: "https://unrelated.invalid" } })).status, 403);
  assert.equal((await fetch(`${api.url}/top?model=A&model=B`, { headers })).status, 400);
  for (const model of ["A", "B", "C", "D"]) for (const limit of [5, 10, 20]) {
    const response = await fetch(`${api.url}/top?model=${model}&limit=${limit}`, { headers });
    assert.equal(response.status, 200); assert.match(response.headers.get("cache-control"), /no-store/u);
    const body = await response.json();
    assert.equal(body.records.length, 2); assert.equal(body.modelVersion, `${model}-v1`);
    assert.equal(body.observationType, "CURRENT_TIME_SHADOW");
    for (const record of body.records) assert.deepEqual(Object.keys(record).sort(), ["companyName", "rank", "score", "ticker"]);
    assert.doesNotMatch(JSON.stringify(body), /"(?:price|open|high|low|close|volume|quote|appKey|appSecret|token)"/u);
  }
});
