import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getKisEodLocalClock, runKisEod, KIS_EOD_RUNNER_REASONS, KIS_EOD_RUNNER_STATUSES } from "./run-kis-eod.mjs";
import { sha256Canonical } from "../lib/snapshot-quality-pipeline.mjs";
import { validateKisEodCandidate, KIS_EOD_MODEL_VERSIONS } from "../lib/kis-eod-pipeline.mjs";

const referenceDate = "2026-10-08";
const now = "2026-10-08T11:00:00Z";
const formulaHashes = Object.fromEntries(KIS_EOD_MODEL_VERSIONS.map((version) => [version, sha256Canonical(version)]));
function fixtureInputs(count = 3) {
  const universeRecords = Array.from({ length: count }, (_, index) => ({ code: String(index + 1).padStart(6, "0"), name: `합성 종목 ${index + 1}`, market: index % 2 ? "KOSDAQ" : "KOSPI" }));
  const officialSnapshot = { asOfDate: "2026-10-07", records: universeRecords.map(({ code }) => ({ code, qualityEligibility: { status: "eligible", exclusions: [] } })), sourceManifest: { modelFormulaHashes: formulaHashes } };
  return { universeRecords, officialSnapshot, formulaHashes, expectedFormulaHashes: formulaHashes, formulaHashScope: "currentHEADFormulaSourceFilesLfNormalized" };
}
function history(date = referenceDate, count = 260) {
  const rows = [], day = new Date(`${date}T00:00:00Z`);
  while (rows.length < count) {
    if (![0, 6].includes(day.getUTCDay())) {
      const close = 2000 - rows.length;
      rows.push({ basDt: day.toISOString().slice(0, 10).replaceAll("-", ""), mkp: close - 4, hipr: close + 8, lopr: close - 8, clpr: close, trqu: 10000 + rows.length, trPrc: close * (10000 + rows.length), fltRt: null });
    }
    day.setUTCDate(day.getUTCDate() - 1);
  }
  return rows;
}
function providerFixture({ date = referenceDate, stamp = now, isTradingDay = true, failCode = null, count = 260, receivedAt = null } = {}) {
  const calls = { calendar: 0, histories: [] };
  return { calls,
    async getTradingDay(actualDate) {
      calls.calendar += 1; assert.equal(actualDate, date);
      return { source: "KIS", operation: "chk-holiday", referenceDate: date, isTradingDay, receivedAt: stamp,
        sourceFields: { bass_dt: date.replaceAll("-", ""), opnd_yn: isTradingDay === false ? "N" : "Y", tr_day_yn: isTradingDay === true ? "Y" : "N" } };
    },
    async getHistory(code, actualDate, options) {
      calls.histories.push(code); assert.equal(actualDate, date); assert.deepEqual(options, { adjustment: "unadjusted", requiredRows: 260, maxPages: 5 });
      if (code === failCode) { const error = new Error("https://example.invalid/?token=NEVER_LOG_THIS_SECRET"); error.code = "KIS_EOD_RATE_LIMIT"; throw error; }
      return { code, rows: history(date, count), adjustment: "unadjusted", marketDivision: "J", priceBasis: "kisDailyBarUnadjusted", receivedAt: receivedAt ?? stamp, historyComplete: count >= 260, pageCount: 3,
        symbolMapping: { status: "VERIFIED_RESPONSE_TICKER", requestedCode: code, responseCode: code }, adjustmentMetadata: [] };
    } };
}
async function sandbox(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tight-budget-kis-eod-runner-"));
  t.after(async () => { const absolute = path.resolve(root); assert.ok(absolute.startsWith(`${path.resolve(os.tmpdir())}${path.sep}tight-budget-kis-eod-runner-`)); await fs.rm(absolute, { recursive: true, force: true }); });
  await fs.mkdir(path.join(root, "data", "history"), { recursive: true });
  await fs.writeFile(path.join(root, "data", "history", "frozen.json"), "FROZEN_OFFICIAL_DATA\n");
  return root;
}
const run = (root, provider, options = {}) => runKisEod({ root, now, provider, collectPrivate: true, collectionEnabled: "true", expectedUniverseCount: 3, loadInputs: async () => fixtureInputs(), ...options });
const read = async (root, relative) => JSON.parse(await fs.readFile(path.join(root, relative), "utf8"));

test("default dry-run is read-only, makes no KIS calls, and does not create runtime files", async (t) => {
  const root = await sandbox(t), provider = providerFixture();
  const result = await run(root, provider, { collectPrivate: false });
  assert.equal(result.status, "DRY_RUN_READY"); assert.equal(result.reason, "PLAN_ONLY");
  assert.equal(result.formulaHashesVerified, true); assert.equal(result.networkRequests, 0); assert.equal(result.filesWritten, 0);
  assert.equal(provider.calls.calendar, 0); assert.deepEqual(provider.calls.histories, []);
  await assert.rejects(fs.access(path.join(root, ".runtime")), { code: "ENOENT" });
});

test("collection gate requires exact true, including independent manual CLI intent", async (t) => {
  const root = await sandbox(t), provider = providerFixture();
  for (const collectionEnabled of [null, "", "false", "TRUE", true]) {
    const result = await run(root, provider, { collectionEnabled });
    assert.equal(result.status, "BLOCKED"); assert.equal(result.reason, "COLLECTION_NOT_ENABLED");
  }
  assert.equal(provider.calls.calendar, 0); assert.deepEqual(provider.calls.histories, []);
});

test("before 15:30 KST and weekends cannot even request a calendar or any bars", async (t) => {
  const root = await sandbox(t), provider = providerFixture();
  assert.equal((await run(root, provider, { now: "2026-10-08T06:29:59Z" })).reason, "BEFORE_MARKET_CLOSE");
  assert.equal((await run(root, provider, { now: "2026-10-10T07:00:00Z" })).reason, "WEEKEND");
  assert.equal(provider.calls.calendar, 0); assert.deepEqual(provider.calls.histories, []);
});

test("closed or conflicting official calendar flags never collect bars", async (t) => {
  for (const isTradingDay of [false, null]) {
    const root = await sandbox(t), provider = providerFixture({ isTradingDay });
    const first = await run(root, provider), second = await run(root, provider);
    assert.equal(first.status, "PENDING"); assert.equal(first.reason, isTradingDay === false ? "MARKET_CLOSED" : "CALENDAR_UNKNOWN");
    assert.equal(second.reason, first.reason); assert.equal(provider.calls.calendar, 1); assert.deepEqual(provider.calls.histories, []);
  }
});

test("complete private collection calculates all A/B/C/D, preserves official data, and is unpublished", async (t) => {
  const root = await sandbox(t), provider = providerFixture(), result = await run(root, provider);
  assert.equal(result.status, "VALIDATED"); assert.equal(result.reason, "PRIVATE_CANDIDATE_READY");
  assert.equal(result.collectedCount, 3); assert.equal(result.failedCount, 0); assert.equal(result.collectionComplete, true);
  assert.equal(result.productionChanged, false); assert.equal(result.publicationEligible, false);
  assert.ok(result.candidatePath.startsWith(".runtime/kis-eod/candidates/"));
  const candidate = await read(root, result.candidatePath);
  assert.deepEqual(validateKisEodCandidate(candidate), []);
  assert.equal(candidate.observationType, "LIVE_COLLECTION"); assert.equal(candidate.source.sourceFinalityEvidence, "UNVERIFIED");
  assert.deepEqual(candidate.publicationApproval, { rights: false, rightsReference: null, automation: false });
  for (const version of KIS_EOD_MODEL_VERSIONS) assert.equal(candidate.rankingUniverse[version].count, 3);
  assert.equal(candidate.source.formulaHashScope, "currentHEADFormulaSourceFilesLfNormalized");
  assert.deepEqual(candidate.source.officialModelFormulaHashes, formulaHashes);
  assert.equal(await fs.readFile(path.join(root, "data/history/frozen.json"), "utf8"), "FROZEN_OFFICIAL_DATA\n");
  const raw = await read(root, result.rawPath);
  assert.equal(raw.histories.length, 3); assert.equal(raw.publicationEligible, false); assert.equal(raw.histories[0].rows[0].fltRt, null);
  assert.equal(raw.histories[0].symbolMapping.status, "VERIFIED_RESPONSE_TICKER");
});

test("unverified complete input is reobserved; identical input stays idempotent without immutable rewrites", async (t) => {
  const root = await sandbox(t), provider = providerFixture(), first = await run(root, provider);
  const before = await fs.readFile(path.join(root, first.candidatePath), "utf8");
  const secondProvider = providerFixture(), second = await run(root, secondProvider);
  assert.equal(second.reason, "PRIVATE_CANDIDATE_READY"); assert.equal(first.contentHash, second.contentHash); assert.equal(second.immutableAction, "idempotent");
  assert.equal(secondProvider.calls.calendar, 0); assert.equal(secondProvider.calls.histories.length, 3);
  assert.equal(await fs.readFile(path.join(root, first.candidatePath), "utf8"), before);
});

test("a later corrected provisional source creates another version and preserves the earlier complete input", async (t) => {
  const root = await sandbox(t), first = await run(root, providerFixture());
  const before = await fs.readFile(path.join(root, first.candidatePath), "utf8");
  const provider = providerFixture(), getHistory = provider.getHistory;
  provider.getHistory = async (...args) => { const response = await getHistory(...args); response.rows[0].clpr += 1; return response; };
  const second = await run(root, provider);
  assert.equal(second.status, "VALIDATED"); assert.equal(second.immutableAction, "create");
  assert.notEqual(first.contentHash, second.contentHash); assert.notEqual(first.rawPath, second.rawPath);
  assert.equal(await fs.readFile(path.join(root, first.candidatePath), "utf8"), before);
});

test("partial failure continues the batch, preserves the attempt, and retry can recover missing inputs", async (t) => {
  const root = await sandbox(t), bad = providerFixture({ failCode: "000002" }), first = await run(root, bad);
  assert.equal(first.status, "VALIDATED"); assert.equal(first.collectionComplete, false); assert.equal(first.reason, "PARTIAL_COLLECTION_RETRY_REQUIRED");
  assert.deepEqual(bad.calls.histories, ["000001", "000002", "000003"]); assert.equal(first.failedCount, 1);
  assert.deepEqual(first.failures, [{ ticker: "000002", reason: "KIS_EOD_RATE_LIMIT" }]);
  assert.ok(!JSON.stringify(first).includes("NEVER_LOG_THIS_SECRET"));
  const firstBytes = await fs.readFile(path.join(root, first.candidatePath), "utf8");
  const good = providerFixture(), second = await run(root, good);
  assert.equal(second.status, "VALIDATED"); assert.equal(second.collectionComplete, true); assert.equal(second.collectedCount, 3);
  assert.equal(good.calls.calendar, 0); assert.equal(good.calls.histories.length, 3);
  assert.notEqual(first.contentHash, second.contentHash); assert.notEqual(first.candidatePath, second.candidatePath);
  assert.equal(await fs.readFile(path.join(root, first.candidatePath), "utf8"), firstBytes);
});

test("all source failures preserve safe diagnostics and cannot fabricate a candidate", async (t) => {
  const root = await sandbox(t), provider = providerFixture();
  provider.getHistory = async (code) => { provider.calls.histories.push(code); throw new Error("private credential body MUST_NOT_LEAK"); };
  const result = await run(root, provider);
  assert.equal(result.status, "FAILED"); assert.equal(result.reason, "NO_VALID_MODEL_INPUTS");
  assert.equal(result.candidatePath, null); assert.equal(result.failedCount, 3); assert.equal(result.collectedCount, 0);
  assert.ok(result.failures.every(({ reason }) => reason === "KIS_EOD_UNCLASSIFIED_FAILURE"));
  assert.ok(!JSON.stringify(await read(root, result.rawPath)).includes("MUST_NOT_LEAK"));
});

test("IPO short history remains legitimate per-model ineligibility, without price synthesis", async (t) => {
  const root = await sandbox(t), provider = providerFixture({ count: 34 }), result = await run(root, provider);
  assert.equal(result.status, "VALIDATED"); assert.equal(result.collectionComplete, true);
  assert.equal(result.rankingCounts["C-v1"], 3); assert.equal(result.rankingCounts["A-v1"], 0); assert.equal(result.rankingCounts["B-v1"], 0);
  const candidate = await read(root, result.candidatePath);
  assert.ok(candidate.records.every((record) => record.exclusionReasons["B-v1"] === "insufficientHistory" && record.scores["B-v1"] === null));
});

test("collection crossing the KST date boundary is rejected before creating raw/candidate artifacts", async (t) => {
  const root = await sandbox(t), provider = providerFixture({ stamp: "2026-10-08T14:59:50Z" });
  let current = "2026-10-08T14:59:50Z";
  const original = provider.getHistory;
  provider.getHistory = async (...args) => { const value = await original(...args); current = "2026-10-08T15:00:01Z"; return value; };
  const result = await run(root, provider, { now: () => current });
  assert.equal(result.status, "FAILED"); assert.equal(result.reason, "REFERENCE_DATE_CHANGED");
  await assert.rejects(fs.access(path.join(root, ".runtime/kis-eod/candidates")), { code: "ENOENT" });
  await assert.rejects(fs.access(path.join(root, ".runtime/kis-eod/raw")), { code: "ENOENT" });
});

test("UTC/KST year boundary is selected from actual KST day, never a CLI-supplied historical date", async (t) => {
  const root = await sandbox(t), instant = "2026-12-31T15:01:00Z";
  assert.deepEqual(getKisEodLocalClock(instant), { referenceDate: "2027-01-01", time: "00:01:00", weekend: false });
  const result = await run(root, providerFixture(), { collectPrivate: false, now: instant });
  assert.equal(result.referenceDate, "2027-01-01"); assert.equal(result.clockReady, false);
});

test("publication is explicitly blocked even when manual private collection is authorized", async (t) => {
  const root = await sandbox(t), provider = providerFixture(), result = await run(root, provider, { publish: true });
  assert.equal(result.status, "BLOCKED"); assert.equal(result.reason, "PUBLICATION_POLICY_UNAPPROVED");
  assert.deepEqual(result.blockers, ["sourceFinalityUnverified", "derivedPublicationRightsUnapproved", "automationUnapproved"]);
  assert.equal(provider.calls.calendar, 0); assert.deepEqual(provider.calls.histories, []);
});

test("baseline formula mismatch fails before any source call", async (t) => {
  const root = await sandbox(t), provider = providerFixture(), inputs = fixtureInputs();
  inputs.expectedFormulaHashes = { ...formulaHashes, "B-v1": "f".repeat(64) };
  const result = await run(root, provider, { loadInputs: async () => inputs });
  assert.equal(result.status, "FAILED"); assert.equal(result.reason, "INPUT_VALIDATION_FAILED"); assert.equal(provider.calls.calendar, 0);
});

test("malformed cached calendar cannot create a false trading day", async (t) => {
  const root = await sandbox(t), provider = providerFixture();
  await fs.mkdir(path.join(root, ".runtime/kis-eod/calendar"), { recursive: true });
  await fs.writeFile(path.join(root, `.runtime/kis-eod/calendar/${referenceDate}.json`), JSON.stringify({ source: "KIS", operation: "chk-holiday", referenceDate, isTradingDay: true, receivedAt: now, sourceFields: { bass_dt: "20261008", opnd_yn: "N", tr_day_yn: "N" } }));
  const result = await run(root, provider);
  assert.equal(result.status, "FAILED"); assert.equal(result.reason, "CALENDAR_REQUEST_FAILED");
  assert.equal(provider.calls.calendar, 0); assert.deepEqual(provider.calls.histories, []);
});

test("calendar cache requires the exact new-year KST date, not a previous year or UTC day", async (t) => {
  const root = await sandbox(t), date = "2027-01-01", instant = "2027-01-01T07:00:00Z";
  const provider = providerFixture({ date, stamp: instant });
  await fs.mkdir(path.join(root, ".runtime/kis-eod/calendar"), { recursive: true });
  await fs.writeFile(path.join(root, `.runtime/kis-eod/calendar/${date}.json`), JSON.stringify({ source: "KIS", operation: "chk-holiday", referenceDate: date, isTradingDay: true, receivedAt: instant, sourceFields: { bass_dt: "20261231", opnd_yn: "Y", tr_day_yn: "Y" } }));
  const result = await run(root, provider, { now: instant });
  assert.equal(result.referenceDate, date); assert.equal(result.reason, "CALENDAR_REQUEST_FAILED");
  assert.equal(provider.calls.calendar, 0); assert.deepEqual(provider.calls.histories, []);
});

test("input read errors expose only fixed safe input codes; status/reason enum is explicit", async (t) => {
  const root = await sandbox(t);
  const safe = await run(root, null, { loadInputs: async () => { throw new Error("KIS_EOD_BASELINE_FORMULA_CHANGED"); } });
  assert.equal(safe.inputFailure, "KIS_EOD_BASELINE_FORMULA_CHANGED");
  const unsafe = await run(root, null, { loadInputs: async () => { throw new Error("secret https://example.invalid/?token=MUST_NOT_LOG"); } });
  assert.equal(unsafe.inputFailure, "KIS_EOD_INPUT_READ_FAILED"); assert.ok(!JSON.stringify(unsafe).includes("MUST_NOT_LOG"));
  assert.ok(KIS_EOD_RUNNER_STATUSES.includes(unsafe.status)); assert.ok(KIS_EOD_RUNNER_REASONS.includes(unsafe.reason));
});
