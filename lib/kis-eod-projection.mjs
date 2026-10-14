// Pure projection validation shared by the collector and the read-only HTTP store.
import { MODEL_HISTORY_REQUIREMENTS } from "./market-data-quality-validator.mjs";
import { normalizeStockCode } from "./stock-code.mjs";
import { sha256Canonical } from "./snapshot-quality-pipeline.mjs";

export const KIS_EOD_MODEL_VERSIONS = Object.freeze(["A-v1", "A-v2", "B-v1", "C-v1", "D-v1"]);
export const hashPattern = /^[a-f0-9]{64}$/u;
export const datePattern = /^\d{4}-\d{2}-\d{2}$/u;
export const safeReference = (value) => {
  if (typeof value !== "string" || /[\s?#]/u.test(value)) return false;
  try { const url = new URL(value); return url.protocol === "https:" && Boolean(url.hostname) && !url.username && !url.password; }
  catch { return false; }
};
export const stamp = (value) => typeof value === "string" && Number.isFinite(Date.parse(value));
export const publicationExclusions = new Set(["officialQuarantinePreserved", "insufficientHistory", "tradingHaltOrNoTrade"]);

export function isOfficialQuarantine(record) {
  return KIS_EOD_MODEL_VERSIONS.every((version) => record?.exclusionReasons?.[version] === "officialQuarantinePreserved");
}

function exactKeys(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key));
}

export function verifiedFinality(evidence, referenceDate, collectionCompletedAt) {
  const fields = ["status", "contractReference", "documentHash", "referenceDate", "observedAt", "operation"];
  return exactKeys(evidence, fields) && evidence.status === "VERIFIED" && safeReference(evidence.contractReference)
    && hashPattern.test(evidence.documentHash ?? "") && evidence.referenceDate === referenceDate
    && stamp(evidence.observedAt) && stamp(collectionCompletedAt)
    && Date.parse(evidence.observedAt) <= Date.parse(collectionCompletedAt)
    && Date.parse(evidence.observedAt) >= Date.parse(`${referenceDate}T15:30:00+09:00`)
    && evidence.operation === "inquire-daily-itemchartprice";
}

export function validatePublicKisEodProjection(projection) {
  const errors = [];
  const fields = ["schemaVersion", "artifactType", "observationType", "dataMode", "referenceDate", "source", "qualityGrade", "sourceFinality", "contentHash", "publishedAt", "collectionCompletedAt", "publicationApproval", "sourceFinalityEvidence", "publicationCollection", "eligibleForOfficialRanking", "eligibleForBacktest", "eligibleForOptimization", "modelFormulaHashes", "modelFormulaHashScope", "rankingUniverse", "coverage", "records", "publicProjectionHash"];
  if (!exactKeys(projection, fields)) errors.push("projectionFields");
  if (projection?.schemaVersion !== 1 || projection?.artifactType !== "KisEodScoreProjection" || projection?.observationType !== "LIVE_COLLECTION" || projection?.dataMode !== "kisProvisionalEod" || projection?.source !== "KIS" || projection?.qualityGrade !== "PROVISIONAL") errors.push("projectionSchema");
  if (!datePattern.test(projection?.referenceDate ?? "") || !hashPattern.test(projection?.contentHash ?? "")) errors.push("dateOrContentHash");
  if (!stamp(projection?.collectionCompletedAt) || !stamp(projection?.publishedAt) || Date.parse(projection.publishedAt) < Date.parse(projection.collectionCompletedAt)) errors.push("publicationTimestamp");
  if (projection?.sourceFinality !== "VERIFIED_BY_SEPARATE_CONTRACT_NOT_OFFICIAL_DATA_PORTAL" || !verifiedFinality(projection?.sourceFinalityEvidence, projection?.referenceDate, projection?.collectionCompletedAt)) errors.push("sourceFinalityUnverified");
  if (!exactKeys(projection?.publicationApproval, ["rights", "rightsReference", "automation"]) || projection?.publicationApproval?.rights !== true || projection?.publicationApproval?.automation !== true || !safeReference(projection?.publicationApproval?.rightsReference)) errors.push("publicationUnapproved");
  if (projection?.eligibleForOfficialRanking !== false || projection?.eligibleForBacktest !== false || projection?.eligibleForOptimization !== false) errors.push("officialIsolation");
  if (!exactKeys(projection?.modelFormulaHashes, KIS_EOD_MODEL_VERSIONS) || KIS_EOD_MODEL_VERSIONS.some((version) => !hashPattern.test(projection?.modelFormulaHashes?.[version] ?? ""))) errors.push("formulaHashes");
  if (!["officialSnapshotFormulaSourceHashes", "currentHEADFormulaSourceFilesLfNormalized"].includes(projection?.modelFormulaHashScope)) errors.push("formulaHashScope");
  if (!Array.isArray(projection?.records) || !projection.records.length || new Set(projection.records.map((record) => record?.ticker)).size !== projection.records.length) errors.push("records");
  const records = Array.isArray(projection?.records) ? projection.records : [];
  for (const record of records) {
    if (!exactKeys(record, ["ticker", "companyName", "market", "scores", "ranks", "exclusionReasons"]) || !normalizeStockCode(record?.ticker) || typeof record?.companyName !== "string" || !["KOSPI", "KOSDAQ"].includes(record?.market)) errors.push("recordFields");
    for (const group of ["scores", "ranks", "exclusionReasons"]) if (!exactKeys(record?.[group], KIS_EOD_MODEL_VERSIONS)) errors.push(`recordModels:${group}`);
  }
  if (!exactKeys(projection?.rankingUniverse, KIS_EOD_MODEL_VERSIONS)) errors.push("rankingUniverse");
  for (const version of KIS_EOD_MODEL_VERSIONS) {
    const ranked = records.filter((record) => Number.isInteger(record?.ranks?.[version]));
    const ranks = ranked.map((record) => record.ranks[version]).sort((a, b) => a - b);
    const universe = projection?.rankingUniverse?.[version];
    if (!exactKeys(universe, ["count", "codesHash", "historyRequirement", "tieBreak"]) || universe.count !== ranked.length || universe.codesHash !== sha256Canonical(ranked.map((record) => record.ticker).sort()) || universe.historyRequirement !== MODEL_HISTORY_REQUIREMENTS[version] || ranks.some((rank, index) => rank !== index + 1)) errors.push(`ranking:${version}`);
    for (const record of records) {
      const score = record?.scores?.[version]; const rank = record?.ranks?.[version]; const reason = record?.exclusionReasons?.[version];
      if (score !== null && !Number.isFinite(score)) errors.push(`score:${version}`);
      if ((Number.isFinite(score) && Number.isInteger(rank)) !== (reason === null) || (score === null && (rank !== null || typeof reason !== "string"))) errors.push(`eligibility:${version}`);
      if (reason !== null && !publicationExclusions.has(reason)) errors.push("incompleteCollection");
    }
  }
  const analyzable = records.filter((record) => Object.values(record?.scores ?? {}).some(Number.isFinite)).length;
  if (!exactKeys(projection?.coverage, ["total", "analyzable", "excluded"]) || projection.coverage.total !== records.length || projection.coverage.analyzable !== analyzable || projection.coverage.excluded !== records.length - analyzable) errors.push("coverage");
  const requiredCount = records.filter((record) => !isOfficialQuarantine(record)).length;
  if (!exactKeys(projection?.publicationCollection, ["status", "requiredCount", "verifiedCount"]) || projection?.publicationCollection?.status !== "VERIFIED_ALL_NON_QUARANTINED" || projection?.publicationCollection?.requiredCount !== requiredCount || projection?.publicationCollection?.verifiedCount !== requiredCount) errors.push("incompleteCollection");
  const publicBody = Object.fromEntries(Object.entries(projection ?? {}).filter(([key]) => key !== "publicProjectionHash"));
  if (projection?.publicProjectionHash !== sha256Canonical(publicBody)) errors.push("publicProjectionHash");
  return [...new Set(errors)];
}

