import assert from "node:assert/strict";
import { buildModelMaturityCoverageReport, renderModelMaturityCoverageMarkdown } from "../lib/model-maturity-coverage-report.mjs";
import { prepareMarketPriceLedgers, prepareSnapshots, resolveFutureReturns } from "../lib/future-return-resolver.mjs";

const scoreRecord = (code, values) => ({ code, scores: { modelA: values.a, modelB: values.b, modelC: values.c, modelD: values.d }, scoresByVersion: { "A-v1": values.a, "A-v2": values.a2 }, ranks: { modelA: values.a == null ? null : 1, modelB: values.b == null ? null : 1, modelC: values.c == null ? null : 1, modelD: values.d == null ? null : 1 }, ranksByVersion: { "A-v1": values.a == null ? null : 1, "A-v2": values.a2 == null ? null : 1 } });
const coverage = (signalDate, records) => ({ signalDate, coverageAsOfDate: "2026-01-09", sourceSnapshotHash: `snapshot-${signalDate}`, contentHash: `coverage-${signalDate}`, records });
const horizon = (status, reason = null) => ({ status, reason });
const coverageRecord = (ticker, one, five) => ({ ticker, horizons: { "1D": horizon(...one), "5D": horizon(...five), "20D": horizon("PENDING"), "60D": horizon("PENDING") } });
const snapshot = (date, records) => ({ asOfDate: date, contentHash: `snapshot-${date}`, records });

const snapshots = [
  snapshot("2026-01-02", [scoreRecord("000001", { a: 80, a2: 75, b: null, c: null, d: null }), scoreRecord("000002", { a: null, a2: null, b: 70, c: 60, d: 65 }), { ...scoreRecord("000003", { a: null, a2: null, b: null, c: null, d: null }), qualityEligibility: { eligible: false, status: "quarantined", exclusions: [{ reason: "qualityIssue" }] } }]),
  snapshot("2026-01-05", [scoreRecord("000001", { a: 81, a2: 76, b: 71, c: null, d: 66 })]),
];
const artifacts = [
  coverage("2026-01-02", [coverageRecord("000001", ["MATURE"], ["PENDING"]), coverageRecord("000002", ["DATA_MISSING", "symbolPriceMissing"], ["DATA_MISSING", "priceLedgerMissing"])]),
  coverage("2026-01-05", [coverageRecord("000001", ["PENDING"], ["PENDING"])]),
];
const report = buildModelMaturityCoverageReport({ snapshots, coverageArtifacts: artifacts });
assert.deepEqual(report.models["A-v1"].horizons["1D"], { totalSignals: 2, MATURE: 1, PENDING: 1, DATA_MISSING: 0, matureRate: 50, dataMissingReasons: {} }, "A가 서로 다른 signal date에 재선정되면 독립 관측이어야 합니다.");
assert.equal(report.models["A-v1"].horizons["5D"].PENDING, 2, "1D maturity는 5D로 전파되면 안 됩니다.");
assert.equal(report.models["B-v1"].horizons["1D"].DATA_MISSING, 1, "B의 실제 ranked signal만 집계해야 합니다.");
assert.equal(report.models["B-v1"].horizons["1D"].dataMissingReasons.symbolPriceMissing, 1);
assert.equal(report.models["C-v1"].horizons["5D"].dataMissingReasons.priceLedgerMissing, 1);
assert.equal(report.models["D-v1"].horizons["1D"].totalSignals, 2);
assert.deepEqual(report.models["D-v1"].horizons["1D"], { totalSignals: 2, MATURE: 0, PENDING: 1, DATA_MISSING: 1, matureRate: 0, dataMissingReasons: { symbolPriceMissing: 1 } }, "모델별 실제 signal/coverage 상태를 독립적으로 집계해야 합니다.");
assert.equal(report.models["A-v1"].horizons["1D"].totalSignals, 2, "quarantine으로 score/rank가 없는 record는 model signal이 아닙니다.");
assert.match(renderModelMaturityCoverageMarkdown(report), /A-v1 \| 1D \| 2 \| 1 \| 1/u);
assert.throws(() => buildModelMaturityCoverageReport({ snapshots: [snapshots[0]], coverageArtifacts: [] }), /outcome coverage artifact/u);

const resolverInput = [{ asOfDate: "2026-01-02", records: [{ code: "000001", closePrice: 100, futureReturns: { future1dReturn: null, future5dReturn: null, future20dReturn: null, future60dReturn: null, resolvedAt: {} }, backtestReturns: null }] }];
const resolverBefore = JSON.stringify(resolverInput);
resolveFutureReturns(prepareSnapshots(resolverInput), prepareMarketPriceLedgers([]), { schemaVersion: 1, dates: {} });
assert.equal(JSON.stringify(resolverInput), resolverBefore, "maturity report는 resolver 입력이나 rank/backtest 결과를 변경하지 않습니다.");

console.log(JSON.stringify({ a1d: report.models["A-v1"].horizons["1D"], b1d: report.models["B-v1"].horizons["1D"], repeatedTickerObservations: 2 }, null, 2));
