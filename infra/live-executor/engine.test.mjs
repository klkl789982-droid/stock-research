import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createLocalExecutionStore } from "./store.mjs";
import { createExecutor, clockKst, buildShadowResult } from "./engine.mjs";
import { startPrivateApi } from "./api.mjs";
import { intradaySeedHash } from "../../lib/intraday-market-seed.mjs";
import { assertLiveSeedSession } from "../../lib/live-seed-policy.mjs";
import { buildIntradayModelTopSignal } from "../../lib/intraday-model-top-official-signal.mjs";

const signalDate = "2026-10-13", seedDate = "2026-10-12";
const formulaEvidence = Object.fromEntries(["A-v1", "B-v1", "C-v1", "D-v1"].map((version, index) => [version, String(index + 1).repeat(64)]));
function fixtureSeed() {
  const records = ["000660", "005930"].map((code, index) => ({ code, name: `Synthetic ${code}`, market: "KOSPI", eligible: true, officialAsOfDate: seedDate, sourceHash: "a".repeat(64),
    rows: Array.from({ length: 260 }, (_, i) => {
      const date = new Date(Date.parse(`${seedDate}T00:00:00Z`) - i * 86400000).toISOString().slice(0, 10).replaceAll("-", "");
      const close = 1000 + index * 100 + (260 - i) * 2 + Math.sin(i / 4) * 15;
      return [date, close - 5, close + 10, close - 10, close, 100000 + (260 - i) * 100];
    }) }));
  const base = { schemaVersion: 1, seedType: "intradayMarketAnalysisSeed", rowOrder: "descending", requestedDate: seedDate,
    generatedAt: `${signalDate}T03:00:00.000Z`,
    sourceManifest: { modelFormulaHashes: formulaEvidence, sources: { officialDailyPrice: { normalizedInputHash: "a".repeat(64), availability: {
      requestedAt: `${signalDate}T02:58:00.000Z`, observedAt: `${signalDate}T02:59:00.000Z`, referenceDate: seedDate,
      normalizedInputHash: "a".repeat(64), availabilityStatus: "OBSERVED", availabilityEvidence: "SYSTEM_OBSERVED_BATCH_COLLECTION", outcome: "success",
    } } } }, records };
  return { ...base, contentHash: intradaySeedHash(base) };
}
async function sandbox(t, { time = "14:00:10", failedOnce = null, holiday = false, publish = null } = {}) {
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
  const options = { store, source, requireFinalInputRefresh: false, loadSeed: async () => seed, verifySeedSession: async (value, date) => assertLiveSeedSession(value, date, { dates: { [seedDate]: { status: "tradingDay", observedBasDt: seedDate } } }), verifyFormula: async (previous) => {
    if (rejectFormula) throw new Error("MODEL_FORMULA_HASH_MISMATCH");
    if (previous) assert.deepEqual(previous, formulaEvidence);
    return formulaEvidence;
  }, now: () => currentMs, expectedUniverseCount: 2, publish };
  return { directory, store, seed, source, collected, received, options, executor: createExecutor(options),
    setTime: (time) => { currentMs = Date.parse(`${signalDate}T${time}+09:00`); }, rejectFormula: () => { rejectFormula = true; } };
}

test("preparation validates seed, calendar and formula without consuming observation prices", async (t) => {
  const f = await sandbox(t, { time: "13:42:00" });
  const result = await f.executor.advance({ date: signalDate });
  assert.equal(result.status, "PREPARED"); assert.deepEqual(f.collected, []);
  assert.equal((await f.store.read(`live/${signalDate}/${signalDate}/prepared.json`)).eligibleCount, 2);
  assert.equal(await f.store.read("live/latest.json"), null);
});

test("production default refreshes EOD once immediately before observation and preserves prewarm receipt", async (t) => {
  const f = await sandbox(t, { time: "13:40:00" });
  let loads = 0;
  const executor = createExecutor({ ...f.options, requireFinalInputRefresh: true, loadSeed: async () => { loads++; return f.seed; } });
  assert.equal((await executor.advance({ date: signalDate })).status, "PREPARED");
  const before = await f.store.read(`live/${signalDate}/${signalDate}/prepared.json`);
  f.setTime("13:59:00");
  assert.equal((await executor.advance({ date: signalDate })).status, "PREPARED");
  assert.equal(loads, 2);
  const final = await f.store.read(`live/${signalDate}/${signalDate}/collection-prepared.json`);
  assert.equal(final.preparedAt, `${signalDate}T04:59:00.000Z`);
  assert.deepEqual(await f.store.read(`live/${signalDate}/${signalDate}/prepared.json`), before);
  f.setTime("14:00:10");
  assert.equal((await executor.advance({ date: signalDate })).status, "STORED");
  assert.equal(loads, 2);
});

test("TOP5 record failure retries stored evidence without recollection and has a bounded budget", async t => {
  const f = await sandbox(t); let records = 0;
  const executor = createExecutor({ ...f.options, recordSwing: async () => { if (++records === 1) throw new Error("SWING_STORAGE_UNAVAILABLE"); return { status: "RECORDED" }; } });
  const first = await executor.advance({ date: signalDate });
  assert.equal(first.status, "STORED"); assert.equal(first.swing.status, "FAILED");
  const count = f.collected.length;
  await executor.advance({ date: signalDate }); assert.equal(records, 1);
  f.setTime("14:01:11");
  assert.equal((await executor.advance({ date: signalDate })).swing.status, "RECORDED");
  assert.equal(records, 2); assert.equal(f.collected.length, count);
  await executor.advance({ date: signalDate }); assert.equal(records, 2);
});

test("missing or late final input refresh never falls back to the old prewarm seed", async (t) => {
  for (const lateFetch of [false, true]) {
    const f = await sandbox(t, { time: "13:40:00" });
    let loads = 0;
    const executor = createExecutor({ ...f.options, requireFinalInputRefresh: true, loadSeed: async () => {
      if (++loads === 2 && lateFetch) f.setTime("14:00:01");
      return f.seed;
    } });
    await executor.advance({ date: signalDate });
    f.setTime(lateFetch ? "13:59:10" : "14:00:00");
    const result = await executor.advance({ date: signalDate });
    assert.equal(result.status, "WAITING"); assert.equal(result.reason, "LIVE_INPUT_NOT_READY_REFRESH_LATE");
    assert.deepEqual(f.collected, []);
    assert.equal(await f.store.read(`live/${signalDate}/${signalDate}/collection-prepared.json`), null);
  }
});
test("clock verification fails closed before calendar or observation and is stored once per preparation", async (t) => {
  const f = await sandbox(t, { time: "13:42:00" });
  let checks = 0, calendars = 0;
  const originalCalendar = f.source.calendar;
  f.source.calendar = async (date) => { calendars += 1; return originalCalendar(date); };
  const clockEvidence = { source: "TEST_FIXTURE_CLOCK", offsetMs: 120, rttMs: 25, verifiedAt: `${signalDate}T04:43:00.000Z` };
  const executor = createExecutor({ ...f.options, verifyClock: async () => {
    if (++checks === 1) throw new Error("LIVE_CLOCK_OFFSET_EXCEEDED");
    return clockEvidence;
  } });
  const failed = await executor.advance({ date: signalDate });
  assert.equal(failed.status, "FAILED");
  assert.equal(failed.reason, "LIVE_CLOCK_OFFSET_EXCEEDED");
  assert.equal(calendars, 0);
  assert.deepEqual(f.collected, []);
  assert.equal(await f.store.read(`live/${signalDate}/${signalDate}/prepared.json`), null);
  f.setTime("13:43:00");
  assert.equal((await executor.advance({ date: signalDate })).status, "PREPARED");
  assert.equal(calendars, 1);
  assert.deepEqual((await f.store.read(`live/${signalDate}/${signalDate}/prepared.json`)).clockEvidence, clockEvidence);
  f.setTime("13:44:00");
  assert.equal((await executor.advance({ date: signalDate })).status, "PREPARED");
  assert.equal(checks, 2);
  assert.equal(calendars, 1);
});
test("three prewarm failures recover without consuming the LIVE collection retry budget", async (t) => {
  const f = await sandbox(t, { time: "13:40:00" });
  const calendar = f.source.calendar;
  let preparationRequests = 0;
  f.source.calendar = async (date) => {
    if (++preparationRequests <= 3) throw new Error("KIS_HTTP_503");
    return calendar(date);
  };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    f.setTime(`13:${40 + attempt}:00`);
    const failed = await f.executor.advance({ date: signalDate });
    assert.equal(failed.status, "FAILED");
    assert.equal(failed.preparationAttempts, attempt + 1);
    assert.equal(failed.attempts, 0);
    assert.deepEqual(f.collected, []);
  }
  f.setTime("13:43:00");
  const prepared = await f.executor.advance({ date: signalDate });
  assert.equal(prepared.status, "PREPARED");
  assert.equal(prepared.preparationAttempts, 4);
  assert.equal(prepared.attempts, 0);
  f.setTime("13:45:00");
  assert.equal((await f.executor.advance({ date: signalDate })).status, "PREPARED");
  assert.equal(preparationRequests, 4);
  f.setTime("14:00:00");
  const complete = await f.executor.advance({ date: signalDate });
  assert.equal(complete.status, "STORED");
  assert.equal(complete.attempts, 1);
  assert.equal(complete.preparationAttempts, 4);
  assert.equal(f.collected.length, 2);
});
test("preparation retries are bounded separately for live and shadow", async (t) => {
  for (const [mode, limit] of [["live", 25], ["shadow", 3]]) {
    const f = await sandbox(t, { time: "13:00:00" });
    let requests = 0;
    f.source.calendar = async () => { requests += 1; throw new Error("KIS_HTTP_503"); };
    for (let attempt = 0; attempt < limit; attempt += 1) {
      f.setTime(`13:${String(attempt).padStart(2, "0")}:00`);
      const failed = await f.executor.advance({ mode, date: signalDate });
      assert.equal(failed.preparationAttempts, attempt + 1);
      assert.equal(failed.attempts, 0);
    }
    f.setTime(`13:${String(limit).padStart(2, "0")}:00`);
    const exhausted = await f.executor.advance({ mode, date: signalDate });
    assert.equal(exhausted.status, "FAILED");
    assert.equal(exhausted.preparationAttempts, limit);
    assert.equal(requests, limit);
    assert.deepEqual(f.collected, []);
    if (mode === "live") {
      f.setTime("14:05:01");
      assert.equal((await f.executor.advance({ mode, date: signalDate })).status, "MISSED");
      assert.equal(requests, limit);
    }
  }
});
test("an unprepared expired LIVE run records missed status without calendar or seed requests even during backoff", async (t) => {
  const f = await sandbox(t, { time: "14:04:50" });
  let requests = 0;
  f.source.calendar = async () => { requests += 1; throw new Error("KIS_HTTP_503"); };
  assert.equal((await f.executor.advance({ date: signalDate })).status, "FAILED");
  assert.equal(requests, 1);
  f.setTime("14:05:01");
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
  assert.equal(actual.records[0].quote.asOfTime, "14:00:10");
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
  f.setTime("14:00:30");
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
  await f.store.writeMutable(`${base}/status.json`, { attempts: 3, status: "COLLECTING", collectionStartedAt: `${signalDate}T05:00:10.000Z` });
  f.setTime("18:00:00");
  const result = await createExecutor(f.options).advance({ date: signalDate });
  assert.equal(result.status, "STORED");
  assert.equal(f.collected.length, 2);
  assert.equal((await f.store.read((await f.store.read("live/latest.json")).artifactKey)).records[0].quote.asOfTime, "14:00:10");
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
  const f = await sandbox(t, { time: "14:05:01" });
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

test("30-second delayed startup keeps its actual observation time and expiry preserves last good", async (t) => {
  const delayed = await sandbox(t, { time: "14:00:30" });
  assert.equal((await delayed.executor.advance({ date: signalDate })).status, "STORED");
  const pointer = await delayed.store.read("live/latest.json");
  const observed = await delayed.store.read(pointer.artifactKey);
  assert.ok(observed.records.every((record) => record.quote.asOfTime === "14:00:30"));
  const expired = await sandbox(t, { time: "14:05:01" });
  await expired.store.writeMutable("live/latest.json", pointer);
  assert.equal((await expired.executor.advance({ date: signalDate })).status, "MISSED");
  assert.deepEqual(await expired.store.read("live/latest.json"), pointer);
  assert.equal(expired.collected.length, 0);
});

test("a failed quote checkpoint retries only that symbol and preserves the successful checkpoint", async (t) => {
  const f = await sandbox(t);
  let failed = false;
  const failingStore = { ...f.store, writeImmutable: async (key, value) => {
    if (!failed && key.endsWith("/quotes/005930.json")) { failed = true; throw new Error("LIVE_STORE_WRITE_FAILED"); }
    return f.store.writeImmutable(key, value);
  } };
  const executor = createExecutor({ ...f.options, store: failingStore });
  const initial = await executor.advance({ date: signalDate });
  assert.equal(initial.status, "PARTIAL");
  assert.equal(initial.failureCodes.LIVE_STORE_WRITE_FAILED, 1);
  assert.equal(await f.store.read("live/latest.json"), null);
  const key = `live/${signalDate}/${signalDate}/quotes/000660.json`;
  const original = await fs.readFile(path.join(f.directory, key), "utf8");
  f.setTime("14:00:30");
  assert.equal((await executor.advance({ date: signalDate })).status, "STORED");
  assert.equal(f.collected.filter((code) => code === "000660").length, 1);
  assert.equal(f.collected.filter((code) => code === "005930").length, 2);
  assert.equal(await fs.readFile(path.join(f.directory, key), "utf8"), original);
});

test("result storage failure resumes from complete immutable quotes without new requests", async (t) => {
  const f = await sandbox(t);
  let failed = false;
  const failingStore = { ...f.store, writeImmutable: async (key, value) => {
    if (!failed && key.endsWith("/result.json")) { failed = true; throw new Error("LIVE_STORE_WRITE_FAILED"); }
    return f.store.writeImmutable(key, value);
  } };
  const initial = await createExecutor({ ...f.options, store: failingStore }).advance({ date: signalDate });
  assert.equal(initial.status, "FAILED");
  assert.equal(initial.reason, "LIVE_STORE_WRITE_FAILED");
  assert.equal(await f.store.read("live/latest.json"), null);
  f.setTime("18:00:00");
  assert.equal((await createExecutor(f.options).advance({ date: signalDate })).status, "STORED");
  assert.equal(f.collected.length, 2);
  const result = await f.store.read((await f.store.read("live/latest.json")).artifactKey);
  assert.equal(result.collectionCompletedAt, `${signalDate}T05:00:10.000Z`);
});

test("a saved result recovers pointer failure with backoff and without recollection", async (t) => {
  const f = await sandbox(t);
  let writes = 0;
  const failingStore = { ...f.store, writeMutable: async (key, value) => {
    if (key === "live/latest.json" && ++writes === 1) throw new Error("LIVE_STORE_POINTER_FAILED");
    return f.store.writeMutable(key, value);
  } };
  const executor = createExecutor({ ...f.options, store: failingStore });
  assert.equal((await executor.advance({ date: signalDate })).reason, "LIVE_STORE_POINTER_FAILED");
  assert.ok(await f.store.read(`live/${signalDate}/${signalDate}/result.json`));
  assert.equal(await f.store.read("live/latest.json"), null);
  assert.equal((await executor.advance({ date: signalDate })).status, "FAILED");
  assert.equal(writes, 1);
  f.setTime("14:01:11");
  const recovered = await executor.advance({ date: signalDate });
  assert.equal(recovered.status, "STORED");
  assert.equal(recovered.reason, null);
  assert.equal(writes, 2);
  assert.equal(f.collected.length, 2);
});

test("persistent pointer failure exhausts a bounded storage recovery budget", async (t) => {
  const f = await sandbox(t);
  let writes = 0;
  const executor = createExecutor({ ...f.options, store: { ...f.store, writeMutable: async (key, value) => {
    if (key === "live/latest.json") { writes += 1; throw new Error("LIVE_STORE_POINTER_FAILED"); }
    return f.store.writeMutable(key, value);
  } } });
  assert.equal((await executor.advance({ date: signalDate })).status, "FAILED");
  for (let retry = 1; retry <= 3; retry += 1) {
    f.setTime(`14:${30 + retry}:11`);
    const failed = await executor.advance({ date: signalDate });
    assert.equal(failed.storageRecoveryAttempts, retry);
    assert.equal((await executor.advance({ date: signalDate })).status, "FAILED");
    assert.equal(writes, retry + 1);
  }
  f.setTime("14:04:11");
  assert.equal((await executor.advance({ date: signalDate })).storageRecoveryAttempts, 3);
  assert.equal(writes, 4);
  assert.equal(f.collected.length, 2);
  assert.equal(await f.store.read("live/latest.json"), null);
  assert.ok(await f.store.read(`live/${signalDate}/${signalDate}/result.json`));
});

test("a corrupted checkpoint is rejected before recollection and cannot advance latest", async (t) => {
  const f = await sandbox(t, { failedOnce: "005930" });
  const previous = { signalDate: seedDate, artifactKey: "live/previous/result.json", contentHash: "a".repeat(64) };
  await f.store.writeMutable("live/latest.json", previous);
  assert.equal((await f.executor.advance({ date: signalDate })).status, "PARTIAL");
  const filename = path.join(f.directory, `live/${signalDate}/${signalDate}/quotes/000660.json`);
  const envelope = JSON.parse(await fs.readFile(filename, "utf8"));
  envelope.value.price += 1;
  await fs.writeFile(filename, JSON.stringify(envelope), "utf8");
  const requests = f.collected.length;
  f.setTime("14:00:30");
  const rejected = await f.executor.advance({ date: signalDate });
  assert.equal(rejected.status, "FAILED");
  assert.equal(rejected.reason, "LIVE_STORE_HASH_MISMATCH");
  assert.equal(f.collected.length, requests);
  assert.deepEqual(await f.store.read("live/latest.json"), previous);
  assert.equal(await fs.readFile(filename, "utf8"), JSON.stringify(envelope));
});

test("nonfinite model output fails validation without publishing or changing prior success", async (t) => {
  let published = 0;
  const f = await sandbox(t, { publish: async () => { published += 1; } });
  const seed = fixtureSeed();
  for (const record of seed.records) for (const row of record.rows) {
    row[1] = 1e308; row[2] = 1.1e308; row[3] = 9e307; row[4] = 1e308;
  }
  const { contentHash: omitted, ...base } = seed;
  void omitted;
  seed.contentHash = intradaySeedHash(base);
  const previous = { signalDate: seedDate, artifactKey: "live/previous/result.json", contentHash: "b".repeat(64) };
  await f.store.writeMutable("live/latest.json", previous);
  const result = await createExecutor({ ...f.options, loadSeed: async () => seed }).advance({ date: signalDate });
  assert.equal(result.status, "FAILED");
  assert.equal(result.reason, "MODEL_SIGNAL_VALIDATION_FAILED");
  assert.equal(published, 0);
  assert.equal(await f.store.read(`live/${signalDate}/${signalDate}/result.json`), null);
  assert.deepEqual(await f.store.read("live/latest.json"), previous);
});

test("a forcibly terminated process resumes persisted quotes in another process", { timeout: 20000 }, async (t) => {
  const f = await sandbox(t);
  const childScript = `
    import {createExecutor} from ${JSON.stringify(new URL("./engine.mjs", import.meta.url).href)};
    import {createLocalExecutionStore} from ${JSON.stringify(new URL("./store.mjs", import.meta.url).href)};
    process.once('message', async ({directory, seed, date, formulaEvidence, crash}) => {
      const store = createLocalExecutionStore(directory), calls = [];
      const stamp = date + (crash ? 'T05:00:10.000Z' : 'T05:01:00.000Z');
      const source = {
        calendar: async () => ({isTradingDay:true,source:'TEST_FIXTURE'}),
        collectQuote: async (code) => {
          calls.push(code);
          if(crash && code==='005930') return new Promise(()=>{});
          const previous=seed.records.find(row=>row.code===code).rows[0][4];
          return {code,source:'TEST_FIXTURE',priceBasis:'testOnly',asOfDate:date,asOfTime:crash?'14:00:10':'14:01:00',receivedAt:stamp,
            open:previous+1,high:previous+25,low:previous-5,price:previous+20,volume:160000,change:20,rate:20/previous*100};
        }
      };
      const wrapped={...store,writeImmutable:async(key,value)=>{
        const result=await store.writeImmutable(key,value);
        if(crash && key.endsWith('/quotes/000660.json'))process.send({event:'checkpointStored'});
        return result;
      }};
      try {
        const result=await createExecutor({store:wrapped,source,requireFinalInputRefresh:false,loadSeed:async()=>seed,verifySeedSession:async()=>seed.requestedDate,verifyFormula:async()=>formulaEvidence,now:()=>Date.parse(stamp),expectedUniverseCount:2}).advance({date});
        process.send({event:'finished',status:result.status,calls},()=>process.disconnect());
      }catch(error){process.send({event:'error',code:/^[A-Z_]+$/.test(error.message)?error.message:'CHILD_FAILED'},()=>process.disconnect());}
    });
  `;
  const launch = (crash) => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", childScript], { windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"] });
    let logs = "";
    child.stdout.on("data", (value) => { logs += value; });
    child.stderr.on("data", (value) => { logs += value; });
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
    const message = once(child, "message"), exited = once(child, "exit");
    child.send({ directory: f.directory, seed: f.seed, date: signalDate, formulaEvidence, crash });
    return { child, message, exited, logs: () => logs };
  };
  const first = launch(true);
  assert.deepEqual((await first.message)[0], { event: "checkpointStored" });
  const checkpoint = `live/${signalDate}/${signalDate}/quotes/000660.json`;
  const before = await fs.readFile(path.join(f.directory, checkpoint), "utf8");
  assert.equal(first.child.kill("SIGKILL"), true);
  await first.exited;
  assert.equal(await f.store.read("live/latest.json"), null);
  const second = launch(false);
  const result = (await second.message)[0];
  assert.deepEqual(result, { event: "finished", status: "STORED", calls: ["005930"] });
  await second.exited;
  assert.equal(first.logs(), ""); assert.equal(second.logs(), "");
  assert.equal(await fs.readFile(path.join(f.directory, checkpoint), "utf8"), before);
  const artifact = await f.store.read((await f.store.read("live/latest.json")).artifactKey);
  assert.equal(artifact.collection.successful, 2);
  assert.equal(artifact.records.find((record) => record.ticker === "000660").quote.asOfTime, "14:00:10");
  assert.equal(artifact.records.find((record) => record.ticker === "005930").quote.asOfTime, "14:01:00");
});
