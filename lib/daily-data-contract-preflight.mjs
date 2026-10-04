import { normalizeStockCode } from "./stock-code.mjs";
import { isQuarantinableMarketDataIssue } from "./market-data-quality-validator.mjs";
import { normalizeHistoryForHash, sha256Canonical } from "./snapshot-quality-pipeline.mjs";

export const DATA_CONTRACT_PREFLIGHT_VERSION = 1;

export function assertPreflightAllowsModelCalculation(preflight) {
  if (preflight?.status === "FAIL") throw new Error(`DATA_CONTRACT_PREFLIGHT_FAILED structuralFatal=${preflight.structuralFatalCount} hash=${preflight.contentHash}`);
}

export function assertPreflightPromotionReady(snapshot) {
  const preflight = snapshot?.sourceManifest?.dataContractPreflight;
  if (!preflight || preflight.status === "FAIL" || !["PASS", "PASS_WITH_QUARANTINE", "UNVERIFIED"].includes(preflight.status)) throw new Error("DATA_CONTRACT_PREFLIGHT_NOT_APPROVED");
  if (preflight.referenceDate !== snapshot.asOfDate
    || preflight.universe.codesHash !== snapshot.universeSummary?.originalUniverse?.codesHash
    || preflight.universe.artifact?.codesHash !== snapshot.sourceManifest.universe?.artifact?.codesHash
    || preflight.universe.artifact?.artifactPath !== snapshot.sourceManifest.universe?.artifact?.artifactPath
    || preflight.source.normalizedInputHash !== snapshot.sourceManifest.sources.officialDailyPrice.normalizedInputHash
    || preflight.coverage.quarantined !== snapshot.universeSummary?.quarantinedUniverse?.count) throw new Error("DATA_CONTRACT_PREFLIGHT_MISMATCH");
  const { contentHash, ...base } = preflight;
  if (contentHash !== sha256Canonical(base)) throw new Error("DATA_CONTRACT_PREFLIGHT_HASH_MISMATCH");
}

const sorted = (values) => [...new Set(values.filter(Boolean))].sort();
const codesFor = (issues, type) => sorted(issues.filter((entry) => entry.type === type).flatMap((entry) => entry.codes ?? [entry.code]));
const ohlcvIssueTypes = new Set(["invalidVolume", "invalidClose", "zeroVolumePriceChanged", "zeroVolumeWithExecutableOhlc", "invalidPrice", "invalidOhlcRelationship"]);

export function createDailyDataContractPreflight({ requestedDate, universe, universeProvenance = null, historyByCode, quality, policy, sourceCollectedAt, requestContract }) {
  const stocks = universe?.stocks ?? [];
  const issues = quality?.issues ?? [];
  const allCodes = sorted(stocks.map((stock) => normalizeStockCode(stock.code)));
  const quarantinedCodes = sorted(issues.filter(isQuarantinableMarketDataIssue).map((entry) => entry.code));
  const structuralIssues = issues.filter((entry) => entry.severity === "fatal" && !isQuarantinableMarketDataIssue(entry));
  const categories = {
    missing: codesFor(issues, "missingHistoryCodes"),
    duplicateCode: sorted([...codesFor(issues, "duplicateUniverseCodes"), ...codesFor(issues, "duplicateHistoryCodes")]),
    invalidCode: sorted([...codesFor(issues, "invalidUniverseCodes"), ...codesFor(issues, "invalidHistoryCodes")]),
    duplicateDate: codesFor(issues, "duplicateDates"),
    stale: codesFor(issues, "latestDateMismatch"),
    future: codesFor(issues, "futureDate"),
    invalidOhlcv: sorted(issues.filter((entry) => entry.code && ohlcvIssueTypes.has(entry.type)).map((entry) => entry.code)),
    zeroVolume: codesFor(issues, "nonTradingObservation"),
    insufficientHistory: sorted(Object.values(quality?.modelEligibility ?? {}).flatMap((item) => item.ineligibleCodes.filter((code) => item.reasons[code] === "insufficientHistory"))),
  };
  const categoryCounts = Object.fromEntries(Object.entries(categories).map(([key, codes]) => [key, codes.length]));
  const verificationReasons = [];
  if (universeProvenance ? universeProvenance.verificationStatus !== "VERIFIED" : policy?.pointInTimeMasterCertified !== true) verificationReasons.push("pointInTimeMasterNotCertified");
  if (universeProvenance && (universeProvenance.referenceDate !== requestedDate || universeProvenance.count !== stocks.length || universeProvenance.codesHash !== sha256Canonical(allCodes))) verificationReasons.push("universeArtifactMismatch");
  if (!universe?.generatedAt || !policy?.universeFilterVersion) verificationReasons.push("universeProvenanceIncomplete");
  if (!sourceCollectedAt || !requestContract) verificationReasons.push("requestProvenanceIncomplete");
  const status = structuralIssues.length || verificationReasons.includes("universeArtifactMismatch") ? "FAIL" : quarantinedCodes.length ? "PASS_WITH_QUARANTINE" : verificationReasons.length ? "UNVERIFIED" : "PASS";
  const rankingEligibleByModel = Object.fromEntries(Object.entries(quality?.modelEligibility ?? {}).map(([version, item]) => [version, { count: item.eligibleCodes.length, codesHash: sha256Canonical(sorted(item.eligibleCodes)) }]));
  const result = {
    version: DATA_CONTRACT_PREFLIGHT_VERSION,
    status,
    referenceDate: requestedDate,
    universe: { count: stocks.length, codesHash: sha256Canonical(allCodes), generatedAt: universe?.generatedAt ?? null, filterVersion: policy?.universeFilterVersion ?? null, pointInTimeStatus: universeProvenance?.verificationStatus ?? (policy?.pointInTimeMasterCertified === true ? "VERIFIED" : "UNVERIFIED"), artifact: universeProvenance },
    source: {
      provider: "공공데이터포털", operation: "getStockPriceInfo", requestedDate,
      collectedAt: sourceCollectedAt ?? null, requestContractHash: requestContract ? sha256Canonical(requestContract) : null,
      normalizedInputHash: sha256Canonical(normalizeHistoryForHash(historyByCode)),
      minimumObservedBasDt: sorted(Object.values(quality?.perSymbol ?? {}).map((item) => item.latestBasDt)).at(0) ?? null,
      maximumObservedBasDt: sorted(Object.values(quality?.perSymbol ?? {}).map((item) => item.latestBasDt)).at(-1) ?? null,
      availability: sourceCollectedAt ? "OBSERVED_AT_COLLECTION" : "UNVERIFIED",
      freshness: { exactDateCount: quality?.summary?.exactDateMatches ?? 0, staleCount: categoryCounts.stale, futureCount: categoryCounts.future },
    },
    coverage: {
      valid: allCodes.filter((code) => quality?.perSymbol?.[code] && !quality.perSymbol[code].issues.some((entry) => entry.severity === "fatal")).length,
      quarantined: quarantinedCodes.length,
      rankingEligibleByModel,
      categories: Object.fromEntries(Object.entries(categories).map(([key, codes]) => [key, { count: codes.length, codes }])),
      categoryCounts,
    },
    quarantine: { codes: quarantinedCodes, issues: issues.filter(isQuarantinableMarketDataIssue).map((entry) => ({ code: entry.code, type: entry.type, date: entry.date ?? null, disposition: entry.disposition })).sort((a, b) => a.code.localeCompare(b.code) || String(a.date).localeCompare(String(b.date))) },
    structuralFatalCount: structuralIssues.length,
    verification: { status: verificationReasons.length ? "UNVERIFIED" : "VERIFIED", reasons: verificationReasons },
    productionAction: status === "FAIL" ? "BLOCK" : "PROCEED_WITH_EXISTING_QUALITY_POLICY",
  };
  return { ...result, contentHash: sha256Canonical(result) };
}
