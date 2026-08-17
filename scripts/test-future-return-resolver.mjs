import assert from "node:assert/strict";
import {
  immutableSnapshotView,
  prepareMarketPriceLedgers,
  prepareSnapshots,
  resolveFutureReturns,
  serializableSnapshot,
} from "../lib/future-return-resolver.mjs";

function businessDates(start, count) {
  const dates = [];
  const cursor = new Date(`${start}T00:00:00Z`);
  while (dates.length < count) {
    if (cursor.getUTCDay() !== 0 && cursor.getUTCDay() !== 6) dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

function emptyFutureReturns(prefilled = null) {
  return {
    future1dReturn: prefilled,
    future5dReturn: null,
    future20dReturn: null,
    resolvedAt: { future1dDate: prefilled == null ? null : "pre-existing", future5dDate: null, future20dDate: null },
  };
}

function emptyBacktestReturns() {
  return {
    status: "pendingEntryPrice",
    entry: { priceBasis: "nextTradingDayOpen", date: null, openPrice: null },
    returns: { nextOpenToT1CloseReturn: null, nextOpenToT5CloseReturn: null, nextOpenToT20CloseReturn: null },
    exits: { t1: { date: null, closePrice: null }, t5: { date: null, closePrice: null }, t20: { date: null, closePrice: null } },
    resolution: { entryStatus: "pending", t1Status: "pending", t5Status: "pending", t20Status: "pending", reason: null },
  };
}

const dates = businessDates("2026-01-05", 21);
const snapshots = dates.map((date, index) => ({
  asOfDate: date,
  modelDefinitions: { A: "A-v1" },
  topLists: { modelA: [] },
  records: [
    { code: "000001", closePrice: index === 0 ? 100 : index === 1 ? 111 : index === 5 ? 120 : index === 20 ? 150 : 100 + index, scores: { modelA: 50 }, ranks: { modelA: 1 }, factors: {}, riskFlags: {}, futureReturns: emptyFutureReturns(), backtestReturns: emptyBacktestReturns() },
    { code: "000002", closePrice: 200 + index, scores: { modelA: 40 }, ranks: { modelA: 2 }, factors: {}, riskFlags: {}, futureReturns: emptyFutureReturns(index === 0 ? 12.345678 : null), backtestReturns: emptyBacktestReturns() },
  ],
}));
const ledgers = dates.map((date, index) => ({
  date,
  records: [
    { code: "A000001", openPrice: index === 1 ? 110 : 100 + index, closePrice: snapshots[index].records[0].closePrice },
    { code: "000002", openPrice: 200 + index, closePrice: 200 + index },
  ],
}));
const calendar = {
  schemaVersion: 1,
  dates: Object.fromEntries(dates.map((date) => [date, {
    status: "tradingDay", observedBasDt: date,
    modelSnapshot: "created", marketPriceLedger: "created", checkedAt: "test",
  }])),
};

const immutableBefore = JSON.stringify(immutableSnapshotView(snapshots[0]));
const firstRun = resolveFutureReturns(prepareSnapshots(snapshots), prepareMarketPriceLedgers(ledgers), calendar);
const first = serializableSnapshot(firstRun.snapshots[0]);
assert.equal(first.records[0].futureReturns.future1dReturn, 11);
assert.equal(first.records[0].futureReturns.future5dReturn, 20);
assert.equal(first.records[0].futureReturns.future20dReturn, 50);
assert.equal(first.records[0].backtestReturns.returns.nextOpenToT1CloseReturn, 0.909091);
assert.equal(first.records[0].backtestReturns.returns.nextOpenToT5CloseReturn, 9.090909);
assert.equal(first.records[0].backtestReturns.returns.nextOpenToT20CloseReturn, 36.363636);
assert.equal(first.records[1].futureReturns.future1dReturn, 12.345678, "기존 finite 예측 수익률은 바뀌면 안 됩니다.");
assert.equal(JSON.stringify(immutableSnapshotView(first)), immutableBefore, "허용되지 않은 원본 필드가 변경됐습니다.");

const secondRun = resolveFutureReturns(
  prepareSnapshots(firstRun.snapshots.map(serializableSnapshot)),
  prepareMarketPriceLedgers(ledgers),
  calendar,
);
assert.equal(secondRun.changedDates.length, 0, "두 번째 실행은 변경이 없어야 합니다.");

const gapSnapshots = ["2026-01-09", "2026-01-13"].map((date, index) => ({
  asOfDate: date,
  records: [{ code: "000001", closePrice: 100 + index, scores: {}, ranks: {}, factors: {}, riskFlags: {}, futureReturns: emptyFutureReturns(), backtestReturns: emptyBacktestReturns() }],
}));
const gapLedgers = ["2026-01-09", "2026-01-13"].map((date) => ({ date, records: [{ code: "000001", openPrice: 100, closePrice: 100 }] }));
const gapCalendar = { schemaVersion: 1, dates: {
  "2026-01-09": { status: "tradingDay", modelSnapshot: "created", marketPriceLedger: "created" },
  "2026-01-12": { status: "unchecked", modelSnapshot: "notRequired", marketPriceLedger: "notRequired" },
  "2026-01-13": { status: "tradingDay", modelSnapshot: "created", marketPriceLedger: "created" },
} };
const gapRun = resolveFutureReturns(prepareSnapshots(gapSnapshots), prepareMarketPriceLedgers(gapLedgers), gapCalendar);
assert.equal(gapRun.snapshots[0].records[0].backtestReturns.resolution.entryStatus, "unchecked");
assert.equal(gapRun.snapshots[0].records[0].futureReturns.future1dReturn, null);

const haltedLedgers = structuredClone(ledgers);
haltedLedgers[1].records[0] = { code: "A000001", openPrice: null, closePrice: null, referenceClose: 111, executable: false, priceStatus: "tradingHaltOrNoTrade" };
const haltedRun = resolveFutureReturns(prepareSnapshots(structuredClone(snapshots)), prepareMarketPriceLedgers(haltedLedgers), calendar);
const haltedRecord = haltedRun.snapshots[0].records[0];
assert.equal(haltedRecord.backtestReturns.resolution.entryStatus, "notExecutable");
assert.equal(haltedRecord.backtestReturns.entry.openPrice, null);
assert.equal(haltedRecord.backtestReturns.returns.nextOpenToT1CloseReturn, null);
assert.equal(haltedRecord.futureReturns.future1dReturn, null, "referenceClose로 예측 수익률을 만들면 안 됩니다.");

const haltedExitLedgers = structuredClone(ledgers);
haltedExitLedgers[5].records[0] = { code: "000001", openPrice: null, closePrice: null, referenceClose: 120, executable: false, priceStatus: "tradingHaltOrNoTrade" };
const haltedExitRun = resolveFutureReturns(prepareSnapshots(structuredClone(snapshots)), prepareMarketPriceLedgers(haltedExitLedgers), calendar);
const haltedExitRecord = haltedExitRun.snapshots[0].records[0];
assert.equal(haltedExitRecord.backtestReturns.resolution.t5Status, "notExecutable");
assert.equal(haltedExitRecord.backtestReturns.returns.nextOpenToT5CloseReturn, null);
assert.equal(haltedExitRecord.futureReturns.future5dReturn, null);

console.log(JSON.stringify({
  predictiveReturns: first.records[0].futureReturns,
  backtestReturns: first.records[0].backtestReturns,
  secondRunChangedSnapshots: secondRun.changedDates.length,
  blockedWeekdayStatus: gapRun.snapshots[0].records[0].backtestReturns.resolution.entryStatus,
}, null, 2));
