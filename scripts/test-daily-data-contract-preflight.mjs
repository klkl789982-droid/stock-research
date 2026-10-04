import assert from "node:assert/strict";
import { assertPreflightAllowsModelCalculation, assertPreflightPromotionReady, createDailyDataContractPreflight } from "../lib/daily-data-contract-preflight.mjs";
import { validateMarketDataQuality } from "../lib/market-data-quality-validator.mjs";
import { calculateEligibleSnapshotModels } from "../lib/model-score-engine.mjs";

const requestedDate = "2026-09-30";
const universe = { generatedAt: "2026-09-30T00:00:00.000Z", stocks: [{ code: "000001" }, { code: "000002" }] };
const policy = { universeFilterVersion: "v1", pointInTimeMasterCertified: true };
const collectedAt = "2026-10-01T06:00:00.000Z";
const requestContract = { operation: "getStockPriceInfo", numOfRows: 260 };
function date(index) { const value = new Date("2026-09-30T00:00:00.000Z"); value.setUTCDate(value.getUTCDate() - index); return value.toISOString().slice(0, 10).replaceAll("-", ""); }
function rows(count = 260) { return Array.from({ length: count }, (_, index) => ({ basDt: date(index), mkp: 100, hipr: 110, lopr: 90, clpr: 100, trqu: 100, trPrc: 1000, mrktTotAmt: 1_000_000 })); }
function check(histories, options = {}) {
  const currentUniverse = options.universe ?? universe;
  const currentPolicy = options.policy ?? policy;
  const quality = validateMarketDataQuality({ requestedDate, universeRecords: currentUniverse.stocks, historyByCode: histories, requirements: { expectedUniverseCount: currentUniverse.stocks.length, sourceManifestPresent: true, pointInTimeMasterCertified: currentPolicy.pointInTimeMasterCertified, universeFilterVersion: currentPolicy.universeFilterVersion, universeGeneratedAt: currentUniverse.generatedAt } });
  return createDailyDataContractPreflight({ requestedDate, universe: currentUniverse, universeProvenance: options.universeProvenance ?? null, historyByCode: histories, quality, policy: currentPolicy, sourceCollectedAt: "sourceCollectedAt" in options ? options.sourceCollectedAt : collectedAt, requestContract: "requestContract" in options ? options.requestContract : requestContract });
}
const normal = new Map([["000001", rows()], ["000002", rows()]]);
const pass = check(normal);
function candidate(preflight) { return { asOfDate: requestedDate, sourceManifest: { dataContractPreflight: preflight, universe: { artifact: preflight.universe.artifact }, sources: { officialDailyPrice: { normalizedInputHash: preflight.source.normalizedInputHash } } }, universeSummary: { originalUniverse: { codesHash: preflight.universe.codesHash }, quarantinedUniverse: { count: preflight.coverage.quarantined } } }; }
assert.equal(pass.status, "PASS");
assert.equal(pass.coverage.valid, 2);
assert.equal(pass.source.freshness.exactDateCount, 2);
assert.equal(check(normal).contentHash, pass.contentHash);
assert.doesNotThrow(() => assertPreflightAllowsModelCalculation(pass));
assert.doesNotThrow(() => assertPreflightPromotionReady(candidate(pass)));
const selectedArtifact = { referenceDate: requestedDate, artifactPath: `data/universe-history/${requestedDate}.json`, effectiveAt: "2026-09-30T05:00:00.000Z", count: 2, codesHash: pass.universe.codesHash, verificationStatus: "VERIFIED", selectionReason: "EXACT_DATE_VERIFIED_ARCHIVE" };
const selectedPass = check(normal, { universeProvenance: selectedArtifact, policy: { ...policy, pointInTimeMasterCertified: false } });
assert.equal(selectedPass.status, "PASS");
assert.equal(selectedPass.universe.artifact.artifactPath, selectedArtifact.artifactPath);
assert.doesNotThrow(() => assertPreflightPromotionReady(candidate(selectedPass)));
const selectedLegacy = check(normal, { universeProvenance: { ...selectedArtifact, verificationStatus: "UNVERIFIED", effectiveAt: null } });
assert.equal(selectedLegacy.status, "UNVERIFIED");
assert.equal(selectedLegacy.universe.pointInTimeStatus, "UNVERIFIED");

const missing = check(new Map([["000001", rows()]]));
assert.equal(missing.status, "FAIL");
assert.deepEqual(missing.coverage.categories.missing.codes, ["000002"]);
assert.throws(() => assertPreflightAllowsModelCalculation(missing), /DATA_CONTRACT_PREFLIGHT_FAILED/);
assert.throws(() => assertPreflightPromotionReady(candidate(missing)), /DATA_CONTRACT_PREFLIGHT_NOT_APPROVED/);
assert.throws(() => assertPreflightPromotionReady({ ...candidate(pass), sourceManifest: {} }), /DATA_CONTRACT_PREFLIGHT_NOT_APPROVED/);

const duplicateUniverse = check(normal, { universe: { ...universe, stocks: [{ code: "000001" }, { code: "000001" }] } });
assert.equal(duplicateUniverse.status, "FAIL");
assert.deepEqual(duplicateUniverse.coverage.categories.duplicateCode.codes, ["000001"]);
const invalidCode = check(normal, { universe: { ...universe, stocks: [{ code: "INVALID" }, { code: "000002" }] } });
assert.equal(invalidCode.status, "FAIL");
assert.deepEqual(invalidCode.coverage.categories.invalidCode.codes, ["INVALID"]);
const duplicateDateRows = rows(); duplicateDateRows[1].basDt = duplicateDateRows[0].basDt;
assert.deepEqual(check(new Map([["000001", duplicateDateRows], ["000002", rows()]])).coverage.categories.duplicateDate.codes, ["000001"]);

const staleRows = rows(); staleRows.shift();
const stale = check(new Map([["000001", staleRows], ["000002", rows()]]));
assert.equal(stale.status, "FAIL");
assert.deepEqual(stale.coverage.categories.stale.codes, ["000001"]);
const futureRows = rows(); futureRows.unshift({ ...futureRows[0], basDt: "20261001" });
const future = check(new Map([["000001", futureRows], ["000002", rows()]]));
assert.equal(future.status, "FAIL");
assert.deepEqual(future.coverage.categories.future.codes, ["000001"]);

const badRows = rows(); badRows[0].hipr = 80;
const invalid = check(new Map([["000001", badRows], ["000002", rows()]]));
assert.equal(invalid.status, "FAIL");
assert.deepEqual(invalid.coverage.categories.invalidOhlcv.codes, ["000001"]);
const negativeVolumeRows = rows(); negativeVolumeRows[0].trqu = -1;
assert.deepEqual(check(new Map([["000001", negativeVolumeRows], ["000002", rows()]])).coverage.categories.invalidOhlcv.codes, ["000001"]);
const shortHistory = check(new Map([["000001", rows(100)], ["000002", rows()]]));
assert.equal(shortHistory.status, "PASS");
assert.deepEqual(shortHistory.coverage.categories.insufficientHistory.codes, ["000001"]);
assert.equal(shortHistory.coverage.rankingEligibleByModel["A-v1"].count, 1);
assert.equal(shortHistory.coverage.rankingEligibleByModel["C-v1"].count, 2);

const quarantinedRows = rows();
quarantinedRows[0].clpr = 101;
quarantinedRows[1] = { ...quarantinedRows[1], mkp: 0, hipr: 0, lopr: 0, trqu: 0 };
const partial = check(new Map([["000001", quarantinedRows], ["000002", rows()]]));
assert.equal(partial.status, "PASS_WITH_QUARANTINE");
assert.equal(partial.coverage.valid, 1);
assert.deepEqual(partial.quarantine.codes, ["000001"]);
assert.deepEqual(partial.coverage.categories.zeroVolume.codes, ["000001"]);
assert.equal(partial.coverage.rankingEligibleByModel["A-v1"].count, 1);
assert.doesNotThrow(() => assertPreflightAllowsModelCalculation(partial));
assert.doesNotThrow(() => assertPreflightPromotionReady(candidate(partial)));

const unverified = check(normal, { policy: { ...policy, pointInTimeMasterCertified: false } });
assert.equal(unverified.status, "UNVERIFIED");
assert.deepEqual(unverified.verification.reasons, ["pointInTimeMasterNotCertified"]);
assert.equal(unverified.productionAction, "PROCEED_WITH_EXISTING_QUALITY_POLICY");
assert.doesNotThrow(() => assertPreflightPromotionReady(candidate(unverified)));
const missingProvenance = check(normal, { requestContract: null });
assert.equal(missingProvenance.status, "UNVERIFIED");
assert(missingProvenance.verification.reasons.includes("requestProvenanceIncomplete"));
assert.throws(() => assertPreflightPromotionReady({ ...candidate(pass), asOfDate: "2026-09-29" }), /DATA_CONTRACT_PREFLIGHT_MISMATCH/);

const baseline = calculateEligibleSnapshotModels(rows(), { "A-v1": true, "A-v2": true, "B-v1": true, "C-v1": true, "D-v1": true });
assert(Object.values(baseline).some((value) => value !== null));
console.log("PASS daily data contract preflight: normal, missing, duplicate, stale/future, invalid OHLCV, quarantine, unverified, gate, model baseline");
