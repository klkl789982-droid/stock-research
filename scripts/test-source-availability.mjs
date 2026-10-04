import assert from "node:assert/strict";
import { AVAILABILITY_STATUS, createSourceAvailability, createSourceAvailabilityEvidence, SOURCE_PUBLICATION_POLICY, SOURCE_PUBLICATION_POLICY_HASH, hashAvailabilityObject } from "../lib/source-availability.mjs";

const input = { sourceMarketDate: "2026-08-17", sourceCollectedAt: "2026-08-18T04:01:00.000Z", signalComputedAt: "2026-08-18T04:02:00.000Z", availabilityTimestamp: "2026-08-18T04:03:00.000Z" };
const first = createSourceAvailability(input), second = createSourceAvailability(input);
assert.deepEqual(first, second);
assert.equal(first.sourcePublishedAt, null);
assert.equal(first.signalAvailableAt, input.availabilityTimestamp);
assert.equal(first.sourceStoredAt, input.availabilityTimestamp);
assert.equal(first.timingEvidence.publication, "POLICY_ESTIMATED");
assert.equal(first.sourcePublicationPolicyHash, SOURCE_PUBLICATION_POLICY_HASH);
assert.equal(hashAvailabilityObject(SOURCE_PUBLICATION_POLICY), SOURCE_PUBLICATION_POLICY_HASH);
assert.throws(() => createSourceAvailability({ ...input, sourceCollectedAt: "unknown" }));
const observed = createSourceAvailabilityEvidence({
  source: "공공데이터포털", operation: "getStockPriceInfo", referenceDate: "2026-08-17",
  requestedAt: "2026-08-18T04:00:00.000Z", observedAt: "2026-08-18T04:01:00.000Z",
  sourceTimestamp: "20260817", sourceTimestampSemantics: "marketDateBasDt", sourcePublishedAt: null,
  minObservedBasDt: "20260817", maxObservedBasDt: "20260817",
  availabilityEvidence: "SYSTEM_OBSERVED_BATCH_COLLECTION", availabilityStatus: AVAILABILITY_STATUS.OBSERVED,
  recordCount: 553, normalizedInputHash: "safe-hash", requestId: "safe-request-id", outcome: "success",
});
assert.equal(observed.availabilityStatus, "OBSERVED");
assert.equal(observed.sourcePublishedAt, null);
assert.equal(observed.sourceTimestamp, "20260817");
assert.equal(observed.minObservedBasDt, "20260817", "모든 종목의 최신 basDt가 같으면 관측 범위가 하나의 날짜입니다.");
assert.equal(observed.maxObservedBasDt, "20260817");
const stalePartial = createSourceAvailabilityEvidence({ ...observed, minObservedBasDt: "20260815", maxObservedBasDt: "20260817", recordCount: 552, outcome: "partial" });
assert.deepEqual([stalePartial.minObservedBasDt, stalePartial.maxObservedBasDt, stalePartial.outcome], ["20260815", "20260817", "partial"], "부분 성공과 stale 응답은 관측 범위로 보존합니다.");
const missingBasDt = createSourceAvailabilityEvidence({ ...observed, sourceTimestamp: null, minObservedBasDt: null, maxObservedBasDt: null, recordCount: 0, outcome: "partial" });
assert.equal(missingBasDt.minObservedBasDt, null, "관측 basDt가 없으면 추정하지 않습니다.");
assert.equal(missingBasDt.maxObservedBasDt, null);
assert.throws(() => createSourceAvailabilityEvidence({ ...observed, minObservedBasDt: "20260818", maxObservedBasDt: "20260817" }), /순서/);
assert.throws(() => createSourceAvailabilityEvidence({ ...observed, sourcePublishedAt: "2026-08-18T00:00:00.000Z" }), /AUTHORITATIVE/);
const authoritative = createSourceAvailabilityEvidence({ ...observed, sourcePublishedAt: "2026-08-18T00:00:00.000Z", availabilityStatus: AVAILABILITY_STATUS.AUTHORITATIVE, availabilityEvidence: "SOURCE_PUBLICATION_TIMESTAMP" });
assert.equal(authoritative.sourcePublishedAt, "2026-08-18T00:00:00.000Z");
assert.throws(() => createSourceAvailabilityEvidence({ ...observed, availabilityStatus: "VERIFIED" }));
console.log("source availability 정의·정책 hash·결정론 테스트 통과");
