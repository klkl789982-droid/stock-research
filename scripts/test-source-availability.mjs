import assert from "node:assert/strict";
import { createSourceAvailability, SOURCE_PUBLICATION_POLICY, SOURCE_PUBLICATION_POLICY_HASH, hashAvailabilityObject } from "../lib/source-availability.mjs";

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
console.log("source availability 정의·정책 hash·결정론 테스트 통과");
