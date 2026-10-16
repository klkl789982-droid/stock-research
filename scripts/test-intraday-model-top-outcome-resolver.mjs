import assert from "node:assert/strict";
import { resolveIntradayModelTopOutcomes, validateIntradayModelTopOutcomes, validateLegacyIntradayModelTopOutcomes, hashIntradayEvidencePayload } from "../lib/intraday-model-top-outcome-resolver.mjs";
import { buildIntradayModelTopPerformance, buildLegacyIntradayModelTopPerformance } from "../lib/model-top-performance.mjs";
import { currentOutcomeInput, currentOutcome, fixtureCalendar, legacyOutcomeFixture, rehash, receipt } from "./fixtures/intraday-1400-outcomes.mjs";

const input = currentOutcomeInput();
const first = (value) => value.records[0];
const result = (patch = {}) => resolveIntradayModelTopOutcomes({ ...input, ...patch });
const metrics = (performance, horizon = "1DAY") => performance.summary.find((model) => model.modelVersion === "A-v1").groups.find((group) => group.topN === 5).horizons.find((item) => item.horizon === horizon);
const pending = result({ tradingCalendar: fixtureCalendar(1), resolvedAt: "2026-10-06T12:00:00Z" });
assert.deepEqual(validateIntradayModelTopOutcomes(pending), []);
assert.equal(first(pending).entry.status, "PENDING");
assert.equal(first(pending).horizons["1DAY"].returnPercent, null);

const mature = currentOutcome();
assert.deepEqual(validateIntradayModelTopOutcomes(mature), []);
assert.equal(mature.schemaVersion, 2);
assert.equal(mature.layer, "INTRADAY_1400_LIVE");
assert.equal(mature.executionPolicy.policyId, "intraday-1400-t1-open-v1");
assert.equal(first(mature).entry.price, 100);
assert.equal(first(mature).horizons["1DAY"].returnPercent, 7);
assert.equal(first(mature).horizons["5DAY"].targetTradingDate, "2026-10-13");
assert.equal(first(mature).horizons["60DAY"].status, "PENDING");
assert.deepEqual(result({ existing: mature, resolvedAt: "2026-10-16T13:00:00Z" }).records, mature.records, "verified unchanged evidence retains the first resolution time");
assert.equal(metrics(buildIntradayModelTopPerformance({ outcomes: [mature] })).meanReturn, 7);

const noSignalProof = result({ signalAvailability: null });
assert.equal(first(noSignalProof).entry.status, "DATA_MISSING");
assert.match(first(noSignalProof).entry.reason, /availabilitySourceUnproven/);
assert.equal(metrics(buildIntradayModelTopPerformance({ outcomes: [noSignalProof] })).meanReturn, null);
assert.equal(metrics(buildIntradayModelTopPerformance({ outcomes: [noSignalProof] })).maturity.DATA_MISSING, 1);
assert.deepEqual(validateIntradayModelTopOutcomes(noSignalProof), []);
const noExecutionProof = result({ executionEvidence: [] });
assert.equal(first(noExecutionProof).horizons["1DAY"].status, "DATA_MISSING");
assert.match(first(noExecutionProof).horizons["1DAY"].reason, /executionEvidenceMissing/);
assert.equal(first(noExecutionProof).entry.status, "DATA_MISSING");
assert.equal(first(result({ existing: mature, signalAvailability: null })).horizons["1DAY"].returnPercent, null, "cached MATURE cannot bypass missing current evidence");
assert.equal(first(result({ existing: mature, executionEvidence: [] })).horizons["1DAY"].returnPercent, null);

const lateSignal = result({ signalAvailability: receipt(input.signal.contentHash, "2026-10-07T00:00:00Z") });
assert.equal(first(lateSignal).entry.reason, "signalNotAvailableBeforeEntry");
for (const proof of [
  { ...input.signalAvailability, sourceHash: "0".repeat(64) },
  { ...input.signalAvailability, availabilityEvidence: "POLICY_ASSUMPTION" },
  { ...input.signalAvailability, observedAt: "2026-10-06T05:03:00Z" },
  receipt(input.signal.contentHash, "2026-10-06T05:00:00Z"),
]) assert.equal(first(result({ signalAvailability: proof })).entry.status, "DATA_MISSING");
const providerProof = { source: "SYNTHETIC_TEST_FIXTURE", sourceHash: input.signal.contentHash, availableAt: input.signalAvailability.availableAt, publishedAt: input.signalAvailability.availableAt, availabilityEvidence: "PROVIDER_PUBLISHED" };
assert.equal(first(result({ signalAvailability: providerProof })).horizons["1DAY"].status, "MATURE");

const beforeClose = result({ resolvedAt: "2026-10-07T05:00:00Z", tradingCalendar: fixtureCalendar(2) });
assert.notEqual(first(beforeClose).horizons["1DAY"].status, "MATURE", "future or not-yet-available EOD must not resolve");
const afterCloseBeforeReceipt = result({ resolvedAt: "2026-10-07T07:00:00Z", tradingCalendar: fixtureCalendar(2) });
assert.equal(first(afterCloseBeforeReceipt).entry.status, "PENDING");
assert.match(first(afterCloseBeforeReceipt).entry.reason, /notYetAvailable/);
const atReceipt = result({ resolvedAt: "2026-10-07T08:00:00Z", tradingCalendar: fixtureCalendar(2) });
assert.equal(first(atReceipt).horizons["1DAY"].status, "MATURE");
const beforeFifthClose = result({ resolvedAt: "2026-10-13T05:00:00Z" });
assert.equal(first(beforeFifthClose).horizons["1DAY"].status, "MATURE");
assert.equal(first(beforeFifthClose).horizons["5DAY"].reason, "targetCloseNotYetObserved");
const beforeFifthReceipt = result({ resolvedAt: "2026-10-13T07:00:00Z" });
assert.equal(first(beforeFifthReceipt).horizons["5DAY"].status, "PENDING");
assert.equal(first(beforeFifthReceipt).horizons["5DAY"].reason, "exit:notYetAvailable");

function changedLedgers(change) {
  const ledgers = structuredClone(input.priceLedgers);
  change(ledgers[1]);
  // Updating a synthetic source requires a new hash and matching receipt.
  ledgers[1].contentHash = hashIntradayEvidencePayload(ledgers[1]);
  if (ledgers[1].availability) ledgers[1].availability.sourceHash = ledgers[1].contentHash;
  return ledgers;
}
for (const executable of [undefined, false, null, "true"]) {
  const priceLedgers = changedLedgers((ledger) => { ledger.records[0].executable = executable; });
  assert.equal(first(result({ priceLedgers })).entry.status, "DATA_MISSING");
}
for (const value of [null, undefined, 0, -1, Infinity, NaN, "100"]) {
  const priceLedgers = changedLedgers((ledger) => { ledger.records[0].openPrice = value; });
  assert.equal(first(result({ priceLedgers })).entry.status, "DATA_MISSING");
}
for (const value of [null, 0, -1, Infinity, NaN, "107"]) {
  const priceLedgers = changedLedgers((ledger) => { ledger.records[0].closePrice = value; });
  assert.equal(first(result({ priceLedgers })).horizons["1DAY"].returnPercent, null);
}
const zero = result({ priceLedgers: changedLedgers((ledger) => { ledger.records[0].closePrice = 100; }) });
assert.deepEqual(validateIntradayModelTopOutcomes(zero), []);
assert.equal(metrics(buildIntradayModelTopPerformance({ outcomes: [zero] })).meanReturn, 0, "genuine zero is a finite observed return");
assert.equal(metrics(buildIntradayModelTopPerformance({ outcomes: [zero] })).observationCount, 1);
assert.equal(metrics(buildIntradayModelTopPerformance({ outcomes: [zero] })).positiveRate, 0);
for (const change of [
  (ledger) => { delete ledger.availability; },
  (ledger) => { ledger.availability = receipt(ledger.contentHash, "2026-10-07T01:00:00Z"); },
  (ledger) => { ledger.records.push(structuredClone(ledger.records[0])); },
  (ledger) => { ledger.records[0].date = "2026-10-06"; },
]) assert.equal(first(result({ priceLedgers: changedLedgers(change) })).entry.status, "DATA_MISSING");
assert.equal(first(result({ priceLedgers: [...input.priceLedgers, input.priceLedgers[1]] })).entry.reason, "entry:duplicatePriceLedger");
assert.equal(first(result({ priceLedgers: [] })).entry.reason, "entry:missingPriceLedger");
assert.equal(first(result({ priceLedgers: [null], executionEvidence: [null] })).entry.status, "DATA_MISSING");
for (const change of [
  (proof) => { proof.entryExecutable = undefined; },
  (proof) => { proof.exitExecutable = false; },
  (proof) => { proof.adjustmentBasis = "UNKNOWN"; },
  (proof) => { proof.exitDate = "2026-10-08"; },
  (proof) => { proof.ticker = "000002"; },
  (proof) => { proof.availability.availableAt = "2026-10-17T08:00:00Z"; proof.availability.observedAt = proof.availability.availableAt; },
]) {
  const executionEvidence = structuredClone(input.executionEvidence);
  change(executionEvidence[0]);
  executionEvidence[0].contentHash = hashIntradayEvidencePayload(executionEvidence[0]);
  executionEvidence[0].availability.sourceHash = executionEvidence[0].contentHash;
  assert.equal(first(result({ executionEvidence })).horizons["1DAY"].returnPercent, null);
}
const missingCalendar = result({ tradingCalendar: { dates: { "2026-10-06": { status: "tradingDay" }, "2026-10-08": { status: "tradingDay" } } } });
assert.equal(first(missingCalendar).entry.reason, "missingTradingCalendarStatus");

const legacy = legacyOutcomeFixture(mature);
assert.deepEqual(validateLegacyIntradayModelTopOutcomes(legacy), []);
assert.notDeepEqual(validateIntradayModelTopOutcomes(legacy), []);
assert.throws(() => result({ existing: legacy }), /COHORT_OR_SIGNAL_CONFLICT/);
assert.throws(() => result({ signal: { ...input.signal, schemaVersion: 1, officialSignalTime: "14:30:00" } }), /1400_LIVE_SIGNAL_INVALID/);
for (const mutate of [
  (signal) => { signal.source.provider = "UNKNOWN"; },
  (signal) => { delete signal.source.seedHash; },
  (signal) => { signal.modelDefinitions.A.modelVersion = "A-v2"; },
  (signal) => { signal.modelDefinitions.A.formulaHash = "unverified"; },
]) {
  const signal = structuredClone(input.signal); mutate(signal);
  assert.throws(() => result({ signal: rehash(signal) }), /1400_LIVE_SIGNAL_INVALID/, "rehashing malformed provenance cannot certify a current LIVE signal");
}
for (const outcomes of [[legacy, mature], [mature, legacy], [mature, legacy, mature]]) {
  const current = buildIntradayModelTopPerformance({ outcomes });
  assert.equal(current.layer, "INTRADAY_1400_LIVE");
  assert.equal(metrics(current).observationCount, 1, "same-date legacy must not merge with or replace current");
  assert.equal(metrics(buildLegacyIntradayModelTopPerformance({ outcomes })).observationCount, 1);
}
const empty = buildIntradayModelTopPerformance({ outcomes: [legacy] });
assert.equal(empty.executionPolicyId, "intraday-1400-t1-open-v1");
assert.equal(empty.totalOutcomeObservationCount, 0);
assert.equal(metrics(empty).status, "ACCUMULATING");
assert.equal(metrics(empty).meanReturn, null);
assert.equal(buildLegacyIntradayModelTopPerformance({ outcomes: [legacy] }).archiveOnly, true);
assert.equal(buildIntradayModelTopPerformance({ outcomes: [mature, zero] }).conflictedCohortCount, 1);
assert.equal(buildIntradayModelTopPerformance({ outcomes: [mature, zero] }).totalOutcomeObservationCount, 0, "conflicting same-cohort artifacts must be quarantined");
for (const invalid of [null, Infinity, NaN, "7"]) {
  const tampered = structuredClone(mature); tampered.records[0].horizons["1DAY"].returnPercent = invalid;
  assert.notDeepEqual(validateIntradayModelTopOutcomes(rehash(tampered)), []);
  assert.equal(buildIntradayModelTopPerformance({ outcomes: [rehash(tampered)] }).totalOutcomeObservationCount, 0);
}
assert.deepEqual(currentOutcomeInput(), input, "resolution must not mutate signal, prices, calendar, or evidence");
console.log("14:00 outcome evidence gates, availability boundaries, unknown executability, cache revalidation, zero/null, 14:30 archive isolation tests passed");
