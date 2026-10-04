import { createHash } from "node:crypto";

export const SOURCE_PUBLICATION_POLICY = Object.freeze({
  policyId: "nextBusinessDayAfter13KST",
  description: "기준일 다음 영업일 오후 1시 이후 갱신",
  evidenceUrl: "https://www.data.go.kr/data/15094808/openapi.do",
  publishedAtIsRecordSpecific: false,
});

const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
  ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
export const hashAvailabilityObject = (value) => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
export const SOURCE_PUBLICATION_POLICY_HASH = hashAvailabilityObject(SOURCE_PUBLICATION_POLICY);

export const AVAILABILITY_STATUS = Object.freeze({
  AUTHORITATIVE: "AUTHORITATIVE",
  OBSERVED: "OBSERVED",
  POLICY_ASSUMPTION: "POLICY_ASSUMPTION",
  UNKNOWN: "UNKNOWN",
});

const isTimestamp = (value) => value === null || (typeof value === "string" && Number.isFinite(Date.parse(value)));

/**
 * A safe, source-level availability record. `observedAt` is our receipt boundary,
 * never an assertion about the provider's first-publication time.
 */
export function createSourceAvailabilityEvidence({
  source,
  operation,
  referenceDate,
  requestedAt = null,
  observedAt = null,
  sourceTimestamp = null,
  sourceTimestampSemantics = null,
  minObservedBasDt = null,
  maxObservedBasDt = null,
  sourcePublishedAt = null,
  availabilityEvidence,
  availabilityStatus,
  recordCount = null,
  normalizedInputHash = null,
  requestId = null,
  outcome,
}) {
  if (!Object.values(AVAILABILITY_STATUS).includes(availabilityStatus)) throw new Error("availabilityStatus가 유효하지 않습니다.");
  if (!isTimestamp(requestedAt) || !isTimestamp(observedAt) || !isTimestamp(sourcePublishedAt)) throw new Error("availability evidence 시각이 유효하지 않습니다.");
  if (![minObservedBasDt, maxObservedBasDt].every((value) => value === null || /^\d{8}$/u.test(value))) throw new Error("observed basDt 범위가 유효하지 않습니다.");
  if (minObservedBasDt !== null && maxObservedBasDt !== null && minObservedBasDt > maxObservedBasDt) throw new Error("observed basDt 범위 순서가 유효하지 않습니다.");
  if (sourcePublishedAt !== null && availabilityStatus !== AVAILABILITY_STATUS.AUTHORITATIVE) throw new Error("sourcePublishedAt은 AUTHORITATIVE 증거에서만 기록할 수 있습니다.");
  if (!source || !operation || !referenceDate || !availabilityEvidence || !outcome) throw new Error("availability evidence 필수 필드가 없습니다.");
  if (recordCount !== null && (!Number.isInteger(recordCount) || recordCount < 0)) throw new Error("recordCount가 유효하지 않습니다.");
  return {
    source,
    operation,
    referenceDate,
    requestedAt,
    observedAt,
    sourceTimestamp,
    sourceTimestampSemantics,
    minObservedBasDt,
    maxObservedBasDt,
    sourcePublishedAt,
    availabilityEvidence,
    availabilityStatus,
    recordCount,
    normalizedInputHash,
    requestId,
    outcome,
  };
}

export function createSourceAvailability({ sourceMarketDate, sourceCollectedAt, signalComputedAt, availabilityTimestamp }) {
  if (![sourceCollectedAt, signalComputedAt, availabilityTimestamp].every((value) => Number.isFinite(Date.parse(value)))) throw new Error("source availability 시각이 유효하지 않습니다.");
  return {
    sourceMarketDate,
    sourcePublishedAt: null,
    sourceCollectedAt,
    sourceStoredAt: availabilityTimestamp,
    signalComputedAt,
    signalAvailableAt: availabilityTimestamp,
    sourceAvailabilityStatus: "OBSERVED",
    sourcePublicationPolicy: SOURCE_PUBLICATION_POLICY,
    sourcePublicationPolicyHash: SOURCE_PUBLICATION_POLICY_HASH,
    timingPolicyVersion: "public-eod-t2-open-v1",
    timingEvidence: {
      publication: "POLICY_ESTIMATED",
      collection: "OBSERVED",
      availabilityTimestampSemantics: "commitIntentTimestamp",
      actualCommitCompletionStoredInRunManifest: true
    }
  };
}
