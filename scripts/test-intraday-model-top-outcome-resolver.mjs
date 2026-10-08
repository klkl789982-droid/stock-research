import assert from "node:assert/strict";
import { resolveIntradayModelTopOutcomes, validateIntradayModelTopOutcomes } from "../lib/intraday-model-top-outcome-resolver.mjs";
import { buildIntradayModelTopPerformance } from "../lib/model-top-performance.mjs";

const dates = ["2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09", "2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16"];
const calendar = (through) => ({ dates: Object.fromEntries(dates.slice(0, through).map((date) => [date, { status: "tradingDay" }])) });
const ledgers = dates.map((date, index) => ({ date, recordsByCode: new Map([["000001", { code: "000001", openPrice: 100 + index, closePrice: 101 + index, executable: true }]]) }));
const signal = { schemaVersion: 1, artifactType: "intradayModelTopOfficialSignal", observationType: "LIVE_OBSERVATION", status: "READY", signalDate: "2026-10-06", officialSignalTime: "14:30:00", contentHash: "signal-hash", records: [{ ticker: "000001", companyName: "A", dataStatus: "AVAILABLE", ranks: { "A-v1": 1, "B-v1": 2, "C-v1": 21, "D-v1": 3 }, observationIds: { "A-v1": "a", "B-v1": "b", "C-v1": "c", "D-v1": "d" } }] };

const pending = resolveIntradayModelTopOutcomes({ signal, priceLedgers: ledgers.slice(0, 1), tradingCalendar: calendar(1), resolvedAt: "2026-10-06T12:00:00Z" });
assert.deepEqual(validateIntradayModelTopOutcomes(pending), []);
assert.equal(pending.records.length, 3);
assert.equal(pending.records[0].entry.status, "PENDING");
assert.equal(pending.records[0].horizons["1DAY"].status, "PENDING");

const oneDay = resolveIntradayModelTopOutcomes({ signal, existing: pending, priceLedgers: ledgers.slice(0, 2), tradingCalendar: calendar(2), resolvedAt: "2026-10-07T12:00:00Z" });
assert.equal(oneDay.records[0].entry.tradingDate, "2026-10-07");
assert.equal(oneDay.records[0].entry.price, 101);
assert.equal(oneDay.records[0].horizons["1DAY"].status, "MATURE");
assert.equal(oneDay.records[0].horizons["5DAY"].status, "PENDING");
assert.equal(oneDay.records[0].horizons["1DAY"].returnPercent, Number(((102 / 101 - 1) * 100).toFixed(6)));

const beforeClose = resolveIntradayModelTopOutcomes({ signal, existing: pending, priceLedgers: ledgers.slice(0, 2), tradingCalendar: calendar(2), resolvedAt: "2026-10-07T05:00:00Z" });
assert.equal(beforeClose.records[0].entry.status, "MATURE");
assert.equal(beforeClose.records[0].horizons["1DAY"].status, "PENDING");
assert.equal(beforeClose.records[0].horizons["1DAY"].reason, "targetCloseNotYetObserved", "장 마감 전에는 미래 종가를 MATURE로 사용하면 안 됩니다.");

const fiveDay = resolveIntradayModelTopOutcomes({ signal, existing: oneDay, priceLedgers: ledgers.slice(0, 6), tradingCalendar: calendar(6), resolvedAt: "2026-10-13T12:00:00Z" });
assert.equal(fiveDay.records[0].horizons["5DAY"].status, "MATURE");
assert.equal(fiveDay.records[0].horizons["5DAY"].targetTradingDate, "2026-10-13");
assert.deepEqual(fiveDay.records[0].horizons["1DAY"], oneDay.records[0].horizons["1DAY"], "이미 성숙한 결과는 바뀌면 안 됩니다.");

const missing = resolveIntradayModelTopOutcomes({ signal, priceLedgers: [], tradingCalendar: calendar(2), resolvedAt: "2026-10-07T12:00:00Z" });
assert.equal(missing.records[0].entry.status, "DATA_MISSING");
assert.equal(missing.records[0].horizons["1DAY"].status, "DATA_MISSING");
const missingCalendar = resolveIntradayModelTopOutcomes({ signal, priceLedgers: ledgers.slice(0, 3), tradingCalendar: { dates: { "2026-10-06": { status: "tradingDay" }, "2026-10-08": { status: "tradingDay" } } }, resolvedAt: "2026-10-08T12:00:00Z" });
assert.equal(missingCalendar.records[0].entry.status, "DATA_MISSING");
assert.equal(missingCalendar.records[0].entry.reason, "missingTradingCalendarStatus");
assert.equal(pending.summary["1DAY"].sampleCount, 0);
assert.equal(oneDay.summary["1DAY"].sampleCount, 3);
const performance = buildIntradayModelTopPerformance({ outcomes: [oneDay] });
assert.equal(performance.layer, "INTRADAY_1430_LIVE");
assert.equal(performance.summary.find((model) => model.modelVersion === "A-v1").groups.find((group) => group.topN === 5).horizons.find((horizon) => horizon.horizon === "1DAY").observationCount, 1);
assert.equal(performance.summary.find((model) => model.modelVersion === "A-v1").groups.find((group) => group.topN === 5).horizons.find((horizon) => horizon.horizon === "60DAY").status, "ACCUMULATING");
const a1 = performance.summary.find((model) => model.modelVersion === "A-v1").groups.find((group) => group.topN === 5).horizons.find((horizon) => horizon.horizon === "1DAY");
assert.equal(a1.expectedObservationCount, 1);
assert.equal(a1.coverageRate, 100);
assert.equal(a1.signalDateCount, 1);
const partialOutcome = structuredClone(oneDay);
partialOutcome.records.push({ ...structuredClone(partialOutcome.records[0]), observationId: "a-pending", rank: 2, horizons: Object.fromEntries(Object.entries(partialOutcome.records[0].horizons).map(([horizon, value]) => [horizon, { ...value, status: "PENDING", returnPercent: null }])) });
const partialPerformance = buildIntradayModelTopPerformance({ outcomes: [partialOutcome] });
const partialA1 = partialPerformance.summary.find((model) => model.modelVersion === "A-v1").groups.find((group) => group.topN === 5).horizons.find((horizon) => horizon.horizon === "1DAY");
assert.equal(partialA1.observationCount, 1, "실제 MATURE 종목만 성과 표본으로 집계해야 합니다.");
assert.equal(partialA1.expectedObservationCount, 2);
assert.equal(partialA1.coverageRate, 50);
console.log("intraday 14:30 T+1 open execution · 1/5/20/60D maturity · isolation tests passed");
