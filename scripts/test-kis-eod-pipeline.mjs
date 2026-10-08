import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { calculateEligibleSnapshotModels } from "../lib/model-score-engine.mjs";
import { sha256Canonical } from "../lib/snapshot-quality-pipeline.mjs";
import { buildKisEodCandidate, canPublishKisEodCandidate, KIS_EOD_MODEL_VERSIONS, markKisEodPublished, toPublicKisEodProjection, validateKisEodCandidate, validatePublicKisEodProjection, writeImmutableKisEodCandidate } from "../lib/kis-eod-pipeline.mjs";

const date = "2026-10-08";
const now = "2026-10-08T07:00:00Z";
const hashes = Object.fromEntries(KIS_EOD_MODEL_VERSIONS.map((version) => [version, sha256Canonical(version)]));
function history(count = 260) {
  const rows = []; const day = new Date(`${date}T00:00:00Z`);
  while (rows.length < count) {
    if (![0, 6].includes(day.getUTCDay())) {
      const close = 2000 - rows.length;
      rows.push({ basDt: day.toISOString().slice(0, 10).replaceAll("-", ""), mkp: close - 4, hipr: close + 8, lopr: close - 8, clpr: close, trqu: 10000 + rows.length, trPrc: close * (10000 + rows.length), fltRt: 1 / (close - 1) * 100 });
    }
    day.setUTCDate(day.getUTCDate() - 1);
  }
  return rows;
}
function fixture(count = 2) {
  const universeRecords = Array.from({ length: count }, (_, index) => ({ code: String(index + 1).padStart(6, "0"), name: `합성 종목 ${index + 1}`, market: index % 2 ? "KOSDAQ" : "KOSPI" }));
  return { referenceDate: date, now, expectedUniverseCount: count, universeRecords, historiesByCode: new Map(universeRecords.map(({ code }) => [code, history()])), officialSnapshot: { asOfDate: "2026-10-07", records: universeRecords.map(({ code }) => ({ code, qualityEligibility: { eligible: true, status: "eligible", exclusions: [] } })), sourceManifest: { modelFormulaHashes: hashes } }, formulaHashes: hashes,
    adjustmentPolicy: "unadjusted", sourceMetadataByCode: new Map(universeRecords.map(({ code }) => [code, { adjustment: "unadjusted", marketDivision: "J", priceBasis: "KIS_UNADJUSTED_DAILY_CLOSE", receivedAt: "2026-10-08T06:45:00Z", symbolMapping: { status: "VERIFIED_RESPONSE_TICKER", requestedCode: code, responseCode: code } }])), collectionStartedAt: "2026-10-08T06:40:00Z", collectionCompletedAt: "2026-10-08T06:50:00Z", observationType: "TEST_FIXTURE",
    calendarEvidence: { source: "KIS", operation: "chk-holiday", referenceDate: date, isTradingDay: true, receivedAt: "2026-10-08T06:35:00Z" } };
}
function approved(input) {
  return { ...input, observationType: "LIVE_COLLECTION", sourceFinalityEvidence: { status: "VERIFIED", contractReference: "https://example.invalid/synthetic-finality-contract", documentHash: sha256Canonical("synthetic verified contract"), referenceDate: date, observedAt: "2026-10-08T06:45:00Z", operation: "inquire-daily-itemchartprice" }, publicationApproval: { rights: true, rightsReference: "https://example.invalid/synthetic-derived-rights", automation: true } };
}

test("553 synthetic observations preserve baseline scores, native ranking, and official isolation", () => {
  const input = fixture(553);
  const candidate = buildKisEodCandidate(input);
  assert.equal(candidate.status, "VALIDATED");
  assert.equal(candidate.records.length, 553);
  assert.deepEqual(validateKisEodCandidate(candidate), []);
  const eligibility = Object.fromEntries(KIS_EOD_MODEL_VERSIONS.map((version) => [version, true]));
  const models = calculateEligibleSnapshotModels(history(), eligibility);
  assert.deepEqual(candidate.records[0].scores, { "A-v1": models.modelA.finalTechnicalScore, "A-v2": models.modelAV2.finalScore, "B-v1": models.modelB.trendStrength, "C-v1": models.modelC.entryStrength, "D-v1": models.modelD });
  assert.equal(candidate.records[0].rawScores["A-v2"], models.modelAV2.rawScore);
  for (const version of KIS_EOD_MODEL_VERSIONS) assert.equal(candidate.rankingUniverse[version].count, 553);
  assert.equal(candidate.eligibleForOfficialRanking, false);
  assert.equal(candidate.eligibleForBacktest, false);
  assert.equal(candidate.eligibleForOptimization, false);
  assert.equal(candidate.outcomesNamespace, null);
  assert.ok(!Object.hasOwn(candidate, "futureReturns"));
  assert.equal(canPublishKisEodCandidate(candidate).eligible, false);
});

test("partial failures and official quarantine remain excluded without batch failure", () => {
  const input = fixture(4);
  input.historiesByCode.delete("000002");
  input.historiesByCode.set("000003", history(34));
  input.officialSnapshot.records[3].qualityEligibility = { eligible: false, status: "quarantined", exclusions: [{ reason: "postNonTradingPriceDiscontinuity" }] };
  const candidate = buildKisEodCandidate(input);
  assert.equal(candidate.status, "VALIDATED");
  assert.equal(candidate.quality.isPartialRanking, true);
  assert.equal(candidate.rankingUniverse["C-v1"].count, 2);
  for (const version of ["A-v1", "A-v2", "B-v1", "D-v1"]) assert.equal(candidate.rankingUniverse[version].count, 1);
  assert.equal(candidate.records[1].exclusionReasons["B-v1"], "historyMissing");
  assert.equal(candidate.records[2].exclusionReasons["B-v1"], "insufficientHistory");
  assert.equal(candidate.records[3].exclusionReasons["C-v1"], "officialQuarantinePreserved");
  assert.deepEqual(validateKisEodCandidate(candidate), []);
});

test("daily rate is explicitly derived, never missing-to-zero", () => {
  const input = fixture(1);
  const rows = input.historiesByCode.get("000001"); delete rows[0].fltRt;
  let candidate = buildKisEodCandidate(input);
  assert.equal(candidate.records[0].provenance.dailyChangeRateBasis, "CURRENT_CLOSE_OVER_PREVIOUS_HISTORY_CLOSE");
  const directRows = structuredClone(rows); directRows[0].fltRt = (rows[0].clpr / rows[1].clpr - 1) * 100;
  const direct = calculateEligibleSnapshotModels(directRows, Object.fromEntries(KIS_EOD_MODEL_VERSIONS.map((version) => [version, true])));
  assert.equal(candidate.records[0].scores["C-v1"], direct.modelC.entryStrength);
  rows[0].prdy_vrss = -20;
  candidate = buildKisEodCandidate(input);
  assert.equal(candidate.records[0].provenance.dailyChangeRateBasis, "KIS_SIGNED_PRDY_VRSS_OVER_PREVIOUS_HISTORY_CLOSE");
  input.historiesByCode.set("000001", [rows[0]]);
  candidate = buildKisEodCandidate(input);
  assert.equal(candidate.records[0].exclusionReasons["C-v1"], "insufficientHistory");
  assert.equal(candidate.records[0].provenance.dailyChangeRateBasis, "MISSING_PREVIOUS_CLOSE");
  assert.ok(Object.values(candidate.records[0].scores).every((value) => value === null));
});

test("invalid OHLCV, trade value, duplicates, future rows and stale rows fail per symbol", () => {
  const mutations = [
    [(rows) => { rows[0].hipr = rows[0].clpr - 1; }, "invalidOhlcRelationship"],
    [(rows) => { rows[0].trqu = null; }, "invalidVolume"],
    [(rows) => { rows[0].trPrc = null; }, "invalidTradingValue"],
    [(rows) => { rows[1].basDt = rows[0].basDt; }, "duplicateDates"],
    [(rows) => { rows[1].basDt = "20261009"; }, "invalidOrFutureDate"],
    [(rows) => { rows[0].basDt = "20261007"; }, "latestDateMismatch"],
    [(rows) => { rows[1] = null; }, "invalidOrFutureDate"],
  ];
  for (const [mutate, reason] of mutations) {
    const input = fixture(); mutate(input.historiesByCode.get("000001"));
    const candidate = buildKisEodCandidate(input);
    assert.equal(candidate.status, "VALIDATED");
    assert.equal(candidate.records[0].exclusionReasons["C-v1"], reason);
    assert.equal(candidate.records[1].dataStatus, "VALIDATED");
    assert.ok(Object.values(candidate.records[0].scores).every((value) => value === null));
  }
});

test("halt/no trade is not substituted with fabricated executable prices", () => {
  const input = fixture(); const row = input.historiesByCode.get("000001")[0];
  Object.assign(row, { mkp: 0, hipr: 0, lopr: 0, trqu: 0, trPrc: 0, clpr: input.historiesByCode.get("000001")[1].clpr });
  const candidate = buildKisEodCandidate(input);
  assert.equal(candidate.records[0].exclusionReasons["C-v1"], "tradingHaltOrNoTrade");
  assert.equal(candidate.records[0].scores["C-v1"], null);
});

test("before close, holiday, weekend, unknown calendar and future date stay pending", () => {
  for (const mutate of [
    (input) => { input.now = "2026-10-08T06:29:59Z"; input.collectionStartedAt = "2026-10-08T06:00:00Z"; input.collectionCompletedAt = "2026-10-08T06:20:00Z"; input.calendarEvidence.receivedAt = "2026-10-08T06:00:00Z"; },
    (input) => { input.calendarEvidence.isTradingDay = false; },
    (input) => { input.calendarEvidence = null; },
    (input) => { input.referenceDate = "2026-10-09"; },
    (input) => { input.now = "2026-10-10T07:00:00Z"; input.referenceDate = "2026-10-10"; input.calendarEvidence.referenceDate = input.referenceDate; input.collectionStartedAt = "2026-10-10T06:40:00Z"; input.collectionCompletedAt = "2026-10-10T06:50:00Z"; },
  ]) {
    const input = fixture(); mutate(input); const candidate = buildKisEodCandidate(input);
    assert.equal(candidate.status, "PENDING");
    assert.ok(candidate.records.every((record) => Object.values(record.scores).every((value) => value === null)));
    assert.equal(canPublishKisEodCandidate(candidate).eligible, false);
  }
});

test("formula mismatch, wrong Universe count or mixed adjustment cannot silently pass", () => {
  const input = fixture();
  input.formulaHashes = { ...hashes, "B-v1": sha256Canonical("changed formula") };
  const failed = buildKisEodCandidate(input);
  assert.equal(failed.status, "FAILED");
  assert.ok(failed.quality.structuralErrors.includes("formulaHashMismatch:B-v1"));
  assert.equal(buildKisEodCandidate({ ...fixture(), expectedUniverseCount: 553 }).status, "FAILED");
  assert.equal(buildKisEodCandidate({ ...fixture(), adjustmentPolicy: "unknown" }).status, "FAILED");
  const currentHead = { ...hashes, "B-v1": sha256Canonical("synthetic alternate historical hash scope") };
  const scoped = buildKisEodCandidate({ ...fixture(), formulaHashes: currentHead, expectedFormulaHashes: currentHead, formulaHashScope: "currentHEADFormulaSourceFilesLfNormalized" });
  assert.equal(scoped.status, "VALIDATED");
  assert.equal(scoped.source.formulaHashScope, "currentHEADFormulaSourceFilesLfNormalized");
  assert.deepEqual(scoped.source.officialModelFormulaHashes, hashes);
  assert.equal(buildKisEodCandidate({ ...fixture(), formulaHashScope: "ignoreMismatches" }).status, "FAILED");
  const mixed = fixture(); mixed.sourceMetadataByCode = new Map([["000001", { adjustment: "adjusted", marketDivision: "J" }]]);
  const result = buildKisEodCandidate(mixed);
  assert.equal(result.records[0].exclusionReasons["C-v1"], "adjustmentMismatch");
  assert.equal(result.records[1].dataStatus, "VALIDATED");
});

test("COLLECTED differs from model VALIDATED and does not imply finality", () => {
  const candidate = buildKisEodCandidate({ ...fixture(), calculateModels: false });
  assert.equal(candidate.status, "COLLECTED");
  assert.ok(candidate.records.every((record) => Object.values(record.scores).every((value) => value === null)));
  assert.equal(canPublishKisEodCandidate(candidate).eligible, false);
});

test("live private validation is blocked without finality, rights and automation approval", () => {
  const candidate = buildKisEodCandidate({ ...fixture(), observationType: "LIVE_COLLECTION" });
  assert.equal(candidate.status, "VALIDATED");
  assert.deepEqual(canPublishKisEodCandidate(candidate).reasons, ["sourceFinalityUnverified", "derivedPublicationRightsUnapproved", "automationUnapproved"]);
  assert.throws(() => toPublicKisEodProjection(candidate), /PUBLICATION_BLOCKED/u);
  assert.throws(() => markKisEodPublished(candidate, now), /PUBLICATION_BLOCKED/u);
  for (const evidence of ["VERIFIED", "FINAL", { status: "VERIFIED" }, { status: "VERIFIED", contractReference: "https://example.invalid/contract?secret=not-real" }]) {
    const forged = buildKisEodCandidate({ ...approved(fixture()), sourceFinalityEvidence: evidence });
    assert.equal(canPublishKisEodCandidate(forged).eligible, false);
  }
  for (const observationType of ["TEST_FIXTURE", "DRY_RUN"]) assert.ok(canPublishKisEodCandidate(buildKisEodCandidate({ ...approved(fixture()), observationType })).reasons.includes("nonLiveObservation"));
  for (const rightsReference of ["https://user:credential@example.invalid/rights", "https://example.invalid/rights?token=synthetic", "not-a-reference"]) {
    const input = approved(fixture()); input.publicationApproval.rightsReference = rightsReference;
    const candidate = buildKisEodCandidate(input);
    assert.equal(candidate.publicationApproval.rightsReference, null);
    assert.ok(canPublishKisEodCandidate(candidate).reasons.includes("derivedPublicationRightsUnapproved"));
  }
});

test("live provenance requires actual collection metadata and excludes future receipts", () => {
  const missing = fixture(); missing.observationType = "LIVE_COLLECTION"; missing.sourceMetadataByCode.delete("000001");
  const candidate = buildKisEodCandidate(missing);
  assert.equal(candidate.records[0].exclusionReasons["C-v1"], "sourceMetadataMissing");
  assert.equal(candidate.records[1].dataStatus, "VALIDATED");
  const future = fixture(); future.observationType = "LIVE_COLLECTION"; future.sourceMetadataByCode.get("000001").receivedAt = "2026-10-08T07:10:00Z";
  assert.equal(buildKisEodCandidate(future).records[0].exclusionReasons["C-v1"], "sourceReceiptOutsideCollection");
  assert.equal(buildKisEodCandidate({ ...fixture(), observationType: "LIVE_COLLECTION", officialSnapshot: null, expectedFormulaHashes: hashes }).status, "FAILED");
});

test("approved synthetic publisher projection excludes all raw OHLCV and prices", () => {
  const candidate = buildKisEodCandidate(approved(fixture()));
  assert.equal(canPublishKisEodCandidate(candidate).eligible, true);
  assert.throws(() => toPublicKisEodProjection(candidate), /publishedPointerRequired/u);
  const published = markKisEodPublished(candidate, now);
  assert.equal(published.status, "PUBLISHED");
  assert.equal(published.contentHash, candidate.contentHash);
  const projection = toPublicKisEodProjection(published);
  assert.deepEqual(validatePublicKisEodProjection(projection), []);
  for (const forbidden of ["clpr", "mkp", "hipr", "lopr", "trqu", "trPrc", "closePrice", "volume", "rows", "headers", "token", "sourceMetadataByCode"]) assert.ok(!JSON.stringify(projection).includes(`"${forbidden}"`), forbidden);
  assert.ok(projection.records[0].scores["B-v1"] !== null);
  assert.equal(projection.eligibleForBacktest, false);
  assert.deepEqual(projection.publicationCollection, { status: "VERIFIED_ALL_NON_QUARANTINED", requiredCount: 2, verifiedCount: 2 });
});

test("a partial collection cannot publish even when finality and rights are approved", () => {
  for (const mutate of [
    (input) => { input.historiesByCode.delete("000002"); },
    (input) => { input.historiesByCode.get("000002")[0].basDt = "20261007"; },
    (input) => { input.historiesByCode.get("000002")[0].trPrc = null; },
    (input) => { input.historiesByCode.get("000002")[0].hipr = 1; },
    (input) => { input.sourceMetadataByCode.get("000002").symbolMapping.status = "UNVERIFIED_RESPONSE_TICKER_ABSENT"; },
    (input) => { input.sourceMetadataByCode.get("000002").symbolMapping.responseCode = "000003"; },
    (input) => { input.sourceMetadataByCode.get("000002").symbolMapping.requestedCode = "000003"; },
    (input) => { input.sourceMetadataByCode.delete("000002"); },
  ]) {
    const input = approved(fixture()); mutate(input);
    const candidate = buildKisEodCandidate(input);
    assert.equal(candidate.status, "VALIDATED");
    assert.ok(canPublishKisEodCandidate(candidate).reasons.includes("incompleteCollection"));
    assert.throws(() => markKisEodPublished(candidate, now), /incompleteCollection/u);
  }
});

test("complete collected new listings, halt and preserved quarantine remain safely excluded", () => {
  const input = approved(fixture(4));
  const shortRows = history(1); delete shortRows[0].fltRt;
  input.historiesByCode.set("000002", shortRows);
  const haltRows = input.historiesByCode.get("000003");
  Object.assign(haltRows[0], { mkp: 0, hipr: 0, lopr: 0, trqu: 0, trPrc: 0, clpr: haltRows[1].clpr });
  input.officialSnapshot.records[3].qualityEligibility = { status: "quarantined", exclusions: [{ reason: "existingOfficialQualityIssue" }] };
  input.historiesByCode.delete("000004"); input.sourceMetadataByCode.delete("000004");
  const candidate = buildKisEodCandidate(input);
  assert.equal(canPublishKisEodCandidate(candidate).eligible, true);
  for (const version of KIS_EOD_MODEL_VERSIONS) {
    assert.equal(candidate.records[1].exclusionReasons[version], "insufficientHistory");
    assert.equal(candidate.records[2].exclusionReasons[version], "tradingHaltOrNoTrade");
    assert.equal(candidate.records[3].exclusionReasons[version], "officialQuarantinePreserved");
  }
  assert.ok(Object.values(candidate.records[1].scores).every((score) => score === null));
  const projection = toPublicKisEodProjection(markKisEodPublished(candidate, now));
  assert.deepEqual(validatePublicKisEodProjection(projection), []);
  assert.deepEqual(projection.publicationCollection, { status: "VERIFIED_ALL_NON_QUARANTINED", requiredCount: 3, verifiedCount: 3 });
});

test("independent public hash and exact whitelists reject raw data even with a resigned hash", () => {
  const projection = toPublicKisEodProjection(markKisEodPublished(buildKisEodCandidate(approved(fixture())), now));
  const mutations = [
    (value) => { value.rows = [{ close: 2000 }]; },
    (value) => { value.records[0].closePrice = 2000; },
    (value) => { value.records[0].scores["B-v1"] = null; },
    (value) => { value.records[0].ranks["B-v1"] = 9; },
    (value) => { value.coverage.analyzable = 0; },
    (value) => { value.publicationCollection.verifiedCount = 1; },
    (value) => { value.publicationCollection.status = "INCOMPLETE"; },
    (value) => { value.observationType = "TEST_FIXTURE"; },
    (value) => { value.eligibleForBacktest = true; },
    (value) => { value.publicationApproval.rights = false; },
    (value) => { value.sourceFinalityEvidence.referenceDate = "2026-10-09"; },
    (value) => { value.sourceFinalityEvidence.observedAt = "2026-10-08T07:10:00Z"; },
    (value) => { value.sourceFinalityEvidence.rawResponse = "never public"; },
    (value) => { value.publishedAt = "2026-10-08T06:00:00Z"; },
  ];
  for (const mutate of mutations) {
    const value = structuredClone(projection); mutate(value);
    value.publicProjectionHash = sha256Canonical(Object.fromEntries(Object.entries(value).filter(([key]) => key !== "publicProjectionHash")));
    assert.ok(validatePublicKisEodProjection(value).length > 0);
  }
  const corrupt = structuredClone(projection); corrupt.publicProjectionHash = "0".repeat(64);
  assert.ok(validatePublicKisEodProjection(corrupt).includes("publicProjectionHash"));
  const futureProof = approved(fixture()); futureProof.sourceFinalityEvidence.observedAt = "2026-10-08T07:10:00Z";
  assert.ok(canPublishKisEodCandidate(buildKisEodCandidate(futureProof)).reasons.includes("sourceFinalityUnverified"));
});

test("immutable input hash ignores receipt timestamps but not changed prices or rank data", () => {
  const first = buildKisEodCandidate(fixture());
  const again = fixture(); again.calendarEvidence.receivedAt = "2026-10-08T06:36:00Z"; again.collectionStartedAt = "2026-10-08T06:41:00Z"; again.collectionCompletedAt = "2026-10-08T06:51:00Z";
  assert.equal(buildKisEodCandidate(again).contentHash, first.contentHash);
  const changed = fixture(); changed.historiesByCode.get("000001")[0].clpr += 1;
  assert.notEqual(buildKisEodCandidate(changed).contentHash, first.contentHash);
  const tampered = structuredClone(first); tampered.records[0].scores["B-v1"] = 0;
  assert.ok(validateKisEodCandidate(tampered).includes("contentHash"));
});

test("immutable wx write is idempotent, conflicting/failing attempts preserve last good", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "tight-budget-kis-eod-test-"));
  try {
    const privateDirectory = path.join(directory, "candidates");
    const candidate = buildKisEodCandidate(fixture());
    const first = await writeImmutableKisEodCandidate({ directory: privateDirectory, candidate });
    const original = await fs.readFile(first.path, "utf8");
    assert.equal(first.action, "create");
    assert.equal((await writeImmutableKisEodCandidate({ directory: privateDirectory, candidate })).action, "idempotent");
    const changed = fixture(); changed.historiesByCode.get("000001")[0].clpr += 1;
    await assert.rejects(writeImmutableKisEodCandidate({ directory: privateDirectory, candidate: buildKisEodCandidate(changed) }), /IMMUTABLE_CONFLICT/u);
    await assert.rejects(writeImmutableKisEodCandidate({ directory: privateDirectory, candidate: buildKisEodCandidate({ ...fixture(), adjustmentPolicy: "unknown" }) }), /NOT_PERSISTABLE/u);
    assert.equal(await fs.readFile(first.path, "utf8"), original);
    const partial = approved(fixture()); partial.historiesByCode.delete("000002");
    assert.throws(() => markKisEodPublished(buildKisEodCandidate(partial), now), /incompleteCollection/u);
    assert.equal(await fs.readFile(first.path, "utf8"), original);
    await assert.rejects(writeImmutableKisEodCandidate({ directory: path.join(directory, "history"), candidate }), /OFFICIAL_NAMESPACE_FORBIDDEN/u);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
