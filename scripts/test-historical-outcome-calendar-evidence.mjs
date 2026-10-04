import assert from "node:assert/strict";
import { createHistoricalOutcomeCalendarEvidence, mergeCalendarEvidence } from "../lib/historical-outcome-calendar-evidence.mjs";
import { reconcileOutcomeCoverage } from "../lib/outcome-coverage-reconciliation.mjs";

const snapshot = (date, codes) => ({ asOfDate: date, records: codes.map((code) => ({ code })) });
const ledger = (date, codes) => ({ date, records: codes.map((code) => ({ code, closePrice: 100 })) });
const calendar = { schemaVersion: 1, dates: { "2026-01-02": { status: "tradingDay", modelSnapshot: "created", marketPriceLedger: "created" } } };
const evidence = createHistoricalOutcomeCalendarEvidence({ snapshots: [snapshot("2026-01-02", ["000001"]), snapshot("2026-01-05", ["000001"])], marketPriceLedgers: [ledger("2026-01-02", ["000001"]), ledger("2026-01-05", ["000001"])], tradingCalendar: calendar });
assert.deepEqual(Object.keys(evidence.entries), ["2026-01-05"], "explicit calendar는 보존하고 matching artifact 날짜만 보완해야 합니다.");
const effective = mergeCalendarEvidence(calendar, evidence);
assert.equal(effective.dates["2026-01-05"].evidence, "matchingHistoricalSnapshotAndPriceLedger");
assert.equal(effective.dates["2026-01-02"].evidence, undefined, "explicit calendar를 derived evidence가 덮어쓰면 안 됩니다.");
const incomplete = createHistoricalOutcomeCalendarEvidence({ snapshots: [snapshot("2026-01-06", ["000001"])], marketPriceLedgers: [], tradingCalendar: calendar });
assert.deepEqual(incomplete.entries, {}, "price ledger가 없는 날짜를 거래일로 추정하면 안 됩니다.");
const coverage = reconcileOutcomeCoverage({ snapshots: [snapshot("2026-01-02", ["000001"]), snapshot("2026-01-05", ["000001"])], marketPriceLedgers: [ledger("2026-01-02", ["000001"]), ledger("2026-01-05", ["000001"])], tradingCalendar: effective, coverageAsOfDate: "2026-01-05" });
assert.equal(coverage.artifacts[0].records[0].horizons["1D"].status, "MATURE", "derived calendar + 실제 ledger가 있을 때만 mature해야 합니다.");
const calendarOnly = reconcileOutcomeCoverage({
  snapshots: [snapshot("2026-01-02", ["000001"]), snapshot("2026-01-05", ["000001"])], marketPriceLedgers: [ledger("2026-01-02", ["000001"])],
  tradingCalendar: calendar,
  calendarEvidence: { entries: { "2026-01-05": { status: "tradingDay", modelSnapshot: "created", marketPriceLedger: "created", evidence: "testCalendarOnly" } }, contentHash: "test" },
  coverageAsOfDate: "2026-01-05",
});
assert.equal(calendarOnly.artifacts[0].records[0].horizons["1D"].status, "DATA_MISSING");
assert.equal(calendarOnly.artifacts[0].records[0].horizons["1D"].reason, "priceLedgerMissing", "calendar evidence만으로 price ledger 부재를 mature로 바꾸면 안 됩니다.");
console.log(JSON.stringify({ derivedDates: Object.keys(evidence.entries), firstSignal1D: coverage.artifacts[0].records[0].horizons["1D"].status }, null, 2));
