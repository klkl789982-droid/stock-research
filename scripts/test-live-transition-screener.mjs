import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  buildLiveTransitionRows, LIVE_NEAR_PERCENT_DEFAULT, LIVE_TRANSITION_RULE_VERSION,
  observeLiveGoldenTransition, parseLiveTransitionFilters, screenLiveTransitions,
  validateLiveTransitionSources,
} from "../lib/live-transition-screener.mjs";
import { createLiveTransitionStore } from "../lib/live-transition-store.mjs";
import { hashIntradayModelTop } from "../lib/intraday-model-top-official-signal.mjs";
import { intradaySeedHash } from "../lib/intraday-market-seed.mjs";

// Never use wall-clock freshness or edit the committed production observations.
const REPO = fileURLToPath(new URL("../", import.meta.url));
const NOW = "2026-10-13T06:00:00.000Z";
const FILES = {
  latest: "data/intraday-signals/model-top/latest.json",
  signal: "data/intraday-signals/model-top/2026-10-13/1430.json",
  seed: "data/analysis/market-seeds/2026-10-12.json",
  history: "data/history/2026-10-12.json",
  calendar: "data/trading-calendar/status.json",
};
const raw = Object.fromEntries(await Promise.all(Object.entries(FILES).map(async ([key, relative]) => [key, await readFile(path.join(REPO, relative))])));
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const originalHashes = Object.fromEntries(Object.entries(raw).map(([key, bytes]) => [key, digest(bytes)]));
function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
const fixture = deepFreeze({ ...Object.fromEntries(Object.entries(raw).map(([key, bytes]) => [key, JSON.parse(bytes)])), now: NOW });
function resign(value, hash) {
  const { contentHash: ignored, ...base } = value;
  void ignored;
  return { ...base, contentHash: hash(base) };
}
function withSignal(change, base = fixture) {
  const signal = structuredClone(base.signal);
  change(signal);
  const signed = resign(signal, hashIntradayModelTop);
  return { ...base, signal: signed, latest: { ...base.latest, signalDate: signed.signalDate,
    signalPath: `data/intraday-signals/model-top/${signed.signalDate}/1430.json`, contentHash: signed.contentHash } };
}
function withSeed(change, base = fixture) {
  const seed = structuredClone(base.seed);
  change(seed);
  const signed = resign(seed, intradaySeedHash);
  return withSignal((signal) => { signal.source.seedHash = signed.contentHash; }, { ...base, seed: signed });
}
const throwsReason = (fn, reason) => assert.throws(fn, { message: reason });
const rowsOf = (closes) => closes.map((close, index) => [`row-${index}`, close, close, close, close, 1]);
const filters = (query = "") => parseLiveTransitionFilters(new URLSearchParams(query));
const closeEnough = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);
function boundaryRows(pair) {
  const [short, long] = pair.split("-").map(Number);
  const closes = Array(long).fill(99);
  closes[long - 2] += 2 * (long - short) / short;
  closes[long - 1] = 100;
  return rowsOf(closes); // Both pairs have the exact equality boundary X_cross = 101.
}

await test("LIVE moving-average math uses closed bars plus exactly one observed price", async (t) => {
  for (const pair of ["5-20", "20-60"]) {
    await t.test(`${pair}: strict crossing, exact equality, formula, and inclusive near threshold`, () => {
      const rows = deepFreeze(boundaryRows(pair));
      const [short, long] = pair.split("-").map(Number);
      const atBoundary = observeLiveGoldenTransition(rows, 101, pair);
      assert.equal(atBoundary.crossRequiredPrice, 101);
      assert.equal(atBoundary.currentShort, atBoundary.currentLong);
      assert.equal(atBoundary.status, "NONE", "Equal lines are neither a crossing nor an approach.");
      assert.equal(observeLiveGoldenTransition(rows, 101.001, pair).status, "CROSS_OCCURRED");
      const near = observeLiveGoldenTransition(rows, 100, pair);
      assert.equal(near.status, "APPROACHING");
      assert.equal(near.requiredAdditionalRisePercent, 1, "Exactly 1% is included, without ratio-subtraction roundoff.");
      assert.ok(near.shortSlopePercent > 0);
      assert.ok(Math.abs(near.gapPercent) < Math.abs(near.previousGapPercent));
      assert.equal(observeLiveGoldenTransition(rows, 100, pair, 0.999999).status, "NONE");
      assert.equal(observeLiveGoldenTransition(rows, 99.5, pair, 1).status, "NONE");
      assert.equal(observeLiveGoldenTransition(rows, 99.5, pair, 2).status, "APPROACHING");
      assert.equal(observeLiveGoldenTransition(rows, 100, pair, 0).status, "NONE");
      assert.equal(observeLiveGoldenTransition(rows, 102, pair, 0).status, "CROSS_OCCURRED");
      const sum = (count) => rows.slice(0, count).reduce((total, row) => total + row[4], 0);
      closeEnough(near.previousShort, sum(short) / short);
      closeEnough(near.previousLong, sum(long) / long);
      closeEnough(near.currentShort, (sum(short - 1) + 100) / short);
      closeEnough(near.currentLong, (sum(long - 1) + 100) / long);
      closeEnough(near.crossRequiredPrice, (short * sum(long - 1) - long * sum(short - 1)) / (long - short));
      assert.deepEqual(observeLiveGoldenTransition([...rows, ...rowsOf([9_999_999])], 100, pair), near, "Older bars cannot affect the pair.");
    });
    await t.test(`${pair}: previous equality can cross, already-above is distinct`, () => {
      const [short, long] = pair.split("-").map(Number);
      assert.equal(observeLiveGoldenTransition(rowsOf(Array(long).fill(100)), 101, pair).status, "CROSS_OCCURRED");
      assert.equal(observeLiveGoldenTransition(rowsOf(Array(long).fill(100)), 100, pair).status, "NONE");
      const above = rowsOf([...Array(short).fill(102), ...Array(long - short).fill(100)]);
      const result = observeLiveGoldenTransition(above, 103, pair);
      assert.equal(result.status, "ALREADY_ABOVE");
      assert.equal(result.requiredAdditionalRisePercent, 0);
      assert.equal(observeLiveGoldenTransition(above, 1, pair).status, "NONE");
    });
  }
  await t.test("a below-line price needs both a shrinking gap and a positive short slope", () => {
    const widening = observeLiveGoldenTransition(rowsOf([...Array(5).fill(99), ...Array(14).fill(100), 95]), 100, "5-20", 5);
    assert.ok(widening.gapPercent < 0 && widening.shortSlopePercent > 0 && widening.requiredAdditionalRisePercent < 5);
    assert.ok(Math.abs(widening.gapPercent) > Math.abs(widening.previousGapPercent));
    assert.equal(widening.status, "NONE");
    for (const price of [100, 99.9]) {
      const noSlope = observeLiveGoldenTransition(rowsOf([...Array(5).fill(100), ...Array(14).fill(101), 110]), price, "5-20", 5);
      assert.ok(noSlope.gapPercent < 0 && Math.abs(noSlope.gapPercent) < Math.abs(noSlope.previousGapPercent));
      assert.ok(noSlope.shortSlopePercent <= 0 && noSlope.requiredAdditionalRisePercent < 5);
      assert.equal(noSlope.status, "NONE");
    }
  });
  await t.test("5/20 and 20/60 remain independent on the same series", () => {
    const rows = [...boundaryRows("5-20"), ...rowsOf(Array(40).fill(200))];
    assert.equal(observeLiveGoldenTransition(rows, 102, "5-20").status, "CROSS_OCCURRED");
    assert.equal(observeLiveGoldenTransition(rows, 102, "20-60").status, "NONE");
  });
  await t.test("invalid filters and missing/nonpositive moving-average inputs fail closed", () => {
    for (const pair of ["5-60", "toString", "__proto__", "constructor"]) throwsReason(() => observeLiveGoldenTransition(boundaryRows("5-20"), 100, pair), "LIVE_FILTER_INVALID");
    for (const threshold of [-1, 5.001, NaN, Infinity, "1"]) throwsReason(() => observeLiveGoldenTransition(boundaryRows("5-20"), 100, "5-20", threshold), "LIVE_FILTER_INVALID");
    for (const price of [0, -1, NaN, Infinity, null, "100"]) throwsReason(() => observeLiveGoldenTransition(boundaryRows("5-20"), price, "5-20"), "LIVE_MA_INPUT_MISSING");
    throwsReason(() => observeLiveGoldenTransition(boundaryRows("5-20").slice(1), 100, "5-20"), "LIVE_MA_INPUT_MISSING");
    for (const close of [0, NaN, null]) {
      const rows = boundaryRows("20-60"); rows[10][4] = close;
      throwsReason(() => observeLiveGoldenTransition(rows, 100, "20-60"), "LIVE_MA_INPUT_MISSING");
    }
  });
});

await test("LIVE source validation is strict about provenance, freshness, and actual sessions", async (t) => {
  await t.test("the real READY observation establishes October 13 despite absent EOD calendar entry", () => {
    assert.equal(fixture.calendar.dates["2026-10-12"].status, "tradingDay");
    assert.equal(fixture.calendar.dates["2026-10-13"], undefined);
    assert.doesNotThrow(() => validateLiveTransitionSources(fixture));
  });
  const cases = [
    ["missing latest", () => ({ ...fixture, latest: null }), "LIVE_SNAPSHOT_MISSING"],
    ...[["FAILED", "LIVE_SNAPSHOT_FAILED"], ["FAILED_COLLECTION", "LIVE_SNAPSHOT_FAILED"], ["WAITING", "LIVE_SNAPSHOT_WAITING"], ["MARKET_CLOSED", "LIVE_MARKET_CLOSED"]]
      .map(([status, reason]) => [`latest ${status} never falls back to lastGood`, () => ({ ...fixture, latest: { ...fixture.latest, status } }), reason]),
    ["missing immutable signal", () => ({ ...fixture, signal: null }), "LIVE_SNAPSHOT_INVALID"],
    ["latest hash mismatch", () => ({ ...fixture, latest: { ...fixture.latest, contentHash: "wrong" } }), "LIVE_SNAPSHOT_INVALID"],
    ["latest date mismatch", () => ({ ...fixture, latest: { ...fixture.latest, signalDate: "2026-10-12" } }), "LIVE_SNAPSHOT_INVALID"],
    ["latest path mismatch", () => ({ ...fixture, latest: { ...fixture.latest, signalPath: "data/intraday-signals/model-top/2026-10-12/1430.json" } }), "LIVE_SNAPSHOT_INVALID"],
    ["corrupt signal content hash", () => ({ ...fixture, signal: { ...fixture.signal, contentHash: "wrong" }, latest: { ...fixture.latest, contentHash: "wrong" } }), "LIVE_SNAPSHOT_INVALID"],
    ["signed non-live fixture", () => withSignal((s) => { s.observationType = "TEST_FIXTURE"; }), "LIVE_SNAPSHOT_INVALID"],
    ["signed failed signal", () => withSignal((s) => { s.status = "FAILED_COLLECTION"; }), "LIVE_SNAPSHOT_INVALID"],
    ["signed wrong provider", () => withSignal((s) => { s.source.provider = "estimated"; }), "LIVE_SNAPSHOT_INVALID"],
    ["signed wrong price calculation basis", () => withSignal((s) => { s.calculationBasis = "sameDayOfficialClose"; }), "LIVE_SNAPSHOT_INVALID"],
    ["duplicate tickers", () => withSignal((s) => { s.records.push(structuredClone(s.records[0])); }), "LIVE_SNAPSHOT_INVALID"],
    ["signed partial record universe", () => withSignal((s) => { s.records = s.records.slice(1); }), "LIVE_SNAPSHOT_INVALID"],
    ["signed incorrect source count", () => withSignal((s) => { s.universe.sourceCount++; }), "LIVE_SNAPSHOT_INVALID"],
    ["signed incorrect eligible count", () => withSignal((s) => { s.universe.eligibleCount++; }), "LIVE_SNAPSHOT_INVALID"],
    ["signed incorrect eligible hash", () => withSignal((s) => { s.universe.eligibleHash = "wrong"; }), "LIVE_SNAPSHOT_INVALID"],
    ["signed collection failures", () => withSignal((s) => { s.collection.failed = 10; }), "LIVE_SNAPSHOT_INVALID"],
    ["signed successful count mismatch", () => withSignal((s) => { s.collection.successful--; }), "LIVE_SNAPSHOT_INVALID"],
    ["signed ineligible count mismatch", () => withSignal((s) => { s.collection.ineligible--; }), "LIVE_SNAPSHOT_INVALID"],
    ["signed unknown ticker", () => withSignal((s) => { s.records[0].ticker = "ZZZZZZ"; }), "LIVE_SNAPSHOT_INVALID"],
    ["eligible seed lacks available quote", () => withSignal((s) => { s.records.find((r) => r.dataStatus === "AVAILABLE").dataStatus = "MISSING"; }), "LIVE_SNAPSHOT_INVALID"],
    ["ineligible seed incorrectly marked available", () => withSignal((s) => { s.records.find((r) => r.dataStatus === "INELIGIBLE").dataStatus = "AVAILABLE"; }), "LIVE_SNAPSHOT_INVALID"],
    ["absent trading calendar", () => ({ ...fixture, calendar: null }), "LIVE_CALENDAR_MISSING"],
    ["observed day explicitly closed", () => ({ ...fixture, calendar: { dates: { ...fixture.calendar.dates, "2026-10-13": { status: "marketClosed" } } } }), "LIVE_MARKET_CLOSED"],
    ["collection started before window", () => withSignal((s) => { s.collectionStartedAt = "2026-10-13T05:29:59.999Z"; }), "LIVE_SNAPSHOT_INVALID"],
    ["collection started after window", () => withSignal((s) => { s.collectionStartedAt = "2026-10-13T05:35:00.001Z"; }), "LIVE_SNAPSHOT_INVALID"],
    ["completion precedes start", () => withSignal((s) => { s.collectionCompletedAt = "2026-10-13T05:30:00.000Z"; }), "LIVE_SNAPSHOT_INVALID"],
    ["invalid current time", () => ({ ...fixture, now: "invalid" }), "LIVE_SNAPSHOT_INVALID"],
    ["future completed snapshot", () => ({ ...fixture, now: "2026-10-13T05:31:00.000Z" }), "LIVE_SNAPSHOT_FUTURE"],
    ["missing exact seed", () => ({ ...fixture, seed: null }), "LIVE_SEED_MISSING"],
    ["missing exact history", () => ({ ...fixture, history: null }), "LIVE_HISTORY_MISSING"],
    ["seed date mismatch", () => ({ ...fixture, seed: { ...fixture.seed, requestedDate: "2026-10-08" } }), "LIVE_PRIOR_TRADING_DAY_UNVERIFIED"],
    ["history date mismatch", () => ({ ...fixture, history: { ...fixture.history, asOfDate: "2026-10-08" } }), "LIVE_PRIOR_TRADING_DAY_UNVERIFIED"],
    ["prior date unverified", () => ({ ...fixture, calendar: { dates: {} } }), "LIVE_PRIOR_TRADING_DAY_UNVERIFIED"],
    ["seed hash mismatch", () => ({ ...fixture, seed: { ...fixture.seed, contentHash: "wrong" } }), "LIVE_SOURCE_MISMATCH"],
    ["signal seed hash mismatch", () => withSignal((s) => { s.source.seedHash = "wrong"; }), "LIVE_SOURCE_MISMATCH"],
    ["signal daily source hash mismatch", () => withSignal((s) => { s.source.seedOfficialDailyHash = "wrong"; }), "LIVE_SOURCE_MISMATCH"],
    ["history daily source hash mismatch", () => ({ ...fixture, history: { ...fixture.history, sourceManifest: { sources: { officialDailyPrice: { normalizedInputHash: "wrong" } } } } }), "LIVE_SOURCE_MISMATCH"],
  ];
  for (const [name, create, reason] of cases) await t.test(name, () => throwsReason(() => validateLiveTransitionSources(create()), reason));
  await t.test("freshness expires exactly at the next potentially open 14:30 KST", () => {
    assert.doesNotThrow(() => validateLiveTransitionSources({ ...fixture, now: "2026-10-14T05:29:59.999Z" }));
    throwsReason(() => validateLiveTransitionSources({ ...fixture, now: "2026-10-14T05:30:00.000Z" }), "LIVE_SNAPSHOT_STALE");
    const holiday = { ...fixture, calendar: { dates: { ...fixture.calendar.dates, "2026-10-14": { status: "marketClosed" } } } };
    assert.doesNotThrow(() => validateLiveTransitionSources({ ...holiday, now: "2026-10-15T05:29:59.999Z" }));
    throwsReason(() => validateLiveTransitionSources({ ...holiday, now: "2026-10-15T05:30:00.000Z" }), "LIVE_SNAPSHOT_STALE");
    const weekend = withSignal((s) => {
      s.signalDate = "2026-10-16"; s.seedReferenceDate = "2026-10-15";
      s.collectionStartedAt = "2026-10-16T05:30:00.000Z"; s.collectionCompletedAt = "2026-10-16T05:31:00.000Z";
    });
    weekend.seed = { ...fixture.seed, requestedDate: "2026-10-15" };
    weekend.history = { ...fixture.history, asOfDate: "2026-10-15" };
    weekend.calendar = { dates: { "2026-10-15": { status: "tradingDay" } } };
    assert.doesNotThrow(() => validateLiveTransitionSources({ ...weekend, now: "2026-10-18T10:00:00.000Z" }));
    throwsReason(() => validateLiveTransitionSources({ ...weekend, now: "2026-10-19T05:30:00.000Z" }), "LIVE_SNAPSHOT_STALE");
  });
  await t.test("prior session skips weekends and a verified holiday, never an unknown weekday", () => {
    // This exercises source/date validation only; no relabelled bars are used for calculations.
    const gap = withSignal((s) => {
      s.signalDate = "2026-10-12"; s.seedReferenceDate = "2026-10-08";
      s.collectionStartedAt = "2026-10-12T05:30:00.000Z"; s.collectionCompletedAt = "2026-10-12T05:31:00.000Z";
    });
    gap.now = "2026-10-12T06:00:00.000Z";
    gap.seed = { ...fixture.seed, requestedDate: "2026-10-08" };
    gap.history = { ...fixture.history, asOfDate: "2026-10-08" };
    assert.equal(gap.calendar.dates["2026-10-09"].status, "marketClosed");
    assert.doesNotThrow(() => validateLiveTransitionSources(gap));
    for (const status of [undefined, "unchecked", "tradingDay"]) {
      const dates = { ...gap.calendar.dates };
      if (status === undefined) delete dates["2026-10-09"]; else dates["2026-10-09"] = { status };
      throwsReason(() => validateLiveTransitionSources({ ...gap, calendar: { dates } }), "LIVE_PRIOR_TRADING_DAY_UNVERIFIED");
    }
    const friday = { ...gap, seed: { ...gap.seed, requestedDate: "2026-10-09" }, history: { ...gap.history, asOfDate: "2026-10-09" }, calendar: { dates: { "2026-10-09": { status: "tradingDay" } } } };
    const weekendOnly = withSignal((s) => { s.seedReferenceDate = "2026-10-09"; }, friday);
    assert.doesNotThrow(() => validateLiveTransitionSources(weekendOnly));
  });
});

const built = buildLiveTransitionRows(fixture);
const usable = built.filter((row) => !row.missingReasons.length);
await test("LIVE rows preserve EOD models and exclude bad quote/history quality", async (t) => {
  await t.test("real saved data produces provisional prices with unchanged EOD scores", () => {
    assert.equal(built.length, fixture.history.records.length);
    assert.ok(usable.length > 0 && usable.length < built.length);
    const row = usable[0], historical = fixture.history.records.find((r) => r.code === row.code);
    const signal = fixture.signal.records.find((r) => r.ticker === row.code);
    assert.equal(row.qualityStatus, "PROVISIONAL");
    assert.equal(row.referenceDate, "2026-10-13");
    assert.equal(row.modelReferenceDate, "2026-10-12");
    assert.equal(row.observedPrice, signal.provisionalOhlcv.close);
    assert.equal(row.models["A-v1"].score, historical.scoresByVersion["A-v1"]);
    assert.equal(row.models["B-v1"].score, historical.scores.modelB);
    assert.notEqual(row.models["A-v1"].score, signal.scores["A-v1"], "LIVE model scores must not replace the fixed prior-EOD scores.");
    assert.equal(row.closedRows.length, 60);
    assert.equal(row.closedRows[0][0], "20261012");
    assert.ok(built.filter((r) => r.missingReasons.length).every((r) => r.qualityStatus === "UNAVAILABLE" && !("observedPrice" in r)));
    assert.deepEqual(buildLiveTransitionRows(fixture), built);
  });
  await t.test("signed invalid quotes are exclusions, never filled in with official or estimated prices", () => {
    const cases = [
      ["quote absent", (r) => { r.quote = null; }, "liveQuoteTimestampInvalid"],
      ["wrong provider", (r) => { r.quote.source = "estimated"; }, "liveQuoteTimestampInvalid"],
      ["wrong date", (r) => { r.quote.asOfDate = "2026-10-12"; }, "liveQuoteTimestampInvalid"],
      ["before window", (r) => { r.quote.asOfTime = "14:29:59"; }, "liveQuoteTimestampInvalid"],
      ["after window", (r) => { r.quote.asOfTime = "14:35:01"; }, "liveQuoteTimestampInvalid"],
      ["malformed clock", (r) => { r.quote.asOfTime = "14:3:01"; }, "liveQuoteTimestampInvalid"],
      ["invalid seconds", (r) => { r.quote.asOfTime = "14:30:99"; }, "liveQuoteStaleOrInvalid"],
      ["received before quote", (r) => { r.quote.receivedAt = "2026-10-13T05:29:59.999Z"; }, "liveQuoteStaleOrInvalid"],
      ["exactly 60 seconds stale", (r) => { r.quote.asOfTime = "14:30:00"; r.quote.receivedAt = "2026-10-13T05:31:00.000Z"; }, "liveQuoteStaleOrInvalid"],
      ["before collection", (r) => { r.quote.asOfTime = "14:30:00"; r.quote.receivedAt = "2026-10-13T05:30:00.000Z"; }, "liveQuoteStaleOrInvalid"],
      ["after collection", (r) => { r.quote.asOfTime = "14:32:40"; r.quote.receivedAt = "2026-10-13T05:32:40.340Z"; }, "liveQuoteStaleOrInvalid"],
      ["invalid received date", (r) => { r.quote.receivedAt = "not-a-date"; }, "liveQuoteStaleOrInvalid"],
      ["candle absent", (r) => { r.provisionalOhlcv = null; }, "liveQuoteOhlcvInvalid"],
      ["no trades", (r) => { r.provisionalOhlcv.volume = 0; }, "liveQuoteOhlcvInvalid"],
      ["zero price", (r) => { r.provisionalOhlcv.close = 0; }, "liveQuoteOhlcvInvalid"],
      ["string price", (r) => { r.provisionalOhlcv.close = "100"; }, "liveQuoteOhlcvInvalid"],
      ["missing low", (r) => { r.provisionalOhlcv.low = null; }, "liveQuoteOhlcvInvalid"],
      ["high below close", (r) => { r.provisionalOhlcv.high = r.provisionalOhlcv.close - 1; }, "liveQuoteOhlcvInvalid"],
      ["low above open", (r) => { r.provisionalOhlcv.low = r.provisionalOhlcv.open + 1; }, "liveQuoteOhlcvInvalid"],
    ];
    const expectations = new Map();
    const changed = withSignal((signal) => {
      cases.forEach(([name, mutate, reason], index) => {
        const code = usable[index].code, record = signal.records.find((r) => r.ticker === code);
        expectations.set(code, { name, reason });
        mutate(record);
      });
    });
    const rows = buildLiveTransitionRows(changed);
    for (const [code, { name, reason }] of expectations) {
      const row = rows.find((r) => r.code === code);
      assert.ok(row.missingReasons.includes(reason), name);
      assert.equal(row.qualityStatus, "UNAVAILABLE", name);
      assert.equal(row.observedPrice, undefined, name);
    }
    assert.equal(rows.filter((r) => !r.missingReasons.length).length, usable.length - cases.length);
    const result = screenLiveTransitions(rows, filters("state=all"));
    assert.equal(result.results.length, usable.length - cases.length);
    for (const { reason } of expectations.values()) assert.ok(result.reasonCounts[reason] > 0);
  });
  await t.test("59.999-second quotes and exact collection endpoints are allowed", () => {
    const changed = withSignal((signal) => {
      const codes = usable.slice(0, 3).map((row) => row.code);
      const pairs = [["14:30:00", "2026-10-13T05:30:59.999Z"], ["14:30:00", signal.collectionStartedAt], ["14:32:40", signal.collectionCompletedAt]];
      for (let i = 0; i < codes.length; i++) Object.assign(signal.records.find((r) => r.ticker === codes[i]).quote, { asOfTime: pairs[i][0], receivedAt: pairs[i][1] });
    });
    const rows = buildLiveTransitionRows(changed);
    for (const row of usable.slice(0, 3)) assert.deepEqual(rows.find((r) => r.code === row.code).missingReasons, []);
  });
  await t.test("history structural rejection and tampered seed fail the whole source", () => {
    throwsReason(() => buildLiveTransitionRows({ ...fixture, history: { ...fixture.history, dataQuality: { ...fixture.history.dataQuality, structuralStatus: "failed" } } }), "LIVE_HISTORY_INVALID");
    const seed = structuredClone(fixture.seed); seed.records.find((r) => r.eligible).rows[0][4]++;
    throwsReason(() => buildLiveTransitionRows({ ...fixture, seed }), "LIVE_HISTORY_INVALID");
  });
  await t.test("per-symbol quarantine, official close mismatch, and missing bars remain exclusions", () => {
    const history = structuredClone(fixture.history);
    history.records.find((r) => r.code === usable[0].code).qualityEligibility.eligible = false;
    history.records.find((r) => r.code === usable[1].code).closePrice++;
    const changed = withSeed((seed) => {
      const rows = seed.records.find((r) => r.code === usable[2].code).rows;
      rows.splice(1, 1); rows.push(["20200102", 100, 100, 100, 100, 1]);
    }, { ...fixture, history });
    const rows = buildLiveTransitionRows(changed);
    for (const [index, reason] of ["qualityIneligible", "officialCloseMismatch", "missingTradingBar"].entries()) assert.ok(rows.find((r) => r.code === usable[index].code).missingReasons.includes(reason));
  });
});

await test("LIVE filters and candidate screening have a bounded independent contract", async (t) => {
  await t.test("defaults, both pairs, all supported states, and strict threshold parsing", () => {
    assert.deepEqual(filters(), { pair: "5-20", state: "candidates", market: "all", code: null, nearPercent: LIVE_NEAR_PERCENT_DEFAULT });
    for (const state of ["all", "candidates", "CROSS_OCCURRED", "APPROACHING", "ALREADY_ABOVE", "NONE"]) assert.equal(filters(`state=${state}`).state, state);
    for (const value of ["0", ".5", "1", "2.5", "5"]) assert.equal(filters(`nearPercent=${value}`).nearPercent, Number(value));
    assert.equal(filters("pair=20-60&market=KOSDAQ&code=0009K0").code, "0009K0");
    for (const query of ["pair=toString", "pair=__proto__", "pair=5-60", "state=CONFIRMED", "state=DEAD_CROSS", "market=NYSE", "code=1", "code=abcdef", "nearPercent=", "nearPercent=-1", "nearPercent=5.001", "nearPercent=NaN", "nearPercent=Infinity", "nearPercent=0x1", "nearPercent=1e0", "nearPercent=+1", "nearPercent=%201"]) throwsReason(() => filters(query), "LIVE_FILTER_INVALID");
  });
  await t.test("candidates exclude already-above, preserve ordering, and never expose closed rows", () => {
    const make = (code, price, market = "KOSPI", rows = boundaryRows("5-20")) => ({ code, market, observedPrice: price, closedRows: rows, missingReasons: [], qualityStatus: "PROVISIONAL" });
    const rows = [make("000005", 99), make("000003", 100), make("000002", 102, "KOSDAQ"), make("000001", 102), make("000004", 103, "KOSPI", rowsOf([...Array(5).fill(102), ...Array(15).fill(100)])), { code: "000006", market: "KOSPI", missingReasons: ["liveQuoteUnavailable"], qualityStatus: "UNAVAILABLE" }];
    const candidates = screenLiveTransitions(rows, filters());
    assert.deepEqual(candidates.results.map((r) => r.code), ["000001", "000002", "000003"]);
    assert.deepEqual(candidates.exclusions, { dataMissing: 1, conditionNotMet: 2 });
    assert.deepEqual(candidates.reasonCounts, { liveQuoteUnavailable: 1 });
    assert.ok(candidates.results.every((r) => !("closedRows" in r)));
    assert.equal(screenLiveTransitions(rows, filters("state=all")).results.length, 5);
    assert.equal(screenLiveTransitions(rows, filters("state=ALREADY_ABOVE")).results[0].code, "000004");
    assert.equal(screenLiveTransitions(rows, filters("market=KOSDAQ")).results[0].code, "000002");
    assert.deepEqual(screenLiveTransitions(rows, filters("code=000003")).exclusions, { dataMissing: 0, conditionNotMet: 0 });
    assert.equal(screenLiveTransitions(rows, filters("code=000005")).results.length, 0);
    assert.equal(screenLiveTransitions(rows, filters("code=000005&state=NONE")).results.length, 1);
  });
});

await test("disk store reads the exact immutable signal and prior seed, with no fallback or lookahead", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tb-live-transition-test-"));
  const write = async (relative, value) => {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value));
  };
  const load = createLiveTransitionStore({ root, now: () => new Date(NOW) });
  const mutation = async (key, value, reason) => {
    try {
      if (value === null) await rm(path.join(root, FILES[key])); else await write(FILES[key], value);
      await assert.rejects(load(), { message: reason });
    } finally { await write(FILES[key], raw[key]); }
  };
  try {
    for (const [key, relative] of Object.entries(FILES)) await write(relative, raw[key]);
    const baseline = await load();
    await t.test("repeat reads share the cached object and concurrent cold reads share a single result", async () => {
      assert.strictEqual(await load(), baseline);
      const [one, two, three] = await Promise.all([load(), load(), load()]);
      assert.strictEqual(one, baseline); assert.strictEqual(two, baseline); assert.strictEqual(three, baseline);
      const cold = createLiveTransitionStore({ root, now: () => new Date(NOW) });
      const [first, second, third] = await Promise.all([cold(), cold(), cold()]);
      assert.strictEqual(first, second); assert.strictEqual(second, third);
      assert.strictEqual(await cold(), first);
      assert.deepEqual(first, baseline);
    });
    await t.test("saved response exposes provenance and frozen model reference, without claiming streaming", () => {
      assert.equal(baseline.mode, "LIVE");
      assert.equal(baseline.referenceDate, "2026-10-13");
      assert.equal(baseline.previousOfficialDate, "2026-10-12");
      assert.equal(baseline.modelReferenceDate, "2026-10-12");
      assert.equal(baseline.snapshotTime, "14:30:00");
      assert.equal(baseline.ruleVersion, LIVE_TRANSITION_RULE_VERSION);
      assert.equal(baseline.source.signalContentHash, fixture.signal.contentHash);
      assert.equal(baseline.source.seedContentHash, fixture.seed.contentHash);
      assert.equal(baseline.source.normalizedInputHash, fixture.signal.source.seedOfficialDailyHash);
      assert.equal(baseline.source.priceBasis, "kisLastQuoteAtCollection");
      assert.equal(baseline.source.isRealtime, false);
      assert.equal(baseline.isPartialRanking, fixture.history.isPartialRanking === true);
      assert.equal(baseline.sourceQualityGrade, fixture.history.dataQuality.overallGrade);
      assert.deepEqual(baseline.rows, built);
    });
    await t.test("later EOD files and previous fallback files are never read", async () => {
      for (const date of ["2026-10-08", "2026-10-13", "2099-12-31"]) {
        await write(`data/history/${date}.json`, "not JSON: this file must not be read");
        await write(`data/analysis/market-seeds/${date}.json`, "not JSON: this file must not be read");
      }
      assert.deepEqual(await load(), baseline);
      const cold = createLiveTransitionStore({ root, now: () => new Date(NOW) });
      assert.deepEqual(await cold(), baseline, "A cold store must also ignore later EOD files.");
    });
    for (const [key, reason] of [["latest", "LIVE_SNAPSHOT_MISSING"], ["signal", "LIVE_SNAPSHOT_MISSING"], ["seed", "LIVE_SEED_MISSING"], ["history", "LIVE_HISTORY_MISSING"], ["calendar", "LIVE_CALENDAR_MISSING"]]) {
      await t.test(`missing exact ${key} cannot fall back`, () => mutation(key, null, reason));
      await t.test(`malformed ${key} fails closed`, () => mutation(key, "{invalid JSON", reason));
    }
    for (const [status, reason] of [["FAILED", "LIVE_SNAPSHOT_FAILED"], ["WAITING", "LIVE_SNAPSHOT_WAITING"], ["MARKET_CLOSED", "LIVE_MARKET_CLOSED"]]) await t.test(`${status} latest does not expose lastGood`, () => mutation("latest", { ...fixture.latest, status }, reason));
    await t.test("path traversal is rejected before file reads", () => mutation("latest", { ...fixture.latest, signalPath: "../../outside.json" }, "LIVE_SNAPSHOT_INVALID"));
    await t.test("latest hash mismatch is unavailable", () => mutation("latest", { ...fixture.latest, contentHash: "wrong" }, "LIVE_SNAPSHOT_INVALID"));
    await t.test("signal content corruption is unavailable", () => mutation("signal", { ...fixture.signal, priceBasis: "corrupt" }, "LIVE_SNAPSHOT_INVALID"));
    await t.test("seed hash mismatch is unavailable", () => mutation("seed", { ...fixture.seed, contentHash: "wrong" }, "LIVE_SOURCE_MISMATCH"));
    await t.test("stale snapshots fail even when all source files exist", async () => {
      const stale = createLiveTransitionStore({ root, now: () => new Date("2026-10-14T05:30:00.000Z") });
      await assert.rejects(stale(), { message: "LIVE_SNAPSHOT_STALE" });
    });
    await t.test("cached data expires as the injected current time crosses the next observation time", async () => {
      let currentTime = NOW;
      const advancing = createLiveTransitionStore({ root, now: () => new Date(currentTime) });
      const cached = await advancing();
      currentTime = "2026-10-14T05:29:59.999Z";
      assert.strictEqual(await advancing(), cached);
      currentTime = "2026-10-14T05:30:00.000Z";
      await assert.rejects(advancing(), { message: "LIVE_SNAPSHOT_STALE" });
    });
    await t.test("failed latest is observed after a prior successful read", async () => {
      const cached = await load();
      assert.strictEqual(await load(), cached);
      await mutation("latest", { ...fixture.latest, status: "FAILED", failureStage: "validation" }, "LIVE_SNAPSHOT_FAILED");
      assert.deepEqual(await load(), baseline);
    });
    await t.test("history repairs invalidate cached rows and expose the new EOD score", async () => {
      const cached = await load(), history = structuredClone(fixture.history);
      history.records.find((r) => r.code === usable[0].code).scoresByVersion["A-v1"] = 100.123;
      try {
        await write(FILES.history, history);
        const updated = await load();
        assert.notStrictEqual(updated, cached);
        assert.equal(updated.rows.find((r) => r.code === usable[0].code).models["A-v1"].score, 100.123);
        assert.strictEqual(await load(), updated);
      } finally { await write(FILES.history, raw.history); }
      assert.deepEqual(await load(), baseline);
    });
    await t.test("seed-only tampering invalidates a warm cache even when its declared hash is unchanged", async () => {
      const cached = await load(), seed = structuredClone(fixture.seed);
      assert.strictEqual(await load(), cached);
      seed.generatedAt = "2026-10-13T00:00:00.123Z";
      await mutation("seed", seed, "LIVE_HISTORY_INVALID");
      assert.deepEqual(await load(), baseline);
    });
    await t.test("prior-session calendar repairs invalidate the cached date validation", async () => {
      const cached = await load(), calendar = structuredClone(fixture.calendar);
      assert.strictEqual(await load(), cached);
      calendar.dates["2026-10-12"].status = "unchecked";
      await mutation("calendar", calendar, "LIVE_PRIOR_TRADING_DAY_UNVERIFIED");
      assert.deepEqual(await load(), baseline);
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});

await test("committed LIVE/EOD/calendar fixtures remain byte-for-byte unchanged", async () => {
  for (const [key, relative] of Object.entries(FILES)) assert.equal(digest(await readFile(path.join(REPO, relative))), originalHashes[key], relative);
});
