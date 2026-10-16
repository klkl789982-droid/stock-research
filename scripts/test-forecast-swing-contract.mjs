import assert from "node:assert/strict";
import { test } from "node:test";
import { createPreparingForecast, validateForecastRecord, hashSwingContent, resolveSwingOutcome, validateSwingOutcome, createPurgedChronologicalSplit } from "../lib/forecast-swing-contract.mjs";

const copy = (value) => structuredClone(value);
const sourceHash = hashSwingContent({ source: "test-fixture-not-market-data" });
function proof(availableAt) {
  return { source: "OFFICIAL_FIXTURE", sourceHash, availableAt, availabilityEvidence: "SYSTEM_OBSERVED", receivedAt: availableAt };
}
function forecastOptions() {
  return {
    createdAt: "2026-10-16T13:00:00.000Z",
    observation: { symbol: "005930", observedDate: "2026-10-15", observedAt: "2026-10-15T06:30:00.000Z", referencePrice: 100, provenance: proof("2026-10-16T12:00:00.000Z") },
    inputs: [{ name: "modelAScore", value: 72, observedAt: "2026-10-15T06:30:00.000Z", ...proof("2026-10-16T12:00:00.000Z") }],
  };
}
function outcomeOptions() {
  const dates = Array.from({ length: 8 }, (_, index) => {
    const date = `2026-10-${16 + index}`;
    return [17, 18].includes(16 + index) ? { date, status: "CLOSED" }
      : { date, status: "TRADING", openAt: `${date}T00:00:00.000Z`, closeAt: `${date}T06:30:00.000Z` };
  });
  return {
    forecast: createPreparingForecast(forecastOptions()), resolvedAt: "2026-10-26T12:00:00.000Z",
    calendar: { status: "CONFIRMED", evidence: "OFFICIAL_CALENDAR", timeZone: "Asia/Seoul", coverageStartDate: "2026-10-16", coverageEndDate: "2026-10-23", dates, ...proof("2026-10-16T12:00:00.000Z") },
    prices: Array.from({ length: 5 }, (_, index) => {
      const date = `2026-10-${19 + index}`;
      const receivedAt = `2026-10-${index === 4 ? 26 : 20 + index}T04:10:00.000Z`;
      return { symbol: "005930", date, officialOpen: 100 + index, officialClose: 101 + index, tradingStatus: "TRADABLE", priceKind: "OFFICIAL_DAILY_OHLC", adjustmentBasis: "UNADJUSTED_NO_CORPORATE_ACTIONS", publicationLowerBoundAt: receivedAt.replace("04:10", "04:00"), ...proof(receivedAt) };
    }),
    executionEvidence: { status: "CONFIRMED", symbol: "005930", entryDate: "2026-10-19", exitDate: "2026-10-23", entryExecutable: true, exitExecutable: true, adjustmentBasis: "UNADJUSTED_NO_CORPORATE_ACTIONS", ...proof("2026-10-26T05:00:00.000Z") },
  };
}
function rehashOutcome(outcome) {
  delete outcome.outcomeHash;
  return { ...outcome, outcomeHash: hashSwingContent(outcome) };
}

test("deterministic immutable preparation never converts observed scores into predictions", () => {
  const options = forecastOptions(), record = createPreparingForecast(options);
  assert.deepEqual(record, createPreparingForecast(copy(options)));
  assert.equal(record.status, "PREPARING");
  assert.equal(record.schemaVersion, "swing5-1400-preparing-v2");
  assert.equal(record.modelVersion, "swing5-1400-preparing-v2");
  assert.equal(record.horizonTradingDays, 5);
  assert.deepEqual(record.predictions, { probabilityUp: null, expectedReturn: null, confidence: null });
  assert.equal(record.inputs[0].value, 72);
  assert.equal(record.inputSemantics, "OBSERVED_FEATURES_NOT_PROBABILITIES");
  assert.equal(record.observationMode, "RETROSPECTIVE_OBSERVATION");
  assert.equal(record.eligibility.inputTimingEligible, true);
  assert.equal(record.eligibility.forTraining, false);
  assert.equal(record.eligibility.eligible, false);
  assert.equal(record.actualFill, null);
  assert.equal(record.netReturn, null);
  assert.ok(Object.isFrozen(record.inputs[0]));
  options.inputs[0].value = 99;
  assert.equal(record.inputs[0].value, 72);
  assert.throws(() => { record.predictions.probabilityUp = 0.72; }, TypeError);
  assert.deepEqual(validateForecastRecord(record), { valid: true, reasons: [] });
});

test("hostile timestamps, numeric coercion, schema, hash, accessors and circular JSON fail closed", () => {
  for (const invalid of ["2026-10-16", "2026-02-30T01:00:00Z", "2026-10-16T25:00:00Z", "2026-10-16T13:00:00", "2026-10-16T13:00:00+14:30", 1792155600]) {
    assert.throws(() => createPreparingForecast({ ...forecastOptions(), createdAt: invalid }));
  }
  for (const bad of [0, -1, "100", true, NaN, Infinity]) {
    const options = forecastOptions(); options.observation.referencePrice = bad;
    assert.throws(() => createPreparingForecast(options));
  }
  const malformed = forecastOptions(); malformed.inputs[0].sourceHash = "safe-hash";
  assert.throws(() => createPreparingForecast(malformed), /INVALID_SOURCE_HASH/);
  const forecast = createPreparingForecast(forecastOptions());
  for (const change of [r => { r.forecastHash = "f".repeat(64); }, r => { r.schemaVersion = 2; }, r => { r.predictions.probabilityUp = 0.99; }, r => { r.inputs[0].value = 99; }, r => { r.eligibility.forTraining = true; }, r => { r.extra = "unexpected"; }]) {
    const altered = copy(forecast); change(altered);
    assert.equal(validateForecastRecord(altered).valid, false);
  }
  const accessor = forecastOptions(); Object.defineProperty(accessor, "bad", { enumerable: true, get() { throw new Error("must not execute"); } });
  assert.throws(() => createPreparingForecast(accessor), /ACCESSOR_NOT_ALLOWED/);
  const cycle = forecastOptions(); cycle.inputs[0].value = cycle;
  assert.throws(() => createPreparingForecast(cycle), /NON_JSON_VALUE/);
  assert.throws(() => createPreparingForecast(JSON.parse('{"__proto__":{},"createdAt":"2026-10-16T13:00:00Z"}')), /UNSAFE_OBJECT_KEY/);
});

test("formula, seed and model metadata is immutable, hashed and retained through validation", () => {
  const options = forecastOptions();
  options.inputs[0].provenance = { modelVersion: "model-a-v2", formulaHash: sourceHash, seedHash: sourceHash, sourceArtifact: "data/saved-fixture.json", metadata: { originalPublicationAt: null } };
  const forecast = createPreparingForecast(options);
  assert.equal(forecast.inputs[0].modelVersion, "model-a-v2");
  assert.equal(forecast.inputs[0].formulaHash, sourceHash);
  assert.equal(forecast.inputs[0].seedHash, sourceHash);
  assert.equal(forecast.inputs[0].sourceArtifact, "data/saved-fixture.json");
  assert.deepEqual(forecast.inputs[0].metadata, { originalPublicationAt: null });
  assert.equal(validateForecastRecord(forecast).valid, true);
  const altered = copy(forecast); altered.inputs[0].formulaHash = "f".repeat(64);
  assert.equal(validateForecastRecord(altered).valid, false);
  options.inputs[0].provenance.formulaHash = "unverified";
  assert.throws(() => createPreparingForecast(options), /INVALID_SOURCE_HASH/);
});

test("all inputs require actual receipt/publication proof, never market-close or policy inference", () => {
  for (const edit of [
    r => { r.inputs[0].availableAt = null; },
    r => { r.inputs[0].receivedAt = null; },
    r => { r.inputs[0].availabilityEvidence = "POLICY_ASSUMPTION"; },
    r => { r.inputs[0].receivedAt = r.inputs[0].availableAt = "2026-10-16T13:00:01.000Z"; },
    r => { r.inputs[0].publicationLowerBoundAt = "2026-10-17T04:00:00.000Z"; },
    r => { r.inputs[0].observedAt = "2026-10-16T14:00:00.000Z"; },
    r => { r.observation.provenance = {}; },
    r => { r.inputs = []; },
    r => { r.inputs[0].sourceHash = null; },
  ]) {
    const options = forecastOptions(); edit(options);
    assert.equal(createPreparingForecast(options).eligibility.inputTimingEligible, false);
  }
  const options = forecastOptions();
  options.inputs[0].availableAt = null;
  options.inputs[0].collectionCompletedAt = "2026-10-15T06:30:00.000Z";
  assert.equal(createPreparingForecast(options).inputs[0].availableAt, null);
  const zeroFeature = forecastOptions(); zeroFeature.inputs[0].value = 0;
  assert.equal(createPreparingForecast(zeroFeature).eligibility.inputTimingEligible, true);
  const nullFeature = forecastOptions(); nullFeature.inputs[0].value = null;
  assert.equal(createPreparingForecast(nullFeature).eligibility.inputTimingEligible, false);
  const provider = forecastOptions();
  provider.inputs[0].availabilityEvidence = "PROVIDER_PUBLISHED";
  provider.inputs[0].publishedAt = provider.inputs[0].availableAt;
  assert.equal(createPreparingForecast(provider).eligibility.inputTimingEligible, true);
});

test("Korea date boundary and model/PIT blockers are separate from timing readiness", () => {
  const options = forecastOptions(); options.createdAt = "2026-10-16T15:30:00.000Z";
  options.observation.observedDate = "2026-10-17";
  options.blockers = ["MODEL_NOT_TRAINED", "PIT_UNIVERSE_UNVERIFIED", "SOURCE_QUALITY_REJECTED", "COST_UNSPECIFIED"];
  const record = createPreparingForecast(options);
  assert.equal(record.observationMode, "CURRENT_OBSERVATION");
  assert.equal(record.eligibility.inputTimingEligible, true);
  assert.equal(record.eligibility.inputEligible, false);
  assert.equal(record.eligibility.forTraining, false);
  assert.equal(record.eligibility.timingBlockers.length, 0);
  options.observation.observedDate = "2026-10-18";
  assert.equal(createPreparingForecast(options).eligibility.inputTimingEligible, false);
});

test("confirmed future entry and fifth-session exit yield only a separate observational benchmark", () => {
  const options = outcomeOptions();
  const before = JSON.stringify(options.forecast);
  const outcome = resolveSwingOutcome(options);
  assert.equal(outcome.status, "OBSERVED");
  assert.equal(outcome.entryDate, "2026-10-19");
  assert.equal(outcome.exitDate, "2026-10-23");
  assert.equal(outcome.grossReturn, 0.05);
  assert.equal(outcome.officialEntryOpen, 100);
  assert.equal(outcome.officialExitClose, 105);
  assert.equal(outcome.actualFill, null);
  assert.equal(outcome.executableReturn, null);
  assert.equal(outcome.netReturn, null);
  assert.equal(outcome.forTraining, false);
  assert.equal(JSON.stringify(options.forecast), before);
  assert.ok(Object.isFrozen(outcome));
  assert.equal(validateSwingOutcome(outcome, { forecast: options.forecast }).valid, true);
  const { forecast } = options;
  const evidence = { calendar: options.calendar, prices: options.prices, executionEvidence: options.executionEvidence };
  assert.equal(validateSwingOutcome(outcome, { forecast, evidence }).evidenceVerified, true);
  evidence.prices[4].officialClose = 1000;
  assert.equal(validateSwingOutcome(outcome, { forecast, evidence }).valid, false);
  const blockedModel = forecastOptions(); blockedModel.blockers = ["MODEL_NOT_TRAINED", "PIT_UNIVERSE_UNVERIFIED"];
  options.forecast = createPreparingForecast(blockedModel);
  assert.equal(resolveSwingOutcome(options).status, "OBSERVED");
});

test("immature resolution is pending only with a complete confirmed calendar", () => {
  const options = outcomeOptions(); options.resolvedAt = "2026-10-22T10:00:00.000Z";
  const pending = resolveSwingOutcome(options);
  assert.equal(pending.status, "PENDING");
  assert.equal(pending.grossReturn, null);
  assert.equal(validateSwingOutcome(pending, { forecast: options.forecast }).valid, true);
  options.calendar.dates.pop();
  assert.equal(resolveSwingOutcome(options).status, "BLOCKED");
  options.calendar = null;
  assert.equal(resolveSwingOutcome(options).status, "BLOCKED");
});

test("issuance exactly at session open cannot claim that session as entry", () => {
  const options = outcomeOptions();
  const preparation = forecastOptions(); preparation.createdAt = "2026-10-19T00:00:00.000Z";
  options.forecast = createPreparingForecast(preparation);
  // Monday open equals issuance; Tuesday must be entry. Friday is only day four.
  assert.equal(resolveSwingOutcome(options).status, "BLOCKED");
  preparation.createdAt = "2026-10-18T23:59:59.999Z";
  options.forecast = createPreparingForecast(preparation);
  assert.equal(resolveSwingOutcome(options).entryDate, "2026-10-19");
  const lateInput = forecastOptions();
  lateInput.inputs[0].availableAt = lateInput.inputs[0].receivedAt = "2026-10-19T00:00:01.000Z";
  options.forecast = createPreparingForecast(lateInput);
  assert.equal(resolveSwingOutcome(options).status, "BLOCKED");
});

test("missing/unknown dates, price gaps, suspension, delisting, bad values, and unknown assumptions block", () => {
  for (const edit of [
    o => { o.calendar = null; }, o => { o.calendar.status = "INFERRED"; },
    o => { o.calendar.dates.splice(2, 1); }, o => { o.calendar.dates[3].status = "UNCHECKED"; },
    o => { o.calendar.coverageEndDate = "2026-10-22"; },
    o => { o.calendar.timeZone = "UTC"; },
    o => { o.calendar.dates.push(copy(o.calendar.dates[0])); },
    o => { o.executionEvidence = null; }, o => { o.executionEvidence.entryExecutable = null; },
    o => { o.executionEvidence.adjustmentBasis = "UNKNOWN"; }, o => { o.executionEvidence.symbol = "000000"; },
    o => { o.prices = []; }, o => { o.prices[2].tradingStatus = "SUSPENDED"; },
    o => { o.prices[4].tradingStatus = "DELISTED"; }, o => { o.prices[0].officialOpen = 0; },
    o => { o.prices[0].officialOpen = null; }, o => { o.prices[4].officialClose = "105"; },
    o => { o.prices[1].adjustmentBasis = "UNKNOWN"; }, o => { o.prices[4].receivedAt = null; },
    o => { o.prices[0].availabilityEvidence = "POLICY_ASSUMPTION"; },
    o => { o.prices[4].availableAt = o.prices[4].receivedAt = "2026-10-27T04:00:00.000Z"; },
    o => { o.prices[1].availableAt = o.prices[1].receivedAt = "2026-10-20T06:30:00.000Z"; },
    o => { o.prices.push(copy(o.prices[0])); }, o => { o.forecast = copy(o.forecast); o.forecast.inputs[0].value = 1; },
  ]) {
    const options = outcomeOptions(); edit(options);
    const result = resolveSwingOutcome(options);
    assert.equal(result.status, "BLOCKED", JSON.stringify(result));
    assert.equal(result.grossReturn, null);
  }
});

test("receipt after resolution cannot become mature; no cached outcome can exist before issuance", () => {
  const options = outcomeOptions(); options.resolvedAt = "2026-10-23T07:00:00.000Z";
  // Even though the exit session has closed, no actual receipt or exit-execution evidence yet exists.
  assert.equal(resolveSwingOutcome(options).status, "BLOCKED");
  options.resolvedAt = "2026-10-15T13:00:00.000Z";
  assert.equal(resolveSwingOutcome(options).status, "BLOCKED");
  const observed = copy(resolveSwingOutcome(outcomeOptions()));
  observed.resolvedAt = "2026-10-15T13:00:00.000Z";
  assert.equal(validateSwingOutcome(rehashOutcome(observed), { forecast: options.forecast }).valid, false);
});

test("outcome schema/hash and rehashed forbidden claims are rejected", () => {
  const options = outcomeOptions(), original = resolveSwingOutcome(options);
  assert.equal(validateSwingOutcome({ ...original, outcomeHash: "0".repeat(64) }).valid, false);
  for (const edit of [
    o => { o.schemaVersion = "v9"; },
    o => { o.forecastHash = "1".repeat(64); }, o => { o.netReturn = 0.04; },
    o => { o.actualFill = 100; }, o => { o.forTraining = true; }, o => { o.status = "MATURE"; },
    o => { o.grossReturn = 5; }, o => { o.entryAt = options.forecast.createdAt; },
  ]) {
    const altered = copy(original); edit(altered);
    assert.equal(validateSwingOutcome(altered, { forecast: options.forecast }).valid, false);
    assert.equal(validateSwingOutcome(rehashOutcome(altered), { forecast: options.forecast }).valid, false);
  }
});

function splitRow(id, date, labelStartDate, labelEndDate, availableDate = labelEndDate) {
  return { id, observedDate: date, createdAt: `${date}T08:00:00.000Z`, inputsAvailableAt: `${date}T07:00:00.000Z`, labelStartAt: `${labelStartDate}T00:00:00.000Z`, labelEndAt: `${labelEndDate}T06:30:00.000Z`, labelAvailableAt: `${availableDate}T09:00:00.000Z` };
}
function splitOptions() {
  return { trainingCutoff: "2026-10-12T12:00:00.000Z", testStartDate: "2026-10-13", testEndDate: "2026-10-15", rows: [
    splitRow("trainA", "2026-10-01", "2026-10-02", "2026-10-08"),
    splitRow("trainB", "2026-10-01", "2026-10-02", "2026-10-08"),
    splitRow("overlap", "2026-10-09", "2026-10-12", "2026-10-16", "2026-10-19"),
    splitRow("sameDateSafe", "2026-10-09", "2026-10-10", "2026-10-12"),
    splitRow("lateReceipt", "2026-10-05", "2026-10-06", "2026-10-09", "2026-10-13"),
    splitRow("testA", "2026-10-13", "2026-10-14", "2026-10-20", "2026-10-21"),
    splitRow("testB", "2026-10-13", "2026-10-14", "2026-10-20", "2026-10-21"),
  ] };
}

test("chronological label-window purge removes whole date groups and late-publication labels", () => {
  const options = splitOptions(), split = createPurgedChronologicalSplit(options);
  assert.deepEqual(split.train.map(row => row.id), ["trainA", "trainB"]);
  assert.deepEqual(split.test.map(row => row.id), ["testA", "testB"]);
  assert.deepEqual(split.trainingDateGroups, ["2026-10-01"]);
  assert.deepEqual(split.testDateGroups, ["2026-10-13"]);
  assert.equal(split.independentUnit, "OBSERVATION_DATE_NOT_TICKER_ROW");
  assert.equal(split.forTraining, false);
  assert.ok(split.purged.find(row => row.id === "overlap").reasons.includes("OVERLAPPING_TRAIN_TEST_LABEL_WINDOW"));
  assert.ok(split.purged.find(row => row.id === "sameDateSafe").reasons.includes("OVERLAPPING_TRAIN_TEST_LABEL_WINDOW"));
  assert.ok(split.purged.find(row => row.id === "lateReceipt").reasons.includes("AVAILABLE_AFTER_TRAINING_CUTOFF"));
  options.rows.reverse();
  assert.deepEqual(createPurgedChronologicalSplit(options), split);
});

test("split rejects reversed periods, duplicate rows, backdated/ill-formed labels and unknown availability", () => {
  for (const edit of [
    o => { o.trainingCutoff = "2026-10-13T01:00:00.000Z"; },
    o => { o.testEndDate = "2026-10-12"; }, o => { o.rows.push(copy(o.rows[0])); },
    o => { o.rows[0].labelAvailableAt = null; },
    o => { o.rows[0].inputsAvailableAt = "2026-10-01T09:00:00.000Z"; },
    o => { o.rows[0].labelStartAt = o.rows[0].createdAt; },
    o => { o.rows[0].labelAvailableAt = "2026-10-07T08:00:00.000Z"; },
  ]) {
    const options = splitOptions(); edit(options);
    assert.throws(() => createPurgedChronologicalSplit(options));
  }
});
