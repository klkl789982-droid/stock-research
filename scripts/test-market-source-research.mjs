import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { normalizeResearchHistory, adaptPublicEodResponse, adaptKisEodResponse, compareResearchObservations, verifyResearchObservation, RIGHTS } from "../lib/market-source-contract.mjs";
import { createResearchCollector } from "../lib/market-source-collector.mjs";
import { analyzeResearchBatch, queryResearchTop, compareResearchModels, storeResearchResult, readResearchResult } from "../lib/market-source-research.mjs";
import { createLocalPrivateModelStore } from "../lib/kis-eod-private-local-store.mjs";
import { calculateEligibleSnapshotModels } from "../lib/model-score-engine.mjs";
import { KIS_EOD_MODEL_VERSIONS } from "../lib/kis-eod-pipeline.mjs";
import { sha256Canonical } from "../lib/snapshot-quality-pipeline.mjs";
import { diagnosePublicLatest } from "./diagnose-market-source-latest.mjs";
import { queryStoredResearch } from "./query-market-source-research.mjs";

// All prices, dates, grants and evidence IDs in this file are synthetic.
const date = "2026-10-08", stamp = "2026-10-08T07:00:00Z";
const grants = Object.fromEntries(["PUBLIC_EOD", "KIS"].map((id) => [id, Object.fromEntries(RIGHTS.map((r) => [r, { status: "ALLOWED", evidenceId: "SYNTHETIC_TEST_ONLY" }]))]));
const hashes = Object.fromEntries(KIS_EOD_MODEL_VERSIONS.map((v) => [v, sha256Canonical(v)]));
function history(ticker = "005930", count = 260) {
  const rows = [], day = new Date(`${date}T00:00:00Z`);
  while (rows.length < count) {
    if (![0, 6].includes(day.getUTCDay())) {
      const clpr = 2000 - rows.length, trqu = 10000 + rows.length;
      rows.push({ srtnCd: ticker, basDt: day.toISOString().slice(0, 10).replaceAll("-", ""), mkp: clpr - 4, hipr: clpr + 8, lopr: clpr - 8, clpr, trqu, trPrc: clpr * trqu, fltRt: 1 / (clpr - 1) * 100 });
    }
    day.setUTCDate(day.getUTCDate() - 1);
  }
  return rows;
}
function observation(ticker = "005930", extra = {}) {
  return normalizeResearchHistory({ provider: "PUBLIC_EOD", ticker, referenceDate: date, rows: history(ticker), requestedAt: stamp, receivedAt: stamp,
    adjustment: "unadjusted", sessionScope: "REGULAR", sourceFinality: "SUPPLIER_OFFICIAL", observationType: "TEST_FIXTURE", rawSourceHash: sha256Canonical("fixture"), ...extra });
}
function batch(count = 3) {
  const universe = Array.from({ length: count }, (_, i) => ({ code: String(i + 1).padStart(6, "0"), name: `합성 ${i}` }));
  return { observations: universe.map((r) => observation(r.code)), universe, referenceDate: date, officialSnapshot: { asOfDate: "2026-10-07", records: [] },
    formulaHashes: hashes, expectedFormulaHashes: hashes, grants, asOf: stamp };
}
const query = { ticker: "005930", referenceDate: date, adjustment: "unadjusted" };

test("contract keeps missing values, date/ticker/duplicate checks and tamper detection", () => {
  const o = observation(); assert.equal(verifyResearchObservation(o), o);
  assert.throws(() => verifyResearchObservation({ ...o, rows: [] }), /HASH/);
  for (const mutate of [(r) => { r[0].basDt = "20261009"; }, (r) => { r[1].basDt = r[0].basDt; }, (r) => { r[0].srtnCd = "000660"; }, (r) => { r[0].trqu = true; }]) {
    const rows = history(); mutate(rows); assert.throws(() => observation("005930", { rows }));
  }
  const rows = history(); rows[0].trPrc = null;
  const missing = observation("005930", { rows }); assert.equal(missing.rows[0].trPrc, null); assert.equal(missing.quality.status, "NOT_READY");
  const stale = observation("005930", { rows: history().slice(1) }); assert.ok(stale.quality.issues.includes("EXACT_DATE_UNAVAILABLE"));
  assert.throws(() => observation("005930", { receivedAt: "2026-10-08T06:00:00Z" }), /TIMESTAMPS/);
});
test("public and KIS adapters reuse parsing and do not invent session/price equivalence", () => {
  const p = adaptPublicEodResponse({ response: { header: { resultCode: "00" }, body: { items: { item: history() } } } }, { ticker: "005930", referenceDate: date });
  assert.equal(p.adjustment, "UNKNOWN"); assert.equal(p.sessionScope, "UNKNOWN");
  const payload = { rt_cd: "0", output1: { stck_shrn_iscd: "005930" }, output2: [{ stck_bsop_date: "20261008", stck_oprc: "1996", stck_hgpr: "2008", stck_lwpr: "1992", stck_clpr: "2000", acml_vol: "10000", acml_tr_pbmn: "20000000" }] };
  const k = adaptKisEodResponse(payload, { ticker: "005930", referenceDate: date, startDate: date, adjustment: "unadjusted" });
  assert.equal(k.sourceFinality, "PROVISIONAL"); assert.equal(k.sessionScope, "UNKNOWN");
  assert.equal(compareResearchObservations(p, k).status, "DIAGNOSTIC_ONLY");
  assert.throws(() => adaptKisEodResponse({ ...payload, output1: {} }, { ticker: "005930", referenceDate: date, startDate: date, adjustment: "unadjusted" }), /TICKER/);
});
test("comparison records price differences without replacement; basis, date and action mismatches block equivalence", () => {
  const a = observation(), rows = history(); rows[0].clpr += 1;
  const b = observation("005930", { provider: "KIS", rows });
  const diff = compareResearchObservations(a, b); assert.equal(diff.fields.clpr.difference, 1); assert.equal(diff.officialReplacementAllowed, false);
  for (const extra of [{ adjustment: "adjusted" }, { sessionScope: "REGULAR_AND_AFTER_HOURS" }, { corporateActionStatus: "EVENT_REPORTED" }, { ticker: "000660", rows: history("000660") }]) {
    assert.equal(compareResearchObservations(a, observation(extra.ticker ?? "005930", extra)).status, "DIAGNOSTIC_ONLY");
  }
});
test("553 complete synthetic observations reproduce unchanged engines and TOP5/10/20", () => {
  const input = batch(553), result = analyzeResearchBatch(input);
  assert.equal(result.status, "RESEARCH_CALCULATED"); assert.equal(result.publicationEligible, false);
  const direct = calculateEligibleSnapshotModels(history("000001"), Object.fromEntries(KIS_EOD_MODEL_VERSIONS.map((v) => [v, true])));
  assert.deepEqual(result.records[0].scores, { "A-v1": direct.modelA.finalTechnicalScore, "A-v2": direct.modelAV2.finalScore, "B-v1": direct.modelB.trendStrength, "C-v1": direct.modelC.entryStrength, "D-v1": direct.modelD });
  for (const v of KIS_EOD_MODEL_VERSIONS) for (const n of [5, 10, 20]) {
    const top = queryResearchTop(result, v, n); assert.equal(top.rows.length, n); assert.deepEqual(top.rows.map((r) => r.rank), Array.from({ length: n }, (_, i) => i + 1));
  }
  assert.deepEqual(result, analyzeResearchBatch(input));
  assert.equal(compareResearchModels(result, result).models["B-v1"].topOverlap[20].commonCount, 20);
});
test("incomplete, wrong hash, unknown/mixed basis, pre-close/future observations block ranking", () => {
  for (const mutate of [
    (b) => b.observations.pop(), (b) => { b.formulaHashes = { ...hashes, "A-v2": sha256Canonical("changed") }; },
    (b) => { b.observations[0] = observation("000001", { adjustment: "UNKNOWN" }); },
    (b) => { b.observations[0] = observation("000001", { sessionScope: "REGULAR_AND_AFTER_HOURS" }); },
    (b) => { b.asOf = "2026-10-08T05:00:00Z"; }, (b) => { b.grants = {}; },
    (b) => { b.observations[0] = observation("000001", { receivedAt: "2026-10-08T08:00:00Z" }); },
  ]) {
    const b = batch(); mutate(b); const r = analyzeResearchBatch(b);
    assert.equal(r.status, "BLOCKED"); assert.equal(queryResearchTop(r, "B-v1", 5).rows.length, 0);
    assert.ok(r.records.every((x) => Object.values(x.ranks).every((v) => v === null)));
  }
});
test("quarantine, short history, delisting and halt remain explicit exclusions", () => {
  const b = batch(4);
  b.officialSnapshot.records = [{ code: "000001", qualityEligibility: { status: "quarantined", exclusions: ["existing"] } }];
  b.observations[1] = observation("000002", { rows: history("000002", 34), securityStatus: "NEW_LISTING" });
  b.observations[2] = observation("000003", { securityStatus: "DELISTED" });
  const rows = history("000004"); Object.assign(rows[0], { mkp: 0, hipr: 0, lopr: 0, clpr: rows[1].clpr, trqu: 0, trPrc: 0 });
  b.observations[3] = observation("000004", { rows, securityStatus: "HALTED" });
  const r = analyzeResearchBatch(b); assert.equal(r.status, "RESEARCH_CALCULATED");
  assert.equal(r.records[0].exclusionReasons["B-v1"], "officialQuarantinePreserved");
  assert.equal(r.records[1].exclusionReasons["B-v1"], "insufficientHistory"); assert.ok(Number.isFinite(r.records[1].scores["C-v1"]));
  assert.equal(r.records[2].exclusionReasons["B-v1"], "delisted"); assert.equal(r.records[3].exclusionReasons["B-v1"], "tradingHaltOrNoTrade");
});
test("collector singleflight, per-source pacing and bounded retry", async () => {
  let clock = Date.parse(stamp), calls = 0; const waits = [];
  const c = createResearchCollector({ grants, now: () => clock, wait: async (ms) => { waits.push(ms); clock += ms; }, providers: [{ id: "PUBLIC_EOD", minIntervalMs: 1000, maxAttempts: 3,
    request: async ({ ticker }) => { calls++; if (calls === 1) throw Object.assign(new Error("secret must never leak"), { code: "SOURCE_RATE_LIMIT" }); return observation(ticker); } }] });
  const [a, b] = await Promise.all([c.collect("PUBLIC_EOD", query), c.collect("PUBLIC_EOD", query)]);
  assert.equal(a, b); assert.equal(calls, 2); assert.equal(a.attempts, 2); assert.ok(waits.includes(500)); assert.ok(waits.includes(500));
  await c.collect("PUBLIC_EOD", { ...query, ticker: "000660" }); assert.equal(calls, 3);
  assert.equal(c.status().PUBLIC_EOD.latestCollectedDate, date); assert.equal(c.status().PUBLIC_EOD.latestPublishedDate, null);
});
test("provider failures are independent, circuits recover and errors remain redacted", async () => {
  let clock = Date.parse(stamp), broken = true;
  const c = createResearchCollector({ grants, now: () => clock, wait: async () => {}, providers: [
    { id: "PUBLIC_EOD", minIntervalMs: 0, breakerThreshold: 1, cooldownMs: 100, request: async () => { if (broken) throw new Error("sensitive-url-and-token"); return observation(); } },
    { id: "KIS", minIntervalMs: 0, request: async () => observation("005930", { provider: "KIS" }) },
  ] });
  const results = await c.collectIndependent([{ provider: "PUBLIC_EOD", ...query }, { provider: "KIS", ...query }]);
  assert.equal(results[0].status, "FAILED"); assert.equal(results[1].status, "COLLECTED"); assert.ok(!JSON.stringify(results[0]).includes("sensitive"));
  assert.equal((await c.collect("PUBLIC_EOD", query)).reason, "SOURCE_CIRCUIT_OPEN");
  broken = false; clock += 101; assert.equal((await c.collect("PUBLIC_EOD", query)).status, "COLLECTED");
});
test("timeout stops retries/overlap until underlying request settles; malformed responses cannot update latest", async () => {
  let resolveRequest, calls = 0;
  const c = createResearchCollector({ grants, providers: [{ id: "PUBLIC_EOD", timeoutMs: 5, maxAttempts: 3, minIntervalMs: 0, request: () => { calls++; return new Promise((r) => { resolveRequest = r; }); } }] });
  assert.equal((await c.collect("PUBLIC_EOD", query)).reason, "SOURCE_TIMEOUT");
  assert.equal((await c.collect("PUBLIC_EOD", query)).reason, "SOURCE_TIMEOUT_STILL_IN_FLIGHT"); assert.equal(calls, 1);
  resolveRequest(observation()); await new Promise((r) => setTimeout(r, 0)); assert.equal(c.status().PUBLIC_EOD.requestStillRunning, false);
  const invalid = createResearchCollector({ grants, providers: [{ id: "KIS", request: async () => ({ referenceDate: date, quality: { status: "VALIDATED_FIELDS_ONLY" } }) }] });
  assert.equal((await invalid.collect("KIS", query)).reason, "SOURCE_RESPONSE_CONTRACT_INVALID"); assert.equal(invalid.status().KIS.latestCollectedDate, null);
  const denied = createResearchCollector({ providers: [{ id: "KIS", request: async () => { throw new Error("must not call"); } }] });
  assert.equal((await denied.collect("KIS", query)).status, "BLOCKED");
});
test("private existing adapter supports create-only, restart/read/hash, revised versions and input binding", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tb-source-test-"));
  try {
    const b = batch(), result = analyzeResearchBatch(b), store = createLocalPrivateModelStore(root);
    const saved = await storeResearchResult({ store, result, observations: b.observations, grants });
    assert.deepEqual(await readResearchResult({ store: createLocalPrivateModelStore(root), key: saved.key, grants }), result);
    assert.equal((await queryStoredResearch({ root, key: saved.key, grants, version: "B-v1", limit: 5 })).rows.length, 3);
    assert.deepEqual(await storeResearchResult({ store, result, observations: b.observations, grants }), saved);
    await assert.rejects(storeResearchResult({ store, result, observations: [observation(), ...b.observations.slice(1)], grants }), /INPUT_MISMATCH/);
    await assert.rejects(readResearchResult({ store, key: saved.key, grants: {} }), /RIGHTS/);
    await assert.rejects(store.writeImmutable(saved.key, { different: true }), /CONFLICT/);
    const revised = batch(); const rows = history("000001"); rows[0].clpr += 1; revised.observations[0] = observation("000001", { rows });
    const revisedResult = analyzeResearchBatch(revised), next = await storeResearchResult({ store, result: revisedResult, observations: revised.observations, grants });
    assert.notEqual(next.key, saved.key); assert.deepEqual(await readResearchResult({ store, key: saved.key, grants }), result);
    const partial = batch(); partial.observations.pop(); const blocked = analyzeResearchBatch(partial);
    const failedManifest = await storeResearchResult({ store, result: blocked, observations: partial.observations, grants });
    const recoveredFailure = await readResearchResult({ store, key: failedManifest.key, grants });
    assert.equal(recoveredFailure.status, "BLOCKED"); assert.equal(queryResearchTop(recoveredFailure, "B-v1", 5).rows.length, 0);
    assert.deepEqual(await readResearchResult({ store, key: saved.key, grants }), result);
    const corrupt = { ...store, read: async (key) => { const item = await store.read(key); return key.includes("/inputs/") ? { ...item, value: { wrong: true } } : item; } };
    await assert.rejects(readResearchResult({ store: corrupt, key: saved.key, grants }), /HASH/);
    await assert.rejects(storeResearchResult({ store: { writeImmutable: async () => { throw new Error("STORE_OFFLINE"); } }, result, observations: b.observations, grants }), /STORE_OFFLINE/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("source delay remains pending and later explicit retry recovers; all sources failing cannot publish", async () => {
  let ready = false;
  const c = createResearchCollector({ grants, providers: [{ id: "PUBLIC_EOD", minIntervalMs: 0,
    request: async () => observation("005930", { rows: ready ? history() : [] }) }] });
  assert.equal((await c.collect("PUBLIC_EOD", query)).status, "SOURCE_PENDING");
  assert.equal(c.status().PUBLIC_EOD.latestCollectedDate, null); assert.equal(c.status().PUBLIC_EOD.lastFailureCode, null);
  assert.ok(c.status().PUBLIC_EOD.nextCheckAt); ready = true;
  assert.equal((await c.collect("PUBLIC_EOD", query)).status, "COLLECTED"); assert.equal(c.status().PUBLIC_EOD.latestCollectedDate, date);
  const failed = createResearchCollector({ grants, providers: ["PUBLIC_EOD", "KIS"].map((id) => ({ id, request: async () => { throw Object.assign(new Error("server"), { code: "SOURCE_SERVER_ERROR" }); } })) });
  assert.ok((await failed.collectIndependent(["PUBLIC_EOD", "KIS"].map((provider) => ({ provider, ...query })))).every((r) => r.status === "FAILED"));
  assert.ok(Object.values(failed.status()).every((s) => s.latestPublishedDate === null));
});
test("read-only diagnosis distinguishes empty/business/network responses, key excluded from output", async () => {
  let calls = 0;
  const report = await diagnosePublicLatest({ date, control: "2026-10-07", serviceKey: "synthetic-secret", fetchImpl: async (url, options) => {
    calls++; assert.equal(options.cache, "no-store"); assert.equal(new URL(url).searchParams.get("serviceKey"), "synthetic-secret");
    return new Response(new URL(url).searchParams.get("resultType") === "xml" ? "<resultCode>00</resultCode><totalCount>0</totalCount>" : JSON.stringify({ response: { header: { resultCode: "00" }, body: { totalCount: 0, items: {} } } }), { status: 200 });
  } });
  assert.equal(calls, 10); assert.equal(report.sourceAbsenceConfirmed, false); assert.ok(report.results.every((r) => r.status === "EMPTY_RESPONSE_NOT_PROOF_OF_ABSENCE"));
  assert.ok(!JSON.stringify(report).includes("synthetic-secret"));
  const failed = await diagnosePublicLatest({ date, control: "2026-10-07", serviceKey: "synthetic", fetchImpl: async () => { throw new Error("token in error"); } });
  assert.ok(failed.results.every((r) => r.status === "NETWORK_OR_PARSE_FAILURE")); assert.ok(!JSON.stringify(failed).includes("token in error"));
});
