import { sha256Canonical } from "./snapshot-quality-pipeline.mjs";

export const DAILY_RUN_STATUS = Object.freeze({
  NO_NEW_OFFICIAL_EOD: "NO_NEW_OFFICIAL_EOD",
  FAILED: "FAILED",
  CANDIDATE_VALIDATED: "CANDIDATE_VALIDATED",
  PROMOTED: "PROMOTED",
  REVISION_REQUIRES_APPROVAL: "REVISION_REQUIRES_APPROVAL",
});

export const DAILY_MODEL_VERSIONS = ["A-v1", "A-v2", "B-v1", "C-v1", "D-v1"];

const modelValue = (record, version) => {
  if (version === "A-v1") return { score: record.scoresByVersion?.[version] ?? record.scores?.modelA ?? null, rank: record.ranksByVersion?.[version] ?? record.ranks?.modelA ?? null, rankingUniverseSize: record.rankingUniverseCount?.modelA ?? null };
  if (version === "A-v2") return { score: record.scoresByVersion?.[version] ?? null, rank: record.ranksByVersion?.[version] ?? null, rankingUniverseSize: record.rankingUniverseCountByVersion?.[version] ?? null };
  const key = { "B-v1": "modelB", "C-v1": "modelC", "D-v1": "modelD" }[version];
  return { score: record.scores?.[key] ?? null, rank: record.ranks?.[key] ?? null, rankingUniverseSize: record.rankingUniverseCount?.[key] ?? null };
};

export function createCompactModelHistory(snapshot) {
  const sourceSnapshotHash = snapshot.contentHash ?? sha256Canonical(snapshot);
  const exclusionsByCodeVersion = new Map((snapshot.excludedFromScoring ?? []).map((item) => [`${item.code}:${item.modelVersion}`, item.reason]));
  const records = [...snapshot.records].sort((a, b) => a.code.localeCompare(b.code)).map((record) => ({
    ticker: record.code,
    name: record.name,
    market: record.market,
    eligibility: {
      eligible: record.qualityEligibility?.eligible ?? true,
      status: record.qualityEligibility?.status ?? "eligible",
      exclusions: (record.qualityEligibility?.exclusions ?? []).map(({ reason, issueDate, disposition }) => ({ reason, issueDate: issueDate ?? null, disposition: disposition ?? null })),
    },
    sourceSnapshotHash,
    models: Object.fromEntries(DAILY_MODEL_VERSIONS.map((version) => {
      const value = modelValue(record, version);
      const reason = value.score == null ? exclusionsByCodeVersion.get(`${record.code}:${version}`) ?? record.qualityEligibility?.exclusions?.[0]?.reason ?? "notEligible" : null;
      return [version, { modelVersion: version, ...value, eligible: value.score != null && Number.isInteger(value.rank), exclusionReason: reason }];
    })),
  }));
  const base = {
    schemaVersion: 1,
    dataset: "compact-model-history",
    referenceDate: snapshot.asOfDate,
    sourceSnapshotHash,
    modelDefinitions: snapshot.modelDefinitions,
    modelVersionDefinitions: snapshot.modelVersionDefinitions,
    championChallenger: snapshot.championChallenger,
    universeSummary: snapshot.universeSummary,
    provenance: { sourceManifest: snapshot.sourceManifest, sourceAvailabilityStatus: snapshot.sourceAvailabilityStatus, signalAvailableAt: snapshot.signalAvailableAt },
    records,
  };
  return { ...base, contentHash: sha256Canonical(base) };
}

export function validateCompactModelHistory(value, expectedCount) {
  const errors = [];
  if (value?.schemaVersion !== 1 || value?.dataset !== "compact-model-history") errors.push("schema");
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value?.referenceDate ?? "")) errors.push("referenceDate");
  if (!Array.isArray(value?.records) || value.records.length !== expectedCount) errors.push("recordsCount");
  if (new Set(value?.records?.map((record) => record.ticker)).size !== expectedCount) errors.push("uniqueTicker");
  for (const record of value?.records ?? []) {
    if (DAILY_MODEL_VERSIONS.some((version) => !record.models?.[version])) errors.push(`${record.ticker}:models`);
    if (record.eligibility?.status === "quarantined" && DAILY_MODEL_VERSIONS.some((version) => record.models[version].score !== null || record.models[version].rank !== null)) errors.push(`${record.ticker}:quarantineValues`);
  }
  const { contentHash, ...base } = value ?? {};
  if (contentHash !== sha256Canonical(base)) errors.push("contentHash");
  return [...new Set(errors)];
}

export function classifySameDate(existing, candidate) {
  if (!existing) return "create";
  return existing.sourceSnapshotHash === candidate.sourceSnapshotHash && existing.contentHash === candidate.contentHash ? "idempotent" : "revisionRequired";
}

export function evaluatePromotionCandidate({ collectionCompleted, snapshotValidationErrors = [], structuralFatalCount, requiredArtifactsPresent, compactValidationErrors = [] }) {
  const reasons = [];
  if (!collectionCompleted) reasons.push("collectionIncomplete");
  if (!requiredArtifactsPresent) reasons.push("requiredArtifactsMissing");
  if (snapshotValidationErrors.length) reasons.push("snapshotValidationFailed");
  if (structuralFatalCount !== 0) reasons.push("structuralFatal");
  if (compactValidationErrors.length) reasons.push("compactHistoryValidationFailed");
  return { eligible: reasons.length === 0, reasons };
}

export function createDailyRunManifest(input) {
  const base = {
    schemaVersion: 1,
    referenceDate: input.referenceDate ?? null,
    runId: input.runId,
    status: input.status,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    source: input.source ?? { provider: "공공데이터포털", operation: "getStockPriceInfo" },
    provenance: input.provenance ?? null,
    sourceGitSha: input.sourceGitSha ?? null,
    promotionGitSha: null,
    promotionCommitBasis: "manifestContainedInPromotionCommit",
    previousProductionReferenceDate: input.previousProductionReferenceDate ?? null,
    snapshotHash: input.snapshotHash ?? null,
    universeHash: input.universeHash ?? null,
    priceLedgerHash: input.priceLedgerHash ?? null,
    originalCount: input.originalCount ?? null,
    eligibleCount: input.eligibleCount ?? null,
    quarantineCount: input.quarantineCount ?? null,
    rankingUniverseSizeByModel: input.rankingUniverseSizeByModel ?? {},
    issueManifestHash: input.issueManifestHash ?? null,
    compactHistoryHash: input.compactHistoryHash ?? null,
    promoted: input.status === DAILY_RUN_STATUS.PROMOTED,
    promotedAt: input.promotedAt ?? null,
    reason: input.reason ?? null,
  };
  return { ...base, contentHash: sha256Canonical(base) };
}

export function markManifestPromoted(manifest, promotedAt) {
  return createDailyRunManifest({ ...manifest, status: DAILY_RUN_STATUS.PROMOTED, promotedAt });
}

export function isAllowedPromotionPath(file, referenceDate, runId) {
  const exact = new Set([
    `data/history/${referenceDate}.json`, `data/market-prices/${referenceDate}.json`, `data/universe-history/${referenceDate}.json`,
    `data/analysis/market/${referenceDate}.json`, `data/analysis/market-seeds/${referenceDate}.json`, `data/model-history/${referenceDate}.json`,
    `data/daily-runs/${referenceDate}/${runId}.json`, "data/trading-calendar/status.json",
  ]);
  if (exact.has(file)) return true;
  return /^data\/history\/\d{4}-\d{2}-\d{2}\.json$/u.test(file);
}

export function assertPromotionFiles(files, referenceDate, runId) {
  const forbidden = files.filter((file) => !isAllowedPromotionPath(file, referenceDate, runId) || /(?:^|\/)(?:\.env|.*(?:secret|token|\.tmp|\.lock|\.bak))/iu.test(file));
  if (forbidden.length) throw new Error(`승격 allowlist 밖의 파일이 있습니다: ${forbidden.join(", ")}`);
  return [...new Set(files)].sort();
}
