import fs from "node:fs/promises";
import path from "node:path";
import { calculateEligibleSnapshotModels } from "./model-score-engine.mjs";
import { assignRanks } from "./model-history-schema.mjs";
import { classifyMarketDataRow, MODEL_HISTORY_REQUIREMENTS, normalizeModelInputRows } from "./market-data-quality-validator.mjs";
import { normalizeStockCode } from "./stock-code.mjs";
import { sha256Canonical } from "./snapshot-quality-pipeline.mjs";

export const KIS_EOD_PIPELINE_VERSION = "kis-provisional-eod-v1";
export const KIS_EOD_STATUSES = Object.freeze(["PENDING", "COLLECTED", "VALIDATED", "FAILED", "PUBLISHED"]);
export const KIS_EOD_MODEL_VERSIONS = Object.freeze(["A-v1", "A-v2", "B-v1", "C-v1", "D-v1"]);
const modelKeys = { "A-v1": "modelA", "B-v1": "modelB", "C-v1": "modelC", "D-v1": "modelD" };
const numeric = (value) => value === null || value === undefined || value === "" ? null : Number.isFinite(Number(value)) ? Number(value) : null;
const nullModels = () => Object.fromEntries(KIS_EOD_MODEL_VERSIONS.map((version) => [version, null]));
const hashPattern = /^[a-f0-9]{64}$/u;
const datePattern = /^\d{4}-\d{2}-\d{2}$/u;
const safeReference = (value) => {
  if (typeof value !== "string" || /[\s?#]/u.test(value)) return false;
  try { const url = new URL(value); return url.protocol === "https:" && Boolean(url.hostname) && !url.username && !url.password; }
  catch { return false; }
};
const stamp = (value) => typeof value === "string" && Number.isFinite(Date.parse(value));
const getValue = (values, code) => values instanceof Map ? values.get(code) : values?.[code];
const publicationExclusions = new Set(["officialQuarantinePreserved", "insufficientHistory", "tradingHaltOrNoTrade"]);

function isOfficialQuarantine(record) {
  return KIS_EOD_MODEL_VERSIONS.every((version) => record?.exclusionReasons?.[version] === "officialQuarantinePreserved");
}

function publicationCollection(candidate) {
  const required = (Array.isArray(candidate?.records) ? candidate.records : []).filter((record) => !isOfficialQuarantine(record));
  const verified = required.filter((record) => {
    const proof = record?.provenance;
    const mapping = proof?.symbolMapping;
    return proof?.sourceMarketDate === String(candidate?.referenceDate ?? "").replaceAll("-", "")
      && proof.adjustment === candidate.source?.adjustmentPolicy && proof.marketDivision === "J"
      && typeof proof.inputPriceBasis === "string" && proof.inputPriceBasis.length > 0
      && Number.isInteger(proof.historyRows) && proof.historyRows > 0
      && stamp(proof.sourceReceivedAt)
      && Date.parse(proof.sourceReceivedAt) >= Date.parse(candidate.collectionStartedAt)
      && Date.parse(proof.sourceReceivedAt) <= Date.parse(candidate.collectionCompletedAt)
      && mapping?.status === "VERIFIED_RESPONSE_TICKER"
      && mapping.requestedCode === record.ticker && mapping.responseCode === record.ticker
      && KIS_EOD_MODEL_VERSIONS.every((version) => record.exclusionReasons?.[version] === null || publicationExclusions.has(record.exclusionReasons?.[version]));
  });
  return { status: verified.length === required.length ? "VERIFIED_ALL_NON_QUARANTINED" : "INCOMPLETE", requiredCount: required.length, verifiedCount: verified.length };
}

function localTime(now) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return { date: `${values.year}-${values.month}-${values.day}`, time: `${values.hour}:${values.minute}:${values.second}` };
}

// Receipt/check times describe availability, not inputs. Reobserving identical inputs
// must not change their immutable identity. Publication uses a separate pointer.
function immutableBody(candidate) {
  const excluded = new Set(["contentHash", "collectionStartedAt", "collectionCompletedAt", "publishedAt", "status"]);
  const body = Object.fromEntries(Object.entries(candidate).filter(([key]) => !excluded.has(key)));
  if (body.calendarEvidence) {
    body.calendarEvidence = Object.fromEntries(Object.entries(body.calendarEvidence).filter(([key]) => !["observedAt", "receivedAt"].includes(key)));
  }
  if (Array.isArray(body.records)) body.records = body.records.map((record) => ({ ...record, provenance: Object.fromEntries(Object.entries(record.provenance ?? {}).filter(([key]) => key !== "sourceReceivedAt")) }));
  return body;
}

function seal(value) { return { ...value, contentHash: sha256Canonical(immutableBody(value)) }; }

function eligibilityFailure(rows, referenceDate, metadata, adjustmentPolicy) {
  if (!Array.isArray(rows) || !rows.length) return "historyMissing";
  if (String(rows[0]?.basDt) !== referenceDate.replaceAll("-", "")) return "latestDateMismatch";
  if (metadata?.adjustment && metadata.adjustment !== adjustmentPolicy) return "adjustmentMismatch";
  if (metadata?.marketDivision && metadata.marketDivision !== "J") return "marketDivisionMismatch";
  const dates = rows.map((row) => String(row?.basDt ?? ""));
  if (dates.some((date) => !/^\d{8}$/u.test(date) || date > referenceDate.replaceAll("-", ""))) return "invalidOrFutureDate";
  if (new Set(dates).size !== dates.length) return "duplicateDates";
  if (dates.some((date, index) => index > 0 && dates[index - 1] <= date)) return "historyNotDescending";
  for (let index = 0; index < rows.length; index += 1) {
    const classification = classifyMarketDataRow(rows[index], rows[index + 1], rows[index - 1]);
    if (classification.type === "invalidTradingRow") return classification.reason;
    if (classification.postNonTradingPriceDiscontinuity) return "postNonTradingPriceDiscontinuity";
    const value = numeric(rows[index].trPrc);
    if (value === null || value < 0) return "invalidTradingValue";
  }
  if (classifyMarketDataRow(rows[0], rows[1]).type !== "validTradingRow") return "tradingHaltOrNoTrade";
  return null;
}

function rateFor(rows) {
  const supplied = numeric(rows[0]?.fltRt);
  if (supplied !== null) return { value: supplied, basis: "KIS_SUPPLIED_DAILY_CHANGE_PERCENT" };
  const previousClose = numeric(rows[1]?.clpr);
  if (previousClose === null || previousClose <= 0) return { value: null, basis: "MISSING_PREVIOUS_CLOSE" };
  const difference = numeric(rows[0]?.prdy_vrss);
  if (difference !== null) return { value: difference / previousClose * 100, basis: "KIS_SIGNED_PRDY_VRSS_OVER_PREVIOUS_HISTORY_CLOSE" };
  const close = numeric(rows[0]?.clpr);
  return close === null ? { value: null, basis: "MISSING_CURRENT_CLOSE" } : { value: (close / previousClose - 1) * 100, basis: "CURRENT_CLOSE_OVER_PREVIOUS_HISTORY_CLOSE" };
}

// Research diagnostics reuse exactly the provisional input checks/rate basis.
// These exports do not relax LIVE publication, date or eligibility gates.
export { eligibilityFailure as validateKisEodInputHistory, rateFor as deriveKisEodInputChangeRate };
// Reuse the exact existing completeness and tie policies in PRIVATE storage.
// This export grants no source-finality or public-publication approval.
export { publicationCollection as inspectKisEodCollection, rankRecords as rankKisEodRecords };

function rankRecords(records) {
  const adapters = records.map((record) => ({
    code: record.ticker,
    scores: { modelA: record.scores["A-v1"], modelB: record.scores["B-v1"], modelC: record.scores["C-v1"], modelD: record.scores["D-v1"], modelE: null },
    ranks: { modelA: null, modelB: null, modelC: null, modelD: null, modelE: null },
    scoresByVersion: { "A-v1": record.scores["A-v1"], "A-v2": record.scores["A-v2"] },
    rawScoresByVersion: { "A-v2": record.rawScores["A-v2"] }, ranksByVersion: { "A-v1": null, "A-v2": null },
  }));
  // Preserve universe input order: this is the existing Daily ranking tie policy.
  assignRanks(adapters);
  adapters.forEach((adapter, index) => {
    for (const version of KIS_EOD_MODEL_VERSIONS) records[index].ranks[version] = version === "A-v2" ? adapter.ranksByVersion[version] : adapter.ranks[modelKeys[version]];
  });
}

export function buildKisEodCandidate({
  referenceDate, now = new Date(), calendarEvidence = null, universeRecords = [], historiesByCode = new Map(), expectedUniverseCount = 553,
  officialSnapshot = null, formulaHashes = {}, expectedFormulaHashes = officialSnapshot?.sourceManifest?.modelFormulaHashes ?? {},
  formulaHashScope = "officialSnapshotFormulaSourceHashes",
  collectionStartedAt = null, collectionCompletedAt = null, adjustmentPolicy = "unknown", sourceMetadataByCode = new Map(),
  sourceFinalityEvidence = "UNVERIFIED", publicationApproval = { rights: false, automation: false },
  observationType = "DRY_RUN", calculateModels = true,
} = {}) {
  const instant = new Date(now);
  if (!Number.isFinite(instant.getTime())) throw new Error("KIS_EOD_NOW_INVALID");
  const local = localTime(instant);
  const structuralErrors = [];
  const pendingReasons = [];
  if (!datePattern.test(referenceDate ?? "")) structuralErrors.push("referenceDateInvalid");
  else {
    if (referenceDate !== local.date) pendingReasons.push(referenceDate > local.date ? "futureReferenceDate" : "referenceDateNotCurrentKstDate");
    if ([0, 6].includes(new Date(`${referenceDate}T12:00:00+09:00`).getUTCDay())) pendingReasons.push("weekend");
    if (referenceDate === local.date && local.time < "15:30:00") pendingReasons.push("regularCloseNotReached");
  }
  const calendarObservedAt = calendarEvidence?.observedAt ?? calendarEvidence?.receivedAt;
  if (calendarEvidence?.source !== "KIS" || calendarEvidence?.operation !== "chk-holiday" || calendarEvidence?.referenceDate !== referenceDate || calendarEvidence?.isTradingDay !== true || !stamp(calendarObservedAt) || Date.parse(calendarObservedAt) > instant.getTime()) pendingReasons.push("tradingDayNotConfirmed");
  if (!["LIVE_COLLECTION", "DRY_RUN", "TEST_FIXTURE"].includes(observationType)) structuralErrors.push("observationTypeInvalid");
  if (!["adjusted", "unadjusted"].includes(adjustmentPolicy)) structuralErrors.push("adjustmentPolicyUnverified");
  if (!stamp(collectionStartedAt) || !stamp(collectionCompletedAt) || Date.parse(collectionStartedAt) > Date.parse(collectionCompletedAt) || Date.parse(collectionCompletedAt) > instant.getTime()) structuralErrors.push("collectionTimestampInvalid");
  else if (datePattern.test(referenceDate ?? "") && Date.parse(collectionStartedAt) < Date.parse(`${referenceDate}T15:30:00+09:00`)) pendingReasons.push("collectionBeforeRegularClose");
  const codes = universeRecords.map((stock) => normalizeStockCode(stock.code ?? stock.ticker));
  if (!codes.length || codes.some((code) => !code) || new Set(codes).size !== codes.length) structuralErrors.push("universeInvalid");
  if (!Number.isInteger(expectedUniverseCount) || codes.length !== expectedUniverseCount) structuralErrors.push("unexpectedUniverseCount");
  for (const version of KIS_EOD_MODEL_VERSIONS) if (!hashPattern.test(formulaHashes[version] ?? "") || formulaHashes[version] !== expectedFormulaHashes[version]) structuralErrors.push(`formulaHashMismatch:${version}`);
  if (!["officialSnapshotFormulaSourceHashes", "currentHEADFormulaSourceFilesLfNormalized"].includes(formulaHashScope)) structuralErrors.push("formulaHashScopeInvalid");
  if (officialSnapshot?.asOfDate > referenceDate) structuralErrors.push("futureOfficialSnapshot");
  if (observationType === "LIVE_COLLECTION" && (!Array.isArray(officialSnapshot?.records) || !datePattern.test(officialSnapshot?.asOfDate ?? ""))) structuralErrors.push("officialQuarantineBasisMissing");
  const officialQuarantine = new Set((officialSnapshot?.records ?? []).filter((record) => record.qualityEligibility?.status === "quarantined" || record.qualityEligibility?.exclusions?.length).map((record) => record.code));
  const records = [];
  const inputIdentities = [];
  const shouldCalculate = !structuralErrors.length && !pendingReasons.length && calculateModels;
  for (let index = 0; index < universeRecords.length; index += 1) {
    const stock = universeRecords[index]; const ticker = codes[index];
    const value = getValue(historiesByCode, ticker);
    const rawRows = Array.isArray(value) ? value : value?.rows;
    const metadata = getValue(sourceMetadataByCode, ticker) ?? (Array.isArray(value) ? {} : value ?? {});
    const rows = Array.isArray(rawRows) ? rawRows.map((row) => Object.fromEntries(["basDt", "mkp", "hipr", "lopr", "clpr", "trqu", "trPrc", "fltRt", "prdy_vrss"].filter((field) => row?.[field] !== undefined).map((field) => [field, row[field]]))) : [];
    inputIdentities.push({ ticker, adjustment: metadata.adjustment ?? adjustmentPolicy, marketDivision: metadata.marketDivision ?? "J", rows });
    const reasons = structuralErrors.length || pendingReasons.length ? ["pipelineNotReady"] : officialQuarantine.has(ticker) ? ["officialQuarantinePreserved"] : [];
    const failure = eligibilityFailure(rows, typeof referenceDate === "string" ? referenceDate : "", metadata, adjustmentPolicy);
    if (failure) reasons.push(failure);
    if (observationType === "LIVE_COLLECTION" && rows.length) {
      if (metadata.adjustment !== adjustmentPolicy || metadata.marketDivision !== "J" || typeof metadata.priceBasis !== "string" || !metadata.priceBasis || !stamp(metadata.receivedAt)) reasons.push("sourceMetadataMissing");
      else if (Date.parse(metadata.receivedAt) < Date.parse(collectionStartedAt) || Date.parse(metadata.receivedAt) > Date.parse(collectionCompletedAt)) reasons.push("sourceReceiptOutsideCollection");
    }
    const normalized = failure ? [] : normalizeModelInputRows(rows);
    const rate = rateFor(normalized);
    // A newly listed ticker can have valid current bars but too little history for
    // every model. Preserve that exclusion, without fabricating its missing rate.
    if (!failure && normalized.length >= Math.min(...Object.values(MODEL_HISTORY_REQUIREMENTS)) && !Number.isFinite(rate.value)) reasons.push("dailyChangeRateMissing");
    if (normalized.length && Number.isFinite(rate.value)) normalized[0] = { ...normalized[0], fltRt: rate.value };
    const eligibility = Object.fromEntries(KIS_EOD_MODEL_VERSIONS.map((version) => [version, shouldCalculate && !reasons.length && normalized.length >= MODEL_HISTORY_REQUIREMENTS[version]]));
    const exclusionReasons = Object.fromEntries(KIS_EOD_MODEL_VERSIONS.map((version) => [version, eligibility[version] ? null : reasons[0] ?? (!calculateModels ? "calculationNotRequested" : "insufficientHistory")]));
    const record = { ticker, companyName: stock.name ?? stock.companyName ?? "", market: stock.market ?? null, dataStatus: rows.length ? "COLLECTED" : "MISSING", scores: nullModels(), rawScores: { "A-v2": null }, ranks: nullModels(), modelEligibility: eligibility, exclusionReasons,
      provenance: { provider: "KIS", sourceMarketDate: rows[0]?.basDt ?? null, adjustment: metadata.adjustment ?? adjustmentPolicy, marketDivision: metadata.marketDivision ?? null, sourceReceivedAt: metadata.receivedAt ?? null, historyRows: rows.length, validTradingDays: normalized.length, normalizedInputHash: sha256Canonical(rows), dailyChangeRateBasis: rate.basis, inputPriceBasis: metadata.priceBasis ?? "KIS_DAILY_OHLCV_ADJUSTMENT_AS_REQUESTED",
        symbolMapping: { status: metadata.symbolMapping?.status ?? "UNVERIFIED", requestedCode: normalizeStockCode(metadata.symbolMapping?.requestedCode) ?? null, responseCode: normalizeStockCode(metadata.symbolMapping?.responseCode) ?? null } } };
    if (Object.values(eligibility).some(Boolean)) {
      try {
        const models = calculateEligibleSnapshotModels(normalized.slice(0, 260), eligibility);
        record.scores = { "A-v1": models.modelA?.finalTechnicalScore ?? null, "A-v2": models.modelAV2?.finalScore ?? null, "B-v1": models.modelB?.trendStrength ?? null, "C-v1": models.modelC?.entryStrength ?? null, "D-v1": models.modelD ?? null };
        record.rawScores["A-v2"] = models.modelAV2?.rawScore ?? null;
        for (const version of KIS_EOD_MODEL_VERSIONS) {
          if (eligibility[version] && !Number.isFinite(record.scores[version])) { record.modelEligibility[version] = false; record.scores[version] = null; record.exclusionReasons[version] = "modelResultNotFinite"; }
        }
        record.dataStatus = Object.values(record.modelEligibility).some(Boolean) ? "VALIDATED" : "INELIGIBLE";
      } catch {
        record.scores = nullModels(); record.rawScores["A-v2"] = null;
        for (const version of KIS_EOD_MODEL_VERSIONS) { record.modelEligibility[version] = false; record.exclusionReasons[version] = "modelCalculationFailed"; }
        record.dataStatus = "FAILED";
      }
    } else if (shouldCalculate) record.dataStatus = "INELIGIBLE";
    records.push(record);
  }
  rankRecords(records);
  const rankingUniverse = Object.fromEntries(KIS_EOD_MODEL_VERSIONS.map((version) => {
    const eligibleCodes = records.filter((record) => Number.isInteger(record.ranks[version])).map((record) => record.ticker).sort();
    return [version, { count: eligibleCodes.length, codesHash: sha256Canonical(eligibleCodes), historyRequirement: MODEL_HISTORY_REQUIREMENTS[version], tieBreak: version === "A-v2" ? "finalScoreDescThenRawScoreDescThenTickerAsc" : "scoreDescThenStableUniverseOrder" }];
  }));
  const successful = records.filter((record) => record.dataStatus === "VALIDATED").length;
  const status = structuralErrors.length ? "FAILED" : pendingReasons.length ? "PENDING" : !calculateModels && records.some((record) => record.dataStatus === "COLLECTED") ? "COLLECTED" : successful ? "VALIDATED" : "FAILED";
  const base = { schemaVersion: 1, artifactType: "kisProvisionalEod", pipelineVersion: KIS_EOD_PIPELINE_VERSION, namespace: "kis-provisional-eod", referenceDate, observationType, status,
    collectionStartedAt, collectionCompletedAt, timezone: "Asia/Seoul", immutable: true,
    source: { provider: "KIS", operation: "inquire-daily-itemchartprice", adjustmentPolicy, sourceFinalityEvidence, finality: "NOT_CONFIRMED_UNLESS_SEPARATELY_VERIFIED", normalizedInputHash: sha256Canonical(inputIdentities), officialSnapshotReferenceDate: officialSnapshot?.asOfDate ?? null, formulaHashScope, officialModelFormulaHashes: { ...(officialSnapshot?.sourceManifest?.modelFormulaHashes ?? {}) } },
    calendarEvidence, modelFormulaHashes: { ...formulaHashes }, universe: { count: codes.length, codesHash: sha256Canonical(codes), officialQuarantinePreserved: officialQuarantine.size }, rankingUniverse,
    quality: { grade: "PROVISIONAL", structuralErrors, pendingReasons, successful, unavailable: records.length - successful, isPartialRanking: successful !== records.length, validationScope: "KIS_ROW_AND_MODEL_INPUT_ONLY_NOT_OFFICIAL_FINALITY" },
    publicationApproval: { rights: publicationApproval.rights === true, rightsReference: safeReference(publicationApproval.rightsReference) ? publicationApproval.rightsReference : null, automation: publicationApproval.automation === true },
    eligibleForOfficialRanking: false, eligibleForBacktest: false, eligibleForOptimization: false, outcomesNamespace: null, records };
  return seal(base);
}

export function validateKisEodCandidate(candidate) {
  const errors = [];
  if (candidate?.schemaVersion !== 1 || candidate?.artifactType !== "kisProvisionalEod" || candidate?.pipelineVersion !== KIS_EOD_PIPELINE_VERSION || candidate?.namespace !== "kis-provisional-eod") errors.push("schema");
  if (!KIS_EOD_STATUSES.includes(candidate?.status) || !datePattern.test(candidate?.referenceDate ?? "")) errors.push("statusOrDate");
  if (!Array.isArray(candidate?.records) || new Set(candidate?.records?.map((record) => record.ticker)).size !== candidate?.records?.length) errors.push("records");
  if (candidate?.eligibleForOfficialRanking !== false || candidate?.eligibleForBacktest !== false || candidate?.eligibleForOptimization !== false || candidate?.outcomesNamespace !== null) errors.push("officialIsolation");
  for (const version of KIS_EOD_MODEL_VERSIONS) {
    const ranked = (candidate?.records ?? []).filter((record) => Number.isInteger(record.ranks?.[version]));
    const ranks = ranked.map((record) => record.ranks[version]).sort((a, b) => a - b);
    if (ranks.some((rank, index) => rank !== index + 1) || candidate?.rankingUniverse?.[version]?.count !== ranks.length) errors.push(`ranking:${version}`);
    for (const record of candidate?.records ?? []) if (record.modelEligibility?.[version] !== (Number.isFinite(record.scores?.[version]) && Number.isInteger(record.ranks?.[version]))) errors.push(`eligibility:${version}:${record.ticker}`);
  }
  if (candidate?.observationType === "LIVE_COLLECTION") for (const record of candidate?.records ?? []) {
    if (Object.values(record.modelEligibility ?? {}).some(Boolean) && (!stamp(record.provenance?.sourceReceivedAt) || Date.parse(record.provenance.sourceReceivedAt) < Date.parse(candidate.collectionStartedAt) || Date.parse(record.provenance.sourceReceivedAt) > Date.parse(candidate.collectionCompletedAt))) errors.push(`sourceReceipt:${record.ticker}`);
  }
  if (candidate?.contentHash !== sha256Canonical(immutableBody(candidate ?? {}))) errors.push("contentHash");
  return [...new Set(errors)];
}

export function canPublishKisEodCandidate(candidate) {
  const reasons = validateKisEodCandidate(candidate).map((reason) => `invalidCandidate:${reason}`);
  if (!["VALIDATED", "PUBLISHED"].includes(candidate?.status)) reasons.push("candidateNotValidated");
  if (candidate?.observationType !== "LIVE_COLLECTION") reasons.push("nonLiveObservation");
  const evidence = candidate?.source?.sourceFinalityEvidence;
  if (!verifiedFinality(evidence, candidate?.referenceDate, candidate?.collectionCompletedAt)) reasons.push("sourceFinalityUnverified");
  if (candidate?.publicationApproval?.rights !== true || !safeReference(candidate?.publicationApproval?.rightsReference)) reasons.push("derivedPublicationRightsUnapproved");
  if (candidate?.publicationApproval?.automation !== true) reasons.push("automationUnapproved");
  if (publicationCollection(candidate).status !== "VERIFIED_ALL_NON_QUARANTINED") reasons.push("incompleteCollection");
  return { eligible: reasons.length === 0, reasons };
}

export function markKisEodPublished(candidate, publishedAt) {
  const decision = canPublishKisEodCandidate(candidate);
  if (!decision.eligible) throw new Error(`KIS_EOD_PUBLICATION_BLOCKED:${decision.reasons.join(",")}`);
  if (!stamp(publishedAt) || Date.parse(publishedAt) < Date.parse(candidate.collectionCompletedAt)) throw new Error("KIS_EOD_PUBLICATION_TIMESTAMP_INVALID");
  return seal({ ...candidate, status: "PUBLISHED", publishedAt });
}

export function toPublicKisEodProjection(candidate) {
  const decision = canPublishKisEodCandidate(candidate);
  if (!decision.eligible || candidate.status !== "PUBLISHED") throw new Error(`KIS_EOD_PUBLICATION_BLOCKED:${decision.reasons.join(",") || "publishedPointerRequired"}`);
  const projection = { schemaVersion: 1, artifactType: "KisEodScoreProjection", observationType: "LIVE_COLLECTION", dataMode: "kisProvisionalEod", referenceDate: candidate.referenceDate, source: "KIS", qualityGrade: "PROVISIONAL", sourceFinality: "VERIFIED_BY_SEPARATE_CONTRACT_NOT_OFFICIAL_DATA_PORTAL", contentHash: candidate.contentHash,
    publishedAt: candidate.publishedAt, collectionCompletedAt: candidate.collectionCompletedAt, publicationApproval: candidate.publicationApproval, sourceFinalityEvidence: candidate.source.sourceFinalityEvidence, publicationCollection: publicationCollection(candidate),
    eligibleForOfficialRanking: false, eligibleForBacktest: false, eligibleForOptimization: false, modelFormulaHashes: candidate.modelFormulaHashes, modelFormulaHashScope: candidate.source.formulaHashScope, rankingUniverse: candidate.rankingUniverse,
    coverage: { total: candidate.records.length, analyzable: candidate.quality.successful, excluded: candidate.quality.unavailable },
    records: candidate.records.map(({ ticker, companyName, market, scores, ranks, exclusionReasons }) => ({ ticker, companyName, market, scores, ranks, exclusionReasons })) };
  return { ...projection, publicProjectionHash: sha256Canonical(projection) };
}

function exactKeys(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key));
}

function verifiedFinality(evidence, referenceDate, collectionCompletedAt) {
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

export async function writeImmutableKisEodCandidate({ directory, candidate }) {
  const errors = validateKisEodCandidate(candidate);
  if (errors.length) throw new Error(`KIS_EOD_CANDIDATE_INVALID:${errors.join(",")}`);
  const resolved = path.resolve(directory);
  if (/(?:^|[\\/])(?:history|model-history|market-prices|market-seeds|intraday-signals)(?:[\\/]|$)/u.test(resolved)) throw new Error("KIS_EOD_OFFICIAL_NAMESPACE_FORBIDDEN");
  if (!["VALIDATED", "COLLECTED"].includes(candidate.status)) throw new Error("KIS_EOD_NOT_PERSISTABLE");
  await fs.mkdir(resolved, { recursive: true });
  const target = path.join(resolved, `${candidate.referenceDate}.json`);
  try { await fs.writeFile(target, `${JSON.stringify(candidate, null, 2)}\n`, { flag: "wx" }); return { action: "create", path: target, contentHash: candidate.contentHash }; }
  catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const existing = JSON.parse(await fs.readFile(target, "utf8"));
    if (!validateKisEodCandidate(existing).length && existing.contentHash === candidate.contentHash) return { action: "idempotent", path: target, contentHash: existing.contentHash };
    throw new Error("KIS_EOD_IMMUTABLE_CONFLICT");
  }
}
