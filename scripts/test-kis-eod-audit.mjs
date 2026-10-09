import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { auditKisEodPrivate, evaluateKisEodAuditHistory, describeRejectedKisEodResponse } from "./audit-kis-eod-private.mjs";
import { KIS_EOD_MODEL_VERSIONS } from "../lib/kis-eod-pipeline.mjs";

const date = "2026-10-08", now = () => new Date("2026-10-09T00:00:00Z");
function history(code = "005930", count = 260) {
  const rows = Array.from({ length: count }, (_, index) => {
    const day = new Date(`${date}T00:00:00Z`); day.setUTCDate(day.getUTCDate() - index);
    const price = 1000 + count - index;
    return { basDt: day.toISOString().slice(0, 10).replaceAll("-", ""), srtnCd: code, mkp: price, hipr: price + 2, lopr: price - 2, clpr: price + 1, trqu: 1000, trPrc: price * 1000, fltRt: null, observationStatus: "trading" };
  });
  return { code, rows, referenceDate: date, source: "KIS", sourceOperation: "inquire-daily-itemchartprice", adjustment: "unadjusted", priceBasis: "kisDailyBarUnadjusted", marketDivision: "J", pageCount: Math.ceil(count / 100),
    requestedAt: now().toISOString(), receivedAt: now().toISOString(), historyComplete: count >= 260, adjustmentMetadata: [], dailyChangeMetadata: [], symbolMapping: { status: "VERIFIED_RESPONSE_TICKER", requestedCode: code, responseCode: code } };
}
const calendar = { referenceDate: date, source: "KIS", operation: "chk-holiday", isTradingDay: true, sourceFields: { bass_dt: "20261008", opnd_yn: "Y", tr_day_yn: "Y" } };
function inputs(count = 2) {
  const universeRecords = Array.from({ length: count }, (_, index) => ({ code: String(index + 1).padStart(6, "0"), name: `fixture${index}`, market: "KOSPI" }));
  const hashes = Object.fromEntries(KIS_EOD_MODEL_VERSIONS.map((version) => [version, "a".repeat(64)]));
  return { universeRecords, officialSnapshot: { asOfDate: "2026-10-07", records: universeRecords.map((stock, index) => ({ code: stock.code, qualityEligibility: { status: index === 0 ? "quarantined" : "eligible" } })) },
    formulaHashes: hashes, expectedFormulaHashes: hashes, formulaHashScope: "currentHEADFormulaSourceFilesLfNormalized" };
}
async function temporary(body) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "kis-eod-private-audit-"));
  try { await body(root); } finally { await fs.rm(root, { recursive: true, force: true }); }
}
test("historical empirical inputs reuse unchanged model engine deterministically", () => {
  const result = evaluateKisEodAuditHistory(history(), date);
  assert.equal(result.deterministic, true); assert.equal(result.fullHistoryAvailable, true);
  assert.ok(Object.values(result.eligibility).every(Boolean)); assert.ok(Object.values(result.scores).every(Number.isFinite));
});
test("rejected response diagnosis whitelists raw chart fields privately, not credentials", () => {
  const diagnosis = describeRejectedKisEodResponse({ code: "005930", referenceDate: date, adjustment: "unadjusted", reason: "KIS_EOD_OHLCV_INVALID", payload: {
    access_token: "synthetic-secret", output2: [{ stck_bsop_date: "20261008", stck_oprc: "100", stck_hgpr: "99", stck_lwpr: "95", stck_clpr: "105", acml_vol: "10", access_token: "synthetic-secret" }] } });
  assert.equal(diagnosis.publicationEligible, false);
  assert.deepEqual(diagnosis.violations, [{ date: "20261008", reasons: ["invalidOhlcRelationship"] }]);
  assert.ok(!JSON.stringify(diagnosis).includes("synthetic-secret"));
});
test("quarantine preserved; short-history and halt never receive fabricated scores", () => {
  const quarantine = evaluateKisEodAuditHistory(history(), date, true);
  assert.ok(Object.values(quarantine.exclusions).every((reason) => reason === "officialQuarantinePreserved"));
  assert.ok(Object.values(quarantine.scores).every((score) => score === null));
  const short = evaluateKisEodAuditHistory(history("005930", 40), date);
  assert.equal(short.eligibility["C-v1"], true); assert.equal(short.eligibility["B-v1"], false);
  const halted = history(); Object.assign(halted.rows[0], { mkp: 0, hipr: 0, lopr: 0, clpr: halted.rows[1].clpr, trqu: 0, trPrc: 0, observationStatus: "tradingHaltOrNoTrade" });
  assert.equal(evaluateKisEodAuditHistory(halted, date).inputFailure, "tradingHaltOrNoTrade");
});
test("date, duplicate, adjustment, source mapping and missing value fail closed", () => {
  const mismatch = history(); mismatch.rows[0].basDt = "20261007";
  assert.equal(evaluateKisEodAuditHistory(mismatch, date).inputFailure, "latestDateMismatch");
  const duplicate = history(); duplicate.rows[1].basDt = duplicate.rows[0].basDt;
  assert.equal(evaluateKisEodAuditHistory(duplicate, date).inputFailure, "duplicateDates");
  const adjusted = history(); adjusted.adjustment = "adjusted";
  assert.equal(evaluateKisEodAuditHistory(adjusted, date).inputFailure, "adjustmentMismatch");
  const missing = history(); missing.rows[0].trPrc = null;
  assert.equal(evaluateKisEodAuditHistory(missing, date).inputFailure, "invalidTradingValue");
  assert.equal(evaluateKisEodAuditHistory(history(), date, false, "000660").proofFailure, "sourceProvenanceUnverified");
  for (const key of ["sourceOperation", "marketDivision", "referenceDate", "receivedAt", "requestedAt"]) {
    const missingProof = history(); delete missingProof[key];
    assert.equal(evaluateKisEodAuditHistory(missingProof, date).proofFailure, "sourceProvenanceUnverified");
  }
});
test("default dry-run is network/write free; current and future cannot fake close-time data", async () => {
  const options = { referenceDate: date, now, loadInputs: async () => inputs(), provider: { getHistory: () => { throw new Error("network forbidden"); } } };
  const result = await auditKisEodPrivate(options);
  assert.equal(result.networkRequests, 0); assert.equal(result.filesWritten, 0);
  for (const referenceDate of ["2026-10-09", "2026-10-10", "2026-02-30"]) assert.equal((await auditKisEodPrivate({ ...options, referenceDate })).status, "BLOCKED");
});
test("all 553 observed including quarantine; raw remains private, reexecution reuses immutable input", async () => temporary(async (root) => {
  let calls = 0;
  const fixture = inputs(553);
  const provider = { getTradingDay: async () => calendar, getHistory: async (code) => { calls += 1; return history(code); } };
  const options = { root, referenceDate: date, now, collectPrivate: true, expectedUniverseCount: 553, loadInputs: async () => fixture, provider };
  const first = await auditKisEodPrivate(options);
  assert.equal(first.collectedCount, 553); assert.equal(first.attemptedCount, 553); assert.equal(first.quarantineCount, 1);
  assert.equal(first.modelCoverage["B-v1"].eligibleCount, 552); assert.equal(calls, 553);
  assert.ok(first.privateReportPath.startsWith(".runtime/kis-eod/")); assert.equal(first.productionChanged, false); assert.equal(first.publicationEligible, false);
  const second = await auditKisEodPrivate(options);
  assert.equal(second.reusedCount, 553); assert.equal(second.freshCollectedCount, 0); assert.equal(calls, 553);
  assert.equal(second.manifestHash, first.manifestHash);
  await assert.rejects(fs.stat(path.join(root, "data")), { code: "ENOENT" });
}));
test("partial failure isolated and retry resumes; unsafe errors do not leak", async () => temporary(async (root) => {
  let failSecond = true, calls = 0;
  const provider = { getTradingDay: async () => calendar, getHistory: async (code) => { calls += 1; if (code === "000002" && failSecond) throw new Error("https://host/?secret=synthetic-only"); return history(code); } };
  const options = { root, referenceDate: date, now, collectPrivate: true, expectedUniverseCount: 2, loadInputs: async () => inputs(), provider };
  const first = await auditKisEodPrivate(options);
  assert.equal(first.status, "PARTIAL"); assert.equal(first.collectedCount, 1); assert.equal(first.failedCount, 1);
  assert.ok(!JSON.stringify(first).includes("synthetic-only")); failSecond = false;
  const next = await auditKisEodPrivate(options);
  assert.equal(next.collectedCount, 2); assert.equal(next.reusedCount, 1); assert.equal(calls, 3);
}));
test("closed calendar makes zero bar requests; repeated auth failure has bounded stop", async () => temporary(async (root) => {
  const closed = { ...calendar, isTradingDay: false, sourceFields: { bass_dt: "20261008", opnd_yn: "N", tr_day_yn: "N" } };
  const options = { root, referenceDate: date, now, collectPrivate: true, expectedUniverseCount: 5, loadInputs: async () => inputs(5) };
  let calls = 0;
  const noBars = await auditKisEodPrivate({ ...options, provider: { getTradingDay: async () => closed, getHistory: () => { calls += 1; } } });
  assert.equal(noBars.status, "PENDING"); assert.equal(calls, 0);
  // Separate folder/manifest: a previously closed response is not modified.
  const otherRoot = path.join(root, "auth-fixture"); await fs.mkdir(otherRoot);
  const auth = await auditKisEodPrivate({ ...options, root: otherRoot, provider: { getTradingDay: async () => calendar, getHistory: async () => { calls += 1; throw Object.assign(new Error("auth"), { code: "KIS_EOD_AUTHENTICATION_FAILED" }); } } });
  assert.equal(auth.attemptedCount, 3); assert.equal(auth.unattemptedCount, 2); assert.equal(calls, 3);
}));
