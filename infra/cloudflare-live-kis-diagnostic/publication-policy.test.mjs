import test from "node:test";
import assert from "node:assert/strict";
import { aggregateProduction, evaluateCollectionPolicy } from "./production-core.mjs";
import { syntheticProductionInputs } from "./swing-fixture.mjs";
import { validLiveCoverage, validLiveSuccessor } from "../../lib/live-publication-coverage.mjs";
import { validateLiveDelivery } from "../../lib/private-live-delivery.mjs";
import { buildCloudSwingIntent } from "./cloud-swing.mjs";
import { resolveSwingOutcome } from "../../lib/forecast-swing-contract.mjs";

const date = "2026-11-03", stamp = minute => date + "T05:" + minute + ":00.000Z";
function inputs() {
  const { prepared, rows } = syntheticProductionInputs({ date, seedDate: "2026-11-02" });
  Object.assign(prepared, { inputCommit: "c".repeat(40), formulaHashesVerified:true, remoteCheckedAt: date + "T04:59:01.000Z", readyAt: date + "T04:59:02.000Z" });
  prepared.codes[0] = prepared.eligibleCodes[0] = rows[0].code = "009450";
  return { prepared, rows };
}
const first = { revision: 1, previousDeliveryHash: null, firstIssuedAt: stamp("06") };

test("use pinned eligibility, unique failures, validated durable rows and actual 0/1/4/5 thresholds", () => {
  for (const n of [0, 1, 4, 5]) {
    const { prepared, rows } = inputs();
    const failures = [0,1,2,3].map(i => ({ code: prepared.eligibleCodes[i], reason: "DIAG_UNKNOWN_TRANSPORT_FAILURE", failureStage: "UNKNOWN" }));
    rows[520] = { code: prepared.codes[520], reason: "KIS_INVALID_QUOTE", rawPricesStored: false };
    if (n) rows[0] = { code: "009450", reason: "LIVE_CLOUD_RATE_EVIDENCE_INVALID", rawPricesStored: false };
    for (let i = 1; i < n; i++) rows[i] = null;
    const status = evaluateCollectionPolicy(prepared, rows, { failures, globalFailure: { code: failures[0].reason, stage: "BATCH_COLLECTION" } });
    assert.ok(validLiveCoverage(status));
    assert.equal(status.status, n === 0 ? "COMPLETE" : n <= 4 ? "PARTIAL" : "WITHHELD");
    assert.equal(status.targetCount, 508);
    assert.equal(status.validCount, 508 - n);
    assert.equal(status.missing.length, n);
    if (n) assert.deepEqual(status.missing[0], { ticker: "009450", reason: "LIVE_CLOUD_RATE_EVIDENCE_INVALID" });
    if (n > 4) assert.throws(() => aggregateProduction(prepared, rows, stamp("06"), { ...first, failures }), /REQUIRED_INPUT_MISSING/);
  }
});

test("issue immutable partial results from available rows and a complete swing on a later real issuance", () => {
  const { prepared, rows } = inputs();
  const partialRows = rows.slice(1);
  const partial = aggregateProduction(prepared, partialRows, stamp("06"), first);
  assert.equal(partial.swing, null);
  assert.throws(() => buildCloudSwingIntent(partial.evidence, partial.delivery), /SWING_REQUIRES_COMPLETE/);
  assert.equal(partial.delivery.schemaVersion, 2);
  assert.equal(partial.delivery.publication.status, "PARTIAL");
  assert.deepEqual(partial.delivery.publication.missing, [{ ticker: "009450", reason: "LIVE_CLOUD_OBSERVATION_MISSING" }]);
  const frozen = JSON.stringify(partial.delivery);
  const complete = aggregateProduction(prepared, rows, stamp("15"), { revision: 2,
    previousDeliveryHash: partial.delivery.deliveryHash, firstIssuedAt: first.firstIssuedAt });
  assert.ok(validLiveSuccessor(partial.delivery, complete.delivery));
  assert.equal(complete.swing, null);
  const issuedSwing = buildCloudSwingIntent(complete.evidence, complete.delivery, stamp("16"));
  assert.equal(issuedSwing.createdAt, stamp("16"));
  assert.deepEqual(issuedSwing.livePublication, {status:"COMPLETE", revision:2, deliveryHash:complete.delivery.deliveryHash});
  const invalidForecast = structuredClone(issuedSwing.records[0]);
  invalidForecast.observation.provenance.metadata.livePublication.status = "PARTIAL";
  const outcome = resolveSwingOutcome({forecast:invalidForecast, resolvedAt:stamp("20")});
  assert.deepEqual([outcome.status, outcome.reasons], ["BLOCKED", ["LIVE_CLOUD_SWING_REQUIRES_COMPLETE"]]);
  assert.equal(complete.delivery.publication.status, "COMPLETE");
  assert.equal(issuedSwing.records.every(row => row.createdAt === stamp("16")), true);
  validateLiveDelivery(complete.delivery, stamp("15"));
  assert.equal(JSON.stringify(partial.delivery), frozen);
  for (const model of partial.delivery.models) {
    const available = partialRows.filter(row => row.status === "AVAILABLE");
    const expected = available.sort((a,b) => b.scores[model.modelVersion] - a.scores[model.modelVersion] || a.code.localeCompare(b.code)).slice(0,5);
    assert.deepEqual(model.records.map(r => [r.ticker, r.score]), expected.map(r => [r.code, r.scores[model.modelVersion]]));
  }
});

test("invalid score, date, source hash and future exchange time exclude exactly their rows", () => {
  const { prepared, rows } = inputs();
  rows[0].scores["B-v1"] = NaN;
  rows[1].observedDate = prepared.seedReferenceDate;
  rows[2].responseHash = null;
  rows[3].observedTime = "14:00:02";
  const value = aggregateProduction(prepared, rows, stamp("06"), first);
  assert.equal(value.delivery.publication.status, "PARTIAL");
  assert.equal(value.delivery.publication.missing.length, 4);
  assert.ok(value.delivery.publication.missing.every(row => row.reason === "LIVE_CLOUD_OBSERVATION_INVALID"));
  assert.ok(!value.evidence.observations.some(row => prepared.eligibleCodes.slice(0,4).includes(row.code)));
});

test("a verified rate rejection overrides a batch placeholder for the same symbol and never counts twice", () => {
  const { prepared, rows } = inputs(), code = "009450";
  const failures = [{ code, reason: "DIAG_UNKNOWN_TRANSPORT_FAILURE" },
    { code, reason: "LIVE_CLOUD_RATE_EVIDENCE_INVALID", evidenceSource: "RATE_REJECTION" }];
  assert.deepEqual(evaluateCollectionPolicy(prepared, rows, { failures }).missing, [{ticker:code, reason:failures[1].reason}]);
  assert.deepEqual(evaluateCollectionPolicy(prepared, rows.slice(1), { failures }).missing, [{ticker:code, reason:failures[1].reason}]);
});

test("reject invalid pre-window pin, unexpected or duplicate identities, unknown errors and unscoped failures", () => {
  const { prepared, rows } = inputs();
  const evaluate = (p = prepared, r = rows, options) => evaluateCollectionPolicy(p, r, options);
  assert.throws(() => evaluate({ ...prepared, remoteCheckedAt: stamp("01") }), /PIN_INVALID/);
  for (const flag of [undefined, false, "true"]) assert.throws(() => evaluate({...prepared,formulaHashesVerified:flag}), /PIN_INVALID/);
  assert.throws(() => evaluate({...prepared,remoteCheckedAt:date+"T04:59:02.001Z"}), /PIN_INVALID/);
  assert.throws(() => evaluate({...prepared,remoteCheckedAt:"2026-11-02T04:59:01.000Z"}), /PIN_INVALID/);
  assert.throws(() => evaluate({ ...prepared, inputCommit: null }), /PIN_INVALID/);
  assert.throws(() => evaluate(prepared, [...rows.slice(1), rows[1]]), /COMPLETION_MISMATCH/);
  assert.throws(() => evaluate(prepared, [{ ...rows[0], code: "990000" }]), /COMPLETION_MISMATCH/);
  assert.throws(() => evaluate(prepared, [{ ...rows[0], status: "EXCLUDED" }]), /PIN_INVALID/);
  for (const code of ["LIVE_CLOUD_SQL_BUDGET","LIVE_CLOUD_HASH_MISMATCH","KIS_HTTP_401","LIVE_CLOUD_UNKNOWN_VALUE"]) {
    assert.throws(() => evaluate(prepared, rows, { failures: [{ code: rows[0].code, reason: code }] }), new RegExp(code));
  }
  assert.throws(() => evaluate(prepared, rows, { globalFailure: { code: "DIAG_UNKNOWN_TRANSPORT_FAILURE", stage: "BATCH_COLLECTION" } }), /UNKNOWN_TRANSPORT/);
  const wrapper = {code:rows[0].code,reason:"DIAG_UNKNOWN_TRANSPORT_FAILURE", rawPricesStored:false};
  for (const [details,code] of [[{httpStatus:401},"KIS_HTTP_401"],[{httpStatus:403},"KIS_HTTP_403"],
    [{sourceFailure:"LIVE_CLOUD_SQL_BUDGET"},"LIVE_CLOUD_SQL_BUDGET"],[{providerFailureCode:"KIS_BUSINESS_EGW00133"},"KIS_BUSINESS_EGW00133"]]) {
    assert.throws(() => evaluate(prepared,[{...wrapper,...details},...rows.slice(1)]),new RegExp(code));
  }
});
