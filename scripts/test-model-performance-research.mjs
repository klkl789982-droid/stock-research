import assert from "node:assert/strict";
import { test } from "node:test";
import { buildModelPerformanceResearch, applyResearchCosts, summarizeResearchReturns, validateResearchOptions } from "../lib/model-performance-research.mjs";
import { createMarketPriceLedger } from "../lib/market-price-ledger.mjs";
import { MODEL_VERSIONS } from "../lib/rank-backtest-engine.mjs";
import { createCompactModelHistory, createDailyRunManifest } from "../lib/daily-production.mjs";
import { identifyStoredResearchSignal, loadModelPerformanceResearch } from "../lib/model-performance-research-store.mjs";
import { SELL_TAX_2026, taxEligibilityForStudy } from "../lib/research-sell-tax.mjs";
import { sha256Canonical } from "../lib/snapshot-quality-pipeline.mjs";

// Synthetic prices only: these fixtures are never persisted as research/production artifacts.
function fixture() {
  const dates = {};
  for (let i = 0; i < 70; i++) {
    const date = new Date(Date.UTC(2026, 0, 2 + i)).toISOString().slice(0, 10);
    dates[date] = { status: [0, 6].includes(new Date(date).getUTCDay()) ? "marketClosed" : "tradingDay" };
  }
  dates["2026-01-05"] = { status: "marketClosed" };
  const codes = Array.from({ length: 5 }, (_, i) => String(i + 1).padStart(6, "0"));
  const snapshot = { schemaVersion: 6, asOfDate: "2026-01-02", sourceAvailability: { signalComputedAt: "2026-01-06T08:00:00+09:00", signalAvailableAt: "2026-01-06T08:01:00+09:00" },
    sourceManifest: { universe: { artifact: { verificationStatus: "VERIFIED" } }, sources: { officialDailyPrice: { provider: "공공데이터포털", normalizedInputHash: "synthetic-input" } }, modelFormulaHashes: Object.fromEntries(MODEL_VERSIONS.map((v) => [v, `synthetic-${v}`])) },
    dataQuality: { certification: { eligibleForRankBacktest: true } }, records: codes.map((code, i) => ({ code, name: `테스트${i}`, market: i < 3 ? "KOSPI" : "KOSDAQ", closePrice: 95,
      scoresByVersion: Object.fromEntries(MODEL_VERSIONS.map((v) => [v, 100 - i])), ranksByVersion: Object.fromEntries(MODEL_VERSIONS.map((v) => [v, i + 1])), qualityEligibility: { eligible: true } })) };
  const signal = { snapshot, classification: "AS_PUBLISHED", layer: "DAILY_EOD", availableAt: "2026-01-06T08:01:00+09:00", availabilityEvidence: "VERIFIED", sourceSnapshotHash: "synthetic-frozen-hash" };
  const ledgers = Object.entries(dates).filter(([, v]) => v.status === "tradingDay").map(([date]) => createMarketPriceLedger(date, codes.map((code, i) => ({ code, openPrice: 100, closePrice: i === 0 ? 90 : i === 1 ? 100 : 110 }))));
  return { signals: [signal], calendar: { dates }, ledgers, asOf: "2026-03-15T00:00:00Z", options: { topN: 5 } };
}
const cohort = (r, model = "B-v1") => r.cohorts.find((c) => c.modelVersion === model);
test("2026 ordinary-sale tax uses the matched master, same mature legs and sell proceeds in both account and basket", () => {
  const f = fixture(), s = f.signals[0].snapshot;
  const stocks = s.records.map(r => ({ code:r.code, market:r.market, securityGroupCode:"ST", isinCode:"KR7"+r.code+"001",
    etpProductCode:"", preferredStockCode:"0", isSpac:false }));
  const eligible = () => {
    s.sourceManifest.universe.contentHash = sha256Canonical(stocks);
    return taxEligibilityForStudy({ stocks },[s]);
  };
  const taxEligible = eligible(), first=stocks[0];
  assert.deepEqual(SELL_TAX_2026,{KOSPI:{transactionBps:5,ruralBps:15},KOSDAQ:{transactionBps:20,ruralBps:0}});
  for (const row of stocks) assert.equal(taxEligible(s.asOfDate,row,"2026-01-07"),true);
  for (const [key,value] of [["etpProductCode","ETF"],["isSpac",true],["securityGroupCode","DR"],["preferredStockCode","1"],["isinCode","HK0000000001"]]) {
    const stock={...first,[key]:value}, master={stocks:[stock]};
    const bound=taxEligibilityForStudy(master,[{...s,sourceManifest:{universe:{contentHash:sha256Canonical(master.stocks)}}}]);
    assert.equal(bound(s.asOfDate,first,"2026-01-07"),false);
  }
  assert.equal(taxEligible(s.asOfDate,first,"2027-01-05"),false);
  assert.equal(taxEligible(s.asOfDate,{...first,market:"KOSDAQ"},"2026-01-07"),false);
  assert.equal(taxEligibilityForStudy({stocks},[{...s,sourceManifest:{}}])(s.asOfDate,first,"2026-01-07"),false);
  const cost={mode:"USER_INPUT",buyFeeBps:2,sellFeeBps:2,buySlippageBps:5,sellSlippageBps:5,sellTaxBps:0,basis:"fixture",basisDate:"2026-01-02"};
  const options={models:["B-v1"],topN:5,cost};
  const before=cohort(buildModelPerformanceResearch({...f,options}));
  const result=cohort(buildModelPerformanceResearch({...f,options,taxEligible}));
  const taxed=cohort(buildModelPerformanceResearch({...f,options:{...options,cost:{...cost,sellTaxBps:20}}}));
  assert.deepEqual(before.fundedAccount,result.fundedAccount);
  assert.equal(result.taxComparison.dates,1);
  assert.ok(Math.abs(result.taxComparison.meanIncluding - taxed.netScenarioMetrics.meanReturn) < 0.000001);
  const expected=(((1.04)*(1-0.0005)*(1-0.0002-0.002))/((1+0.0005)*(1+0.0002))-1)*100;
  assert.ok(Math.abs(result.taxComparison.meanIncluding-expected)<0.000001);
  assert.equal(result.taxComparison.totalIncluding,taxed.fundedAccount.totalReturn);
  assert.equal(result.taxComparison.drawdownIncluding,taxed.fundedAccount.maxDrawdown);
  assert.ok(result.taxComparison.totalIncluding<before.fundedAccount.totalReturn);
  stocks[0].securityGroupCode="ET";
  const unknown=cohort(buildModelPerformanceResearch({...f,options,taxEligible:eligible()})).taxComparison;
  assert.deepEqual([unknown.dates,unknown.unsupportedDates,unknown.unsupportedMatureLegs,unknown.meanIncluding,unknown.totalIncluding],[0,1,1,null,null]);
  const pending=cohort(buildModelPerformanceResearch({...f,options,taxEligible,asOf:"2026-01-07T15:29:00+09:00"})).taxComparison;
  assert.equal(pending.immatureOrMissingDates,1); assert.equal(pending.dates,0); assert.equal(pending.meanIncluding,null);
});
test("existing T+2 contract / holidays / 1D 5D 20D / no mutation", () => {
  const f = fixture(), before = structuredClone(f);
  for (const [horizon, exitDate] of [["H1", "2026-01-07"], ["H5", "2026-01-13"], ["H20", "2026-02-03"]]) {
    const c = cohort(buildModelPerformanceResearch({ ...f, options: { topN: 5, horizon } }));
    assert.equal(c.rows[0].entryDate, "2026-01-07"); assert.equal(c.rows[0].exitDate, exitDate);
    assert.equal(c.stockMetrics.observationCount, 5); assert.equal(c.stockMetrics.meanReturn, 4); assert.equal(c.stockMetrics.positiveRate, 60); assert.equal(c.stockMetrics.standardDeviation, 8.944272);
    assert.equal(c.portfolios[0].grossReturn, 4); assert.equal(c.portfolioMetrics.observationCount, 1);
  }
  assert.deepEqual(f, before); assert.deepEqual(buildModelPerformanceResearch(f), buildModelPerformanceResearch(f));
});
test("as-of rejects cached future returns and same-day unfinished close", () => {
  const f = fixture(); f.signals[0].snapshot.records.forEach((r) => { r.executionReturnsByPolicy = { "public-eod-t2-open-v1": { returns: { holding1dReturn: 999, holding5dReturn: 999, holding20dReturn: 999 } } }; });
  for (const asOf of ["2026-01-07T15:29:59+09:00", "2026-01-06T15:40:00+09:00"]) {
    const c = cohort(buildModelPerformanceResearch({ ...f, asOf }));
    assert.equal(c.stockMetrics.observationCount, 0); assert.equal(c.stockMetrics.meanReturn, null); assert.equal(c.pendingCount, 5);
  }
  assert.equal(cohort(buildModelPerformanceResearch({ ...f, asOf: "2026-01-07T15:30:00+09:00" })).stockMetrics.meanReturn, 4);
});
test("quality, unknown PIT, timing, hash conflicts, missing and invalid prices fail closed", () => {
  const cases = [
    ["DATA_QUALITY_BLOCKED", (f) => { f.signals[0].snapshot.dataQuality.certification.eligibleForRankBacktest = false; }],
    ["POINT_IN_TIME_UNIVERSE_UNVERIFIED", (f) => { f.signals[0].snapshot.sourceManifest.universe.artifact.verificationStatus = "UNVERIFIED"; }],
    ["SIGNAL_PUBLICATION_TIME_UNVERIFIED", (f) => { f.signals[0].availabilityEvidence = "COMMIT_INTENT_OR_UNKNOWN"; }],
    ["FORMULA_HASH_CONFLICT", (f) => { f.signals[0].snapshot.modelVersionDefinitions = { "B-v1": { formulaHash: "different" } }; }],
    ["timingInvalid", (f) => { f.signals[0].availableAt = "2026-01-07T09:00:00+09:00"; }],
    ["missingTradingDaySnapshot", (f) => { f.ledgers = f.ledgers.filter((l) => l.date !== "2026-01-07"); }],
  ];
  for (const [reason, alter] of cases) {
    const f = fixture(); alter(f); const c = cohort(buildModelPerformanceResearch(f));
    assert.equal(c.stockMetrics.observationCount, 0, reason); assert.equal(c.rows[0].reason, reason); assert.equal(c.missingCount, 5);
  }
  const f = fixture(); f.ledgers.find((l) => l.date === "2026-01-07").records.pop();
  const c = cohort(buildModelPerformanceResearch(f)); assert.equal(c.stockMetrics.observationCount, 4); assert.equal(c.matureSignalDateCount, 0); assert.equal(c.portfolioMetrics.meanReturn, null, "do not silently reweight partial TOP");
});
test("repetition/date portfolios/native universe/model version/retrospective isolation", () => {
  const f = fixture(), second = structuredClone(f.signals[0]); second.snapshot.asOfDate = "2026-01-06"; second.availableAt = "2026-01-07T08:00:00+09:00"; second.snapshot.sourceAvailability.signalComputedAt = "2026-01-06T18:00:00+09:00";
  f.signals.push(second); let result = buildModelPerformanceResearch(f), c = cohort(result);
  assert.equal(c.stockMetrics.observationCount, 10); assert.equal(c.uniqueStockCount, 5); assert.equal(c.signalDateCount, 2); assert.equal(c.repeatedObservationCount, 5);
  assert.equal(result.comparison.commonMatureSignalDates.length, 2); assert.equal(result.comparison.winner, null);
  const changed = structuredClone(second); changed.snapshot.sourceManifest.modelFormulaHashes["B-v1"] = "next-version-hash"; f.signals[1] = changed;
  result = buildModelPerformanceResearch(f); assert.equal(result.cohorts.filter((c) => c.modelVersion === "B-v1").length, 2); assert.equal(result.comparison.status, "NOT_COMPARABLE");
  f.signals[1] = second; second.snapshot.records.push({ ...second.snapshot.records[0], code: "000006", ranksByVersion: { "C-v1": 6 } });
  assert.equal(buildModelPerformanceResearch(f).comparison.status, "NOT_COMPARABLE");
  second.classification = "RETROSPECTIVE";
  assert.equal(cohort(buildModelPerformanceResearch(f)).signalDateCount, 1); assert.equal(cohort(buildModelPerformanceResearch({ ...f, options: { topN: 5, classification: "RETROSPECTIVE" } })).signalDateCount, 1);
});
test("benchmark must match dates, price basis, market weights and verified provenance", () => {
  const f = fixture(); f.benchmarks = ["KOSPI", "KOSDAQ"].map((market, i) => ({ market, entryDate: "2026-01-07", exitDate: "2026-01-07", entryBasis: "officialDailyOpen", exitBasis: "officialDailyClose", returnPercent: i ? 10 : 0,
    source: "official-index", provenance: { verified: true, sourceHash: `synthetic-${market}`, observedAt: "2026-01-07T16:00:00+09:00" } }));
  let c = cohort(buildModelPerformanceResearch(f)); assert.equal(c.portfolios[0].benchmarkReturn, 4); assert.equal(c.portfolios[0].excessReturn, 0);
  f.benchmarks[1].entryBasis = "previousClose"; c = cohort(buildModelPerformanceResearch(f)); assert.equal(c.portfolios[0].benchmarkReturn, null); assert.equal(c.excessMetrics.meanReturn, null);
});
test("costs are multiplicative scenarios with no invented real tax/fee", () => {
  const cost = { mode: "USER_INPUT", buyFeeBps: 10, sellFeeBps: 20, sellTaxBps: 30, buySlippageBps: 40, sellSlippageBps: 50, basisDate: "2026-01-02", basis: "synthetic research scenario" };
  const expected = Number(((1.1 * 0.995 * 0.995 / (1.004 * 1.001) - 1) * 100).toFixed(6));
  assert.equal(applyResearchCosts(10, cost), expected); assert.equal(applyResearchCosts(0, { mode: "GROSS_ONLY" }), null);
  const r = buildModelPerformanceResearch({ ...fixture(), options: { topN: 5, cost } }); assert.equal(r.costStatus, "UNVERIFIED_RESEARCH_SCENARIO");
  assert.throws(() => validateResearchOptions({ cost: { ...cost, sellTaxBps: -1 } })); assert.throws(() => validateResearchOptions({ cost: { ...cost, basis: "" } }));
  for (const options of [{ from: "2026-99-01" }, { from: "2026-02-30" }, { models: ["B-v1", "B-v1"] }, { horizon: "H60" }, { topN: 1 }]) assert.throws(() => validateResearchOptions(options));
  assert.equal(summarizeResearchReturns([]).meanReturn, null); assert.equal(summarizeResearchReturns([0]).positiveRate, 0); assert.equal(summarizeResearchReturns([0]).standardDeviation, null);
});
test("Daily/LIVE/KIS segregation and corrupt ranking", () => {
  for (const layer of ["INTRADAY_1430_LIVE", "KIS_EOD"]) { const f = fixture(); f.signals[0].layer = layer; assert.equal(buildModelPerformanceResearch(f).cohorts.length, 0); }
  const f = fixture(); f.signals[0].snapshot.records[4].ranksByVersion["B-v1"] = 1;
  assert.equal(cohort(buildModelPerformanceResearch(f)).stockMetrics.observationCount, 0);
  const duplicate = fixture(); duplicate.signals.push(structuredClone(duplicate.signals[0])); assert.equal(buildModelPerformanceResearch(duplicate).cohorts.length, 0);
});
test("published selection verification never treats commit intent as completed publication", () => {
  const s = fixture().signals[0].snapshot;
  s.records.forEach((r) => { r.scores = { modelA: r.scoresByVersion["A-v1"], modelB: r.scoresByVersion["B-v1"], modelC: r.scoresByVersion["C-v1"], modelD: r.scoresByVersion["D-v1"] }; r.ranks = { modelA: r.ranksByVersion["A-v1"], modelB: r.ranksByVersion["B-v1"], modelC: r.ranksByVersion["C-v1"], modelD: r.ranksByVersion["D-v1"] }; });
  const compact = createCompactModelHistory(s), manifest = createDailyRunManifest({ runId: "synthetic", referenceDate: s.asOfDate, status: "PROMOTED", snapshotHash: compact.sourceSnapshotHash, compactHistoryHash: compact.contentHash, promotedAt: "2026-01-06T08:01:00+09:00" });
  let signal = identifyStoredResearchSignal(s, compact, [manifest]); assert.equal(signal.classification, "AS_PUBLISHED"); assert.notEqual(signal.availabilityEvidence, "VERIFIED");
  const receipt = { status: "VERIFIED", referenceDate: s.asOfDate, snapshotHash: compact.sourceSnapshotHash, commitSha: "a".repeat(40), runId: 17, runAttempt: 1,
    runUrl: "https://github.com/klkl789982-droid/stock-research/actions/runs/17/attempts/1", verifiedAt: "2026-01-06T08:03:00+09:00" };
  assert.equal(identifyStoredResearchSignal(s, compact, [manifest], [receipt]).availableAt, receipt.verifiedAt);
  assert.notEqual(identifyStoredResearchSignal(s, compact, [manifest], [{...receipt, snapshotHash:"wrong"}]).availabilityEvidence, "VERIFIED");
  s.publication = { status: "VERIFIED", completedAt: "2026-01-06T08:02:00+09:00", sourceSnapshotHash: compact.sourceSnapshotHash };
  signal = identifyStoredResearchSignal(s, compact, [manifest]); assert.equal(signal.availabilityEvidence, "VERIFIED");
  s.records[0].scoresByVersion["B-v1"] -= 1; assert.equal(identifyStoredResearchSignal(s, compact, [manifest]).classification, "UNVERIFIED");
});
test("observed posted list stays separate from certified backtest; requires site, structural and record evidence", () => {
  const f = fixture();
  f.options.classification = "PUBLISHED_PRICE_OBSERVATION";
  const s = f.signals[0].snapshot;
  s.dataQuality.structuralStatus = "passed"; s.dataQuality.certification = { eligibleForRanking: true, eligibleForRankBacktest: false };
  s.sourceManifest.universe.artifact.verificationStatus = "UNVERIFIED";
  s.modelVersionDefinitions = { "A-v2": { formulaHash: "specification" } };
  for (const r of s.records) r.modelDetailsByVersion = { "A-v2": { formulaHash: "specification" } };
  let result = buildModelPerformanceResearch(f);
  const published = cohort(result, "A-v2");
  assert.equal(published.stockMetrics.observationCount, 5); assert.equal(published.portfolios[0].universeReturn, 4);
  assert.notEqual(published.formulaHash, published.implementationHash);
  assert.equal(cohort(buildModelPerformanceResearch({...f,options:{...f.options,classification:"AS_PUBLISHED"}})).stockMetrics.observationCount, 0);
  s.records[0].modelDetailsByVersion["A-v2"].formulaHash = "wrong spec";
  assert.equal(cohort(buildModelPerformanceResearch(f), "A-v2").exclusionReasons.FORMULA_HASH_CONFLICT, 5);
  f.signals[0].availabilityEvidence = "UNVERIFIED";
  result = buildModelPerformanceResearch(f); assert.equal(result.cohorts.length, 0);
});
test("real repository read-only diagnostics honor existing certification; no fake winner", async () => {
  const result = await loadModelPerformanceResearch({ asOf: "2026-10-11T00:00:00Z" });
  assert.ok(result.coverage.storedSignalCount >= 8); assert.ok(result.coverage.latestStoredSignalDate <= "2026-10-11");
  assert.ok(result.cohorts.length); assert.ok(result.cohorts.some((c) => c.exclusionReasons.DATA_QUALITY_BLOCKED > 0));
  for (const c of result.cohorts) assert.equal(c.stockMetrics.observationCount, c.rows.filter((r) => r.status === "MATURE").length);
  assert.equal(result.comparison.winner, null); assert.equal(result.benchmarkStatus, "UNAVAILABLE");
  assert.deepEqual(Object.keys(result.horizonComparison), ["H1", "H5", "H20"]);
  assert.ok(result.provenance.inputFiles.every((f) => !/kis|intraday|private|runtime/.test(f.path)));
  console.log(JSON.stringify({ coverage: result.coverage, cohorts: result.cohorts.length, exclusions: result.cohorts.reduce((sum, c) => sum + c.missingCount, 0), realMature: result.cohorts.reduce((sum, c) => sum + c.stockMetrics.observationCount, 0) }));
});
