import assert from "node:assert/strict";
import { reconcileOutcomeCoverage } from "../lib/outcome-coverage-reconciliation.mjs";
import { prepareMarketPriceLedgers, prepareSnapshots, resolveFutureReturns } from "../lib/future-return-resolver.mjs";

const signal = (date, codes) => ({ asOfDate: date, contentHash: `snapshot-${date}`, records: codes.map((code) => ({ code, closePrice: 100, scores: { modelA: 70 }, ranks: { modelA: 1 } })) });
const ledger = (date, records) => ({ date, records: records.map(([code, closePrice, executable = true]) => ({ code, closePrice, openPrice: closePrice, executable })) });
const calendar = (dates) => ({ schemaVersion: 1, dates });
const trading = () => ({ status: "tradingDay", modelSnapshot: "created", marketPriceLedger: "created" });

const snapshots = [signal("2026-01-02", ["000001", "000002"]), signal("2026-01-05", ["000001", "000002"]), signal("2026-01-06", ["000001", "000002"])];
const ledgers = [ledger("2026-01-02", [["000001", 100], ["000002", 100]]), ledger("2026-01-05", [["000001", 110]]), ledger("2026-01-06", [["000001", 120], ["000002", 120]])];
const completeCalendar = calendar({ "2026-01-02": trading(), "2026-01-05": trading(), "2026-01-06": trading() });
const complete = reconcileOutcomeCoverage({ snapshots, marketPriceLedgers: ledgers, tradingCalendar: completeCalendar, coverageAsOfDate: "2026-01-06" });
const first = complete.artifacts.find((artifact) => artifact.signalDate === "2026-01-02");
assert.equal(first.records.find((record) => record.ticker === "000001").horizons["1D"].status, "MATURE", "T+1 close가 있으면 MATURE여야 합니다.");
assert.equal(first.records.find((record) => record.ticker === "000002").horizons["1D"].status, "DATA_MISSING", "개별 종목 가격 누락은 DATA_MISSING이어야 합니다.");
assert.equal(first.records.find((record) => record.ticker === "000001").horizons["5D"].status, "PENDING", "아직 확인 범위를 넘는 T+5는 PENDING이어야 합니다.");
assert.equal(first.trackingUniverse.count, 2);

const missingCalendar = reconcileOutcomeCoverage({
  snapshots: [signal("2026-01-02", ["000001"])], marketPriceLedgers: [ledger("2026-01-02", [["000001", 100]]), ledger("2026-01-06", [["000001", 120]])],
  tradingCalendar: calendar({ "2026-01-02": trading(), "2026-01-06": trading() }), coverageAsOfDate: "2026-01-06",
}).artifacts[0];
assert.equal(missingCalendar.records[0].horizons["1D"].status, "DATA_MISSING");
assert.equal(missingCalendar.records[0].horizons["1D"].reason, "calendarMissing");

const missingLedger = reconcileOutcomeCoverage({
  snapshots: [signal("2026-01-02", ["000001"]), signal("2026-01-05", ["000001"])], marketPriceLedgers: [ledger("2026-01-02", [["000001", 100]])],
  tradingCalendar: calendar({ "2026-01-02": trading(), "2026-01-05": trading() }), coverageAsOfDate: "2026-01-05",
}).artifacts[0];
assert.equal(missingLedger.records[0].horizons["1D"].status, "DATA_MISSING");
assert.equal(missingLedger.records[0].horizons["1D"].reason, "priceLedgerMissing");

const calendarCoverageIncomplete = reconcileOutcomeCoverage({
  snapshots: [signal("2026-01-02", ["000001"])], marketPriceLedgers: [ledger("2026-01-02", [["000001", 100]])],
  tradingCalendar: calendar({ "2026-01-02": trading() }), coverageAsOfDate: "2026-01-06",
}).artifacts[0];
assert.equal(calendarCoverageIncomplete.records[0].horizons["1D"].status, "DATA_MISSING");
assert.equal(calendarCoverageIncomplete.records[0].horizons["1D"].reason, "calendarCoverageIncomplete", "기준일은 지났지만 calendar가 이어지지 않으면 PENDING이 아니어야 합니다.");

const repeated = reconcileOutcomeCoverage({ snapshots: [signal("2026-01-02", ["000001"]), signal("2026-01-05", ["000001"])], marketPriceLedgers: [ledger("2026-01-02", [["000001", 100]]), ledger("2026-01-05", [["000001", 110]]), ledger("2026-01-06", [["000001", 120]])], tradingCalendar: completeCalendar, coverageAsOfDate: "2026-01-06" });
assert.equal(repeated.artifacts.length, 2, "반복 선정은 signal date별 독립 관측이어야 합니다.");
assert.notEqual(repeated.artifacts[0].contentHash, repeated.artifacts[1].contentHash);

const resolverInput = [{ ...signal("2026-01-02", ["000001"]), records: [{ code: "000001", closePrice: 100, futureReturns: { future1dReturn: null, future5dReturn: null, future20dReturn: null, future60dReturn: null, resolvedAt: {} }, backtestReturns: null }] }, { ...signal("2026-01-05", ["000001"]), records: [{ code: "000001", closePrice: 110, futureReturns: { future1dReturn: null, future5dReturn: null, future20dReturn: null, future60dReturn: null, resolvedAt: {} }, backtestReturns: null }] }];
const resolverBefore = JSON.stringify(resolverInput);
resolveFutureReturns(prepareSnapshots(resolverInput), prepareMarketPriceLedgers([ledger("2026-01-02", [["000001", 100]]), ledger("2026-01-05", [["000001", 110]])]), calendar({ "2026-01-02": trading(), "2026-01-05": trading() }));
assert.equal(JSON.stringify(resolverInput), resolverBefore, "coverage reconciliation은 기존 resolver 입력/결과를 변경하지 않습니다.");

console.log(JSON.stringify({ signalDates: complete.summary.signalDates, firstDayCounts: first.counts, resolverInputUnchanged: true }, null, 2));
