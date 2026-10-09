import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { sha256Canonical } from "../lib/snapshot-quality-pipeline.mjs";
import { intradaySeedHash } from "../lib/intraday-market-seed.mjs";
import { KIS_EOD_OBSERVATION_TICKERS } from "../lib/kis-eod-observation.mjs";
import { compareKisEodObservationWithOfficial, kisEodObservationComparisonHash, toSafeKisEodObservationComparisonSummary } from "../lib/kis-eod-observation-comparison.mjs";
import { runKisEodObservationComparison, parseKisEodObservationComparisonArgs, writeImmutableKisEodObservationComparison } from "./compare-kis-eod-observations.mjs";

const referenceDate = "2026-10-08", comparedAt = "2026-10-09T06:40:00.000Z";
const sourceRow = (ticker) => ({ basDt: "20261008", srtnCd: ticker, mkp: 95, hipr: 110, lopr: 90, clpr: 100, trqu: 1000, trPrc: 100000, fltRt: null, observationStatus: "trading" });
const seal = (body) => ({ ...body, artifactHash: sha256Canonical(body) });
function observation({ slot = "15:40", failedTicker = null } = {}) {
  const observations = KIS_EOD_OBSERVATION_TICKERS.map((ticker) => {
    if (ticker === failedTicker) return { ticker, status: "FAILED", reason: "KIS_EOD_RATE_LIMITED" };
    const rows = [sourceRow(ticker)], metadata = { ticker, referenceDate, adjustment: "unadjusted", priceBasis: "kisDailyBarUnadjusted" };
    const adjustmentMetadata = [], dailyChangeMetadata = [];
    return { ticker, status: "SUCCESS", rows, metadata, adjustmentMetadata, dailyChangeMetadata,
      metadataHash: sha256Canonical(metadata), dataHash: sha256Canonical({ rows, adjustmentMetadata, dailyChangeMetadata }) };
  });
  return seal({ schemaVersion: 1, namespace: "kis-eod-private-slot-observation", referenceDate, slot, status: failedTicker ? "PARTIAL" : "OBSERVED",
    sourceFinality: "NOT_CONFIRMED", publicationEligible: false, productionChanged: false, observationType: "ACTUAL_CLOCK_SLOT_COLLECTION",
    completedAt: "2026-10-08T06:42:00.000Z", observations });
}
function official({ adjustment = "unadjusted", missingTicker = null } = {}) {
  return { source: "data-go-kr-official-daily-price", operation: "getStockPriceInfo", referenceDate, adjustment,
    records: KIS_EOD_OBSERVATION_TICKERS.filter((ticker) => ticker !== missingTicker).map((code) => ({ code, rows: [sourceRow(code)] })) };
}
const compare = (source = official(), sourceObservation = observation()) => compareKisEodObservationWithOfficial({ observation: sourceObservation, official: source, comparedAt });
async function sandbox(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "kis-eod-comparison-test-"));
  t.after(async () => {
    assert.ok(path.resolve(root).startsWith(`${path.resolve(os.tmpdir())}${path.sep}kis-eod-comparison-test-`));
    await fs.rm(root, { recursive: true, force: true });
  });
  return root;
}
async function savedArtifact(root, artifact = observation()) {
  const directory = path.join(root, ".runtime", "kis-eod", "observations", artifact.referenceDate, artifact.slot.replace(":", ""));
  await fs.mkdir(directory, { recursive: true });
  const target = path.join(directory, `2026-10-08T06-40-00.000Z-${artifact.artifactHash}.json`);
  await fs.writeFile(target, JSON.stringify(artifact)); return target;
}
async function savedOfficial(root, source = official()) {
  const directory = path.join(root, ".runtime", "kis-eod", "official-comparison-inputs");
  await fs.mkdir(directory, { recursive: true });
  const target = path.join(directory, "official.json");
  await fs.writeFile(target, JSON.stringify(source)); return target;
}

test("exact official date/ticker compares OHLCV/value without changing original inputs or claiming finality", () => {
  const input = observation(), source = official(), before = JSON.stringify({ input, source }), report = compare(source, input);
  assert.equal(report.status, "COMPARED"); assert.equal(report.summary.comparedCount, 3); assert.equal(report.summary.allAvailableFieldsEqualCount, 3);
  assert.equal(report.summary.adjustmentBasisVerifiedCount, 3);
  for (const record of report.records) {
    assert.equal(record.pairCount, 6); assert.deepEqual(record.changedFields, []);
    for (const field of Object.values(record.fields)) { assert.equal(field.status, "EQUAL"); assert.equal(field.difference, 0); }
    assert.equal(record.sourceFinality, "NOT_CONFIRMED_BY_COMPARISON");
  }
  assert.equal(JSON.stringify({ input, source }), before); assert.equal(report.publicationEligible, false); assert.equal(report.productionChanged, false);
});

test("official unavailable remains pending; missing prices are not zero or a comparison success", () => {
  const report = compare(null);
  assert.equal(report.status, "PENDING"); assert.equal(report.summary.comparedCount, 0); assert.equal(report.summary.pendingCount, 3);
  assert.equal(report.officialEvidenceHash, null);
  assert.equal(report.records[0].fields.clpr.officialValue, null); assert.equal(report.records[0].fields.clpr.difference, null);
});

test("exact-date source missing one ticker or partial observation keeps missing separate", () => {
  const report = compare(official({ missingTicker: "000660" }), observation({ failedTicker: "064290" }));
  assert.equal(report.summary.comparedCount, 1); assert.equal(report.summary.pendingCount, 2); assert.equal(report.summary.observedCount, 2);
  assert.equal(report.records[1].fields.clpr.status, "OFFICIAL_ROW_MISSING");
  assert.equal(report.records[2].fields.clpr.status, "OBSERVATION_UNAVAILABLE");
});

test("numeric deltas and possible cause categories do not silently fix or attribute differences", () => {
  const source = official(); source.records[0].rows[0].clpr = 99; source.records[0].rows[0].trqu = 900; source.records[0].rows[0].trPrc = 90000;
  const report = compare(source), record = report.records[0];
  assert.equal(record.fields.clpr.difference, 1); assert.equal(record.fields.trqu.difference, 100); assert.equal(record.fields.trPrc.difference, 10000);
  assert.deepEqual(record.changedFields, ["clpr", "trqu", "trPrc"]); assert.equal(record.causeConfirmed, false);
  assert.deepEqual(record.possibleCauseCategories, ["PRICE_DIFFERENCE", "VOLUME_DIFFERENCE", "TRADING_VALUE_DIFFERENCE", "UPDATE_TIMING_OR_SESSION_SCOPE_REQUIRES_REVIEW"]);
});

test("unknown and different adjustment basis are explicit even when raw values match", () => {
  const unknown = compare(official({ adjustment: null })); assert.equal(unknown.summary.adjustmentBasisVerifiedCount, 0);
  assert.equal(unknown.records[0].adjustmentBasis.status, "UNVERIFIED"); assert.ok(unknown.records[0].possibleCauseCategories.includes("ADJUSTMENT_BASIS_UNVERIFIED"));
  const adjusted = compare(official({ adjustment: "adjusted" })); assert.equal(adjusted.records[0].adjustmentBasis.status, "DIFFERENT");
  assert.ok(adjusted.records[0].possibleCauseCategories.includes("ADJUSTMENT_BASIS_DIFFERS"));
});

test("existing official market-seed format reuses hash validation and flags missing trading value/basis", () => {
  const rows = [];
  for (let day = 0; day < 260; day += 1) {
    const date = new Date(`${referenceDate}T00:00:00Z`); date.setUTCDate(date.getUTCDate() - day);
    rows.push([date.toISOString().slice(0, 10).replaceAll("-", ""), 95, 110, 90, 100, 1000]);
  }
  const body = { schemaVersion: 1, seedType: "intradayMarketAnalysisSeed", requestedDate: referenceDate, rowOrder: "descending",
    tupleFields: ["date", "open", "high", "low", "close", "volume"], sourceManifest: { sources: { officialDailyPrice: { service: "getStockPriceInfo" } } },
    records: [...KIS_EOD_OBSERVATION_TICKERS].sort().map((code) => ({ code, eligible: true, rows })) };
  const seed = { ...body, contentHash: intradaySeedHash(body) }, report = compare(seed);
  assert.equal(report.summary.comparedCount, 3); assert.equal(report.records[0].pairCount, 5);
  assert.equal(report.records[0].fields.trPrc.status, "OFFICIAL_FIELD_MISSING"); assert.equal(report.records[0].adjustmentBasis.status, "UNVERIFIED");
  seed.records[0].rows[0][1] = 94; assert.throws(() => compare(seed), /OFFICIAL_INVALID/u);
});

test("wrong source/date/ticker, duplicate rows and malformed numbers are rejected", () => {
  for (const [change, reason] of [
    [(source) => { source.referenceDate = "2026-10-07"; }, "OFFICIAL_DATE_MISMATCH"],
    [(source) => { source.source = "KIS"; }, "OFFICIAL_SOURCE_UNVERIFIED"],
    [(source) => { source.records[0].rows[0].srtnCd = "000660"; }, "OFFICIAL_TICKER_MISMATCH"],
    [(source) => { source.records[0].rows.push(source.records[0].rows[0]); }, "OFFICIAL_DUPLICATE_DATE"],
    [(source) => { source.records[0].rows[0].clpr = "100"; }, "OFFICIAL_NUMBER_INVALID"],
    [(source) => { source.records[0].rows[0].hipr = 5; }, "OFFICIAL_OHLCV_INVALID"],
  ]) { const source = official(); change(source); assert.throws(() => compare(source), new RegExp(reason, "u")); }
});

test("altered observation artifact/data/metadata proofs and future comparison time violations fail", () => {
  const original = observation(); original.observations[0].rows[0].clpr = 101; assert.throws(() => compare(official(), original), /OBSERVATION_INVALID/u);
  const changedBody = observation(); delete changedBody.artifactHash; changedBody.observations[0].dataHash = "0".repeat(64);
  assert.throws(() => compare(official(), seal(changedBody)), /OBSERVATION_INVALID/u);
  assert.throws(() => compareKisEodObservationWithOfficial({ observation: observation(), comparedAt: "2026-10-08T06:30:00.000Z" }), /TIMESTAMP_INVALID/u);
  const futureOfficial = official(); futureOfficial.receivedAt = "2026-10-10T06:40:00.000Z";
  assert.throws(() => compare(futureOfficial), /OFFICIAL_TIMESTAMP_INVALID/u);
});

test("deterministic report identity excludes repeat invocation time; safe logs contain no source values", () => {
  const first = compare(), second = compareKisEodObservationWithOfficial({ observation: observation(), official: official(), comparedAt: "2026-10-10T06:40:00.000Z" });
  assert.equal(first.comparisonHash, second.comparisonHash); assert.equal(first.comparisonHash, kisEodObservationComparisonHash(first));
  const safe = JSON.stringify(toSafeKisEodObservationComparisonSummary(first));
  for (const forbidden of ["kisValue", "officialValue", "fields", "100000", "secret", "token"]) assert.ok(!safe.includes(forbidden));
});

test("private tool preserves observations, writes pending then later comparison as distinct immutable evidence", async (t) => {
  const root = await sandbox(t), originalPath = await savedArtifact(root), original = await fs.readFile(originalPath, "utf8");
  const pending = await runKisEodObservationComparison({ root, referenceDate, slot: "15:40", now: () => comparedAt });
  assert.equal(pending[0].status, "PENDING"); assert.equal(pending[0].storageAction, "CREATED");
  const officialPath = await savedOfficial(root);
  const resolved = await runKisEodObservationComparison({ root, referenceDate, slot: "15:40", officialPath, now: () => comparedAt });
  assert.equal(resolved[0].status, "COMPARED"); assert.notEqual(pending[0].comparisonHash, resolved[0].comparisonHash);
  const repeated = await runKisEodObservationComparison({ root, referenceDate, slot: "15:40", officialPath, now: () => "2026-10-10T06:40:00.000Z" });
  assert.equal(repeated[0].storageAction, "IDEMPOTENT");
  assert.equal(await fs.readFile(originalPath, "utf8"), original);
  const reports = await fs.readdir(path.join(root, ".runtime", "kis-eod", "observation-comparisons", referenceDate, "1540"));
  assert.equal(reports.length, 2); assert.ok(reports.every((name) => /^[a-f0-9]{64}[.]json$/u.test(name)));
});

test("all slots are handled separately and absent real observation is never invented", async (t) => {
  const root = await sandbox(t); await savedArtifact(root); await savedArtifact(root, observation({ slot: "16:10" }));
  const results = await runKisEodObservationComparison({ root, referenceDate, now: () => comparedAt });
  assert.equal(results.length, 3); assert.equal(results[2].reason, "OBSERVATION_NOT_FOUND");
  assert.equal(results[0].slot, "15:40"); assert.equal(results[1].slot, "16:10");
  await assert.rejects(fs.access(path.join(root, ".runtime", "kis-eod", "observations", referenceDate, "1640")), { code: "ENOENT" });
});

test("corrupt existing comparison is preserved and rejected rather than overwritten", async (t) => {
  const root = await sandbox(t), report = compare(); await writeImmutableKisEodObservationComparison({ root, report });
  const target = path.join(root, ".runtime", "kis-eod", "observation-comparisons", referenceDate, "1540", `${report.comparisonHash}.json`);
  const corrupted = { ...report, sourceFinality: "CORRUPT" }; await fs.writeFile(target, JSON.stringify(corrupted));
  await assert.rejects(writeImmutableKisEodObservationComparison({ root, report }), /IMMUTABLE_CONFLICT/u);
  assert.equal(await fs.readFile(target, "utf8"), JSON.stringify(corrupted));
});

test("durable persistence uploads the actual saved report and preserves the original timestamp on idempotent retry", async (t) => {
  const root = await sandbox(t); await savedArtifact(root); const officialPath = await savedOfficial(root), uploaded = [];
  const durableStore = { async persistComparison(report) { uploaded.push(structuredClone(report)); } };
  const first = await runKisEodObservationComparison({ root, referenceDate, slot: "15:40", officialPath, now: () => comparedAt, durableStore });
  const second = await runKisEodObservationComparison({ root, referenceDate, slot: "15:40", officialPath, now: () => "2026-10-10T06:40:00.000Z", durableStore });
  assert.equal(first[0].durablePersisted, true); assert.equal(second[0].storageAction, "IDEMPOTENT");
  assert.equal(uploaded.length, 2); assert.equal(uploaded[0].comparedAt, comparedAt); assert.equal(uploaded[1].comparedAt, comparedAt);
  assert.deepEqual(uploaded[1], uploaded[0]);
});

test("private remote storage failure never erases local comparison or original observation and can be retried", async (t) => {
  const root = await sandbox(t), originalPath = await savedArtifact(root), original = await fs.readFile(originalPath, "utf8"), officialPath = await savedOfficial(root);
  const options = { root, referenceDate, slot: "15:40", officialPath, now: () => comparedAt };
  await assert.rejects(runKisEodObservationComparison({ ...options, durableStore: { async persistComparison() { throw new Error("PRIVATE_REMOTE_UNAVAILABLE"); } } }), /PRIVATE_REMOTE_UNAVAILABLE/u);
  assert.equal(await fs.readFile(originalPath, "utf8"), original);
  const directory = path.join(root, ".runtime", "kis-eod", "observation-comparisons", referenceDate, "1540"), files = await fs.readdir(directory);
  assert.equal(files.length, 1);
  const local = await fs.readFile(path.join(directory, files[0]), "utf8");
  let uploaded;
  const result = await runKisEodObservationComparison({ ...options, now: () => "2026-10-10T06:40:00.000Z", durableStore: { async persistComparison(report) { uploaded = report; } } });
  assert.equal(result[0].storageAction, "IDEMPOTENT"); assert.deepEqual(uploaded, JSON.parse(local));
  assert.equal(await fs.readFile(originalPath, "utf8"), original);
  await assert.rejects(runKisEodObservationComparison({ ...options, durableStore: {} }), /DURABLE_STORE_INVALID/u);
});

test("path escape, symlink namespace redirection and arbitrary official source files are blocked", async (t) => {
  const root = await sandbox(t), outside = await sandbox(t);
  await assert.rejects(runKisEodObservationComparison({ root, referenceDate, officialPath: path.join(outside, "secret.json") }), /OFFICIAL_PATH_FORBIDDEN/u);
  await fs.symlink(outside, path.join(root, ".runtime"), "junction");
  await assert.rejects(runKisEodObservationComparison({ root, referenceDate }), /SYMLINK_REJECTED/u);
  assert.deepEqual(await fs.readdir(outside), []);
});

test("CLI arguments are bounded and output only safe status while keeping raw comparisons private", async (t) => {
  assert.deepEqual(parseKisEodObservationComparisonArgs([`--date=${referenceDate}`, "--slot=15:40"]), { referenceDate, slot: "15:40", officialPath: null });
  for (const args of [["--date=2026-02-30"], [`--date=${referenceDate}`, "--slot=17:00"], [`--date=${referenceDate}`, "--force"], [`--date=${referenceDate}`, `--date=${referenceDate}`]]) assert.equal(parseKisEodObservationComparisonArgs(args), null);
  const root = await sandbox(t); await savedArtifact(root); const officialPath = await savedOfficial(root);
  const script = path.resolve("scripts", "compare-kis-eod-observations.mjs");
  const result = spawnSync(process.execPath, [script, `--date=${referenceDate}`, "--slot=15:40", `--official-file=${officialPath}`], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0); assert.match(result.stdout, /"status":"COMPARED"/u);
  assert.ok(!result.stdout.includes("kisValue")); assert.ok(!result.stdout.includes("100000")); assert.equal(result.stderr, "");
});
