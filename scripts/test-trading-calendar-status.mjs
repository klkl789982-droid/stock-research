import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { prepareMarketPriceLedgers, prepareSnapshots, resolveFutureReturns, serializableSnapshot } from "../lib/future-return-resolver.mjs";
import { classifyRequestedDate, loadTradingCalendar, updateTradingCalendarDate } from "../lib/trading-calendar-status.mjs";

const backtest = () => ({ status: "pendingEntryPrice", entry: { priceBasis: "nextTradingDayOpen", date: null, openPrice: null }, returns: { nextOpenToT1CloseReturn: null, nextOpenToT5CloseReturn: null, nextOpenToT20CloseReturn: null }, exits: { t1: { date: null, closePrice: null }, t5: { date: null, closePrice: null }, t20: { date: null, closePrice: null } }, resolution: { entryStatus: "pending", t1Status: "pending", t5Status: "pending", t20Status: "pending", reason: null } });
const future = (value = null) => ({ future1dReturn: value, future5dReturn: null, future20dReturn: null, resolvedAt: { future1dDate: value == null ? null : "fixed", future5dDate: null, future20dDate: null } });
const snapshot = (date, close = 100, existingFuture = null) => ({ asOfDate: date, records: [{ code: "000001", closePrice: close, scores: { modelA: 1 }, ranks: { modelA: 1 }, factors: {}, riskFlags: {}, futureReturns: future(existingFuture), backtestReturns: backtest() }] });
const ledger = (date, open = 100, close = 100) => ({ date, records: [{ code: "A000001", openPrice: open, closePrice: close }] });
const entry = (date, overrides = {}) => ({ status: "tradingDay", observedBasDt: date, modelSnapshot: "created", marketPriceLedger: "created", checkedAt: "test", ...overrides });
const run = (snapshots, ledgers, dates) => resolveFutureReturns(prepareSnapshots(snapshots), prepareMarketPriceLedgers(ledgers), { schemaVersion: 1, dates });

const fridayMonday = run(
  [snapshot("2026-01-09"), snapshot("2026-01-12", 110)],
  [ledger("2026-01-09"), ledger("2026-01-12", 105, 110)],
  { "2026-01-09": entry("2026-01-09"), "2026-01-12": entry("2026-01-12") },
);
assert.equal(fridayMonday.snapshots[0].records[0].futureReturns.future1dReturn, 10);
assert.equal(fridayMonday.snapshots[0].records[0].backtestReturns.returns.nextOpenToT1CloseReturn, 4.761905);

const holiday = run(
  [snapshot("2026-01-09"), snapshot("2026-01-13", 120)],
  [ledger("2026-01-09"), ledger("2026-01-13", 110, 120)],
  { "2026-01-09": entry("2026-01-09"), "2026-01-12": entry("2026-01-12", { status: "marketClosed", modelSnapshot: "notRequired", marketPriceLedger: "notRequired" }), "2026-01-13": entry("2026-01-13") },
);
assert.equal(holiday.snapshots[0].records[0].backtestReturns.entry.date, "2026-01-13");
assert.equal(holiday.snapshots[0].records[0].futureReturns.future1dReturn, 20);

const missingModel = run(
  [snapshot("2026-01-09")],
  [ledger("2026-01-09"), ledger("2026-01-12", 100, 110)],
  { "2026-01-09": entry("2026-01-09"), "2026-01-12": entry("2026-01-12", { modelSnapshot: "missing" }) },
);
assert.equal(missingModel.snapshots[0].records[0].futureReturns.future1dReturn, null);
assert.equal(missingModel.snapshots[0].records[0].backtestReturns.returns.nextOpenToT1CloseReturn, 10);

const missingLedger = run(
  [snapshot("2026-01-09"), snapshot("2026-01-12", 110)],
  [ledger("2026-01-09")],
  { "2026-01-09": entry("2026-01-09"), "2026-01-12": entry("2026-01-12", { marketPriceLedger: "missing" }) },
);
assert.equal(missingLedger.snapshots[0].records[0].backtestReturns.resolution.entryStatus, "missingTradingDaySnapshot");
assert.equal(missingLedger.snapshots[0].records[0].futureReturns.future1dReturn, null);

for (const blockedStatus of ["collectionFailed", "unchecked"]) {
  const blocked = run(
    [snapshot("2026-01-09"), snapshot("2026-01-13")],
    [ledger("2026-01-09"), ledger("2026-01-13")],
    { "2026-01-09": entry("2026-01-09"), "2026-01-12": entry("2026-01-12", { status: blockedStatus, modelSnapshot: "notRequired", marketPriceLedger: "notRequired" }), "2026-01-13": entry("2026-01-13") },
  );
  assert.equal(blocked.snapshots[0].records[0].backtestReturns.resolution.entryStatus, blockedStatus);
  assert.equal(blocked.snapshots[0].records[0].futureReturns.future1dReturn, null);
}

const preserved = run(
  [snapshot("2026-01-09", 100, 7.25), snapshot("2026-01-12", 999)],
  [ledger("2026-01-09"), ledger("2026-01-12", 100, 999)],
  { "2026-01-09": entry("2026-01-09"), "2026-01-12": entry("2026-01-12") },
);
assert.equal(preserved.snapshots[0].records[0].futureReturns.future1dReturn, 7.25);
const second = run(preserved.snapshots.map(serializableSnapshot), [ledger("2026-01-09"), ledger("2026-01-12", 100, 999)], { "2026-01-09": entry("2026-01-09"), "2026-01-12": entry("2026-01-12") });
assert.equal(second.changedDates.length, 0);

assert.equal(classifyRequestedDate({ requestedDate: "2026-01-10" }).status, "marketClosed");
assert.equal(classifyRequestedDate({ requestedDate: "2026-01-12", observedBasDt: "2026-01-12" }).status, "tradingDay");
assert.equal(classifyRequestedDate({ requestedDate: "2026-01-12", observedBasDt: "2026-01-09" }).status, "unchecked");
assert.equal(classifyRequestedDate({ requestedDate: "2026-01-12", error: "HTTP 500" }).status, "collectionFailed");

const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "stock-calendar-test-"));
try {
  const calendarEntry = { status: "marketClosed", observedBasDt: null, modelSnapshot: "notRequired", marketPriceLedger: "notRequired", reason: "weekend" };
  const firstUpdate = await updateTradingCalendarDate("2026-01-10", calendarEntry, temporaryRoot);
  const secondUpdate = await updateTradingCalendarDate("2026-01-10", calendarEntry, temporaryRoot);
  assert.equal(firstUpdate.changed, true);
  assert.equal(secondUpdate.changed, false);
  assert.equal((await loadTradingCalendar(temporaryRoot)).dates["2026-01-10"].status, "marketClosed");
} finally {
  await fs.rm(temporaryRoot, { recursive: true, force: true });
}

console.log(JSON.stringify({ fridayToMonday: "resolved", weekdayHoliday: "skipped", missingModel: "predictionBlocked", missingLedger: "allPriceReturnsBlocked", collectionFailed: "blocked", unchecked: "blocked", idempotent: true }, null, 2));
