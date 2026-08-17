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
