import assert from "node:assert/strict";
import { createExecutionReturns, resolveExecutionReturnsByPolicy, resolveExecutionReturns } from "../lib/execution-return-resolver.mjs";

const dates = {};
for (let offset = 0; offset < 50; offset += 1) {
  const cursor = new Date("2026-01-02T00:00:00Z"); cursor.setUTCDate(cursor.getUTCDate() + offset);
  const date = cursor.toISOString().slice(0, 10);
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  dates[date] = { status: weekday === 0 || weekday === 6 ? "marketClosed" : "tradingDay", marketPriceLedger: weekday === 0 || weekday === 6 ? "notRequired" : "created", modelSnapshot: "created" };
}
dates["2026-01-05"] = { status: "marketClosed", marketPriceLedger: "notRequired", modelSnapshot: "notRequired" };
const calendar = { schemaVersion: 1, dates };
const tradingDates = Object.entries(dates).filter(([, value]) => value.status === "tradingDay").map(([date]) => date);
const ledgers = new Map(tradingDates.map((date, index) => [date, { date, recordsByCode: new Map([["000001", { code: "000001", openPrice: 100 + index, closePrice: 101 + index, executable: true }]]) }]));
const snapshot = { schemaVersion: 6, asOfDate: "2026-01-02", signalAvailableAt: "2026-01-05T13:00:00+09:00", sourceAvailabilityStatus: "OBSERVED", timingEvidence: { publication: "POLICY_ESTIMATED", collection: "OBSERVED" }, records: [] };
const record = { code: "000001", futureReturns: { future1dReturn: 7 }, backtestReturns: { returns: { nextOpenToT1CloseReturn: 8 } } };
const result = resolveExecutionReturnsByPolicy(record, snapshot, ledgers, calendar);
assert.equal(result.entry.date, "2026-01-07", "휴장일을 제외한 두 번째 검증 거래일이어야 합니다.");
assert.equal(result.entry.timestamp, "2026-01-07T09:00:00+09:00");
assert.equal(result.exits.h1.date, "2026-01-07");
assert.equal(result.exits.h5.date, "2026-01-13");
assert.equal(result.exits.h20.date, "2026-02-03");
assert.equal(result.returns.holding1dReturn, Number(((result.exits.h1.closePrice / result.entry.openPrice - 1) * 100).toFixed(6)));
assert.equal(record.futureReturns.future1dReturn, 7);
assert.equal(record.backtestReturns.returns.nextOpenToT1CloseReturn, 8);

const equalTiming = resolveExecutionReturnsByPolicy({ code: "000001" }, { ...snapshot, signalAvailableAt: "2026-01-07T09:00:00+09:00" }, ledgers, calendar);
assert.equal(equalTiming.timingValidationStatus, "INVALID");
const lateTiming = resolveExecutionReturnsByPolicy({ code: "000001" }, { ...snapshot, signalAvailableAt: "2026-01-07T09:00:01+09:00" }, ledgers, calendar);
assert.equal(lateTiming.status, "timingInvalid");
const earlyTiming = resolveExecutionReturnsByPolicy({ code: "000001" }, snapshot, ledgers, calendar);
assert.equal(earlyTiming.timingValidationStatus, "VALID");
assert.equal(earlyTiming.timingEvidenceLevel, "POLICY_ESTIMATED");

const pendingCalendar = { schemaVersion: 1, dates: { "2026-01-03": dates["2026-01-03"], "2026-01-04": dates["2026-01-04"] } };
assert.equal(resolveExecutionReturnsByPolicy({ code: "000001" }, snapshot, new Map(), pendingCalendar).status, "pendingFutureTradingDay");
const unchecked = structuredClone(calendar); unchecked.dates["2026-01-06"] = { status: "unchecked", marketPriceLedger: "missing", modelSnapshot: "missing" };
assert.equal(resolveExecutionReturnsByPolicy({ code: "000001" }, snapshot, ledgers, unchecked).status, "unchecked");
const failed = structuredClone(calendar); failed.dates["2026-01-06"] = { status: "collectionFailed", marketPriceLedger: "failed", modelSnapshot: "failed" };
assert.equal(resolveExecutionReturnsByPolicy({ code: "000001" }, snapshot, ledgers, failed).status, "collectionFailed");
const missingOpen = new Map(ledgers); missingOpen.set("2026-01-07", { date: "2026-01-07", recordsByCode: new Map([["000001", { code: "000001", openPrice: null, closePrice: 100, executable: true }]]) });
assert.equal(resolveExecutionReturnsByPolicy({ code: "000001" }, snapshot, missingOpen, calendar).resolution.entryStatus, "missingEntryOpenPrice");

const mutableSnapshot = { ...snapshot, records: [{ ...record, executionReturnsByPolicy: { "public-eod-t2-open-v1": createExecutionReturns(snapshot.asOfDate, snapshot.signalAvailableAt) } }] };
const first = resolveExecutionReturns([structuredClone(mutableSnapshot)], [...ledgers.values()], calendar);
const second = resolveExecutionReturns(first.snapshots, [...ledgers.values()], calendar);
assert.deepEqual(second.snapshots, first.snapshots, "반복 실행은 멱등이어야 합니다.");
assert.deepEqual(second.changedDates, []);
console.log("public-eod-t2-open-v1 T+2/H1/H5/H20/timing/멱등성 테스트 통과");
