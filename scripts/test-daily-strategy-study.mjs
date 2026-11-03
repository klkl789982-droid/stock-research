import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { inputLineage, makeSelections, marketConditions, researchUniverse } from "../lib/daily-strategy-challengers.mjs";
import { executionWindow, runStrategyStudy } from "../lib/daily-strategy-study.mjs";
import { simulateFundedPortfolio } from "../lib/funded-research-portfolio.mjs";
import { hashObject } from "../lib/rank-backtest-engine.mjs";
import { loadModelRegistry } from "../lib/model-registry.mjs";
import { prepareMarketPriceLedgers } from "../lib/future-return-resolver.mjs";

const plan = JSON.parse(await fs.readFile("config/daily-strategy-research-v1.json"));
const entry = (model) => plan.candidates.find((c) => c.changedFrom === model);
const v = "a".repeat(64), definition = "b".repeat(64);
const versions = ["A-v1","B-v1","C-v1","D-v1"];
const snapshot = { asOfDate:"2026-10-19", signalComputedAt:"2026-10-20T07:00:00Z",
  dataQuality:{certification:{eligibleForRanking:true,eligibleForRankBacktest:false}},
  sourceManifest:{sources:{officialDailyPrice:{provider:"공공데이터포털"}}, modelFormulaHashes:Object.fromEntries([...versions,"A-v2"].map((m) => [m,v]))},
  modelVersionDefinitions:{"A-v2":{formulaHash:definition}},
  records:Array.from({length:12},(_,i) => ({
    code:String(300000+i),market:"KOSPI",qualityEligibility:{eligible:true},
    scoresByVersion:Object.fromEntries(versions.map((m) => [m,m==="B-v1"?100-i*3:m==="C-v1"?75+i:90-i])),
    ranksByVersion:Object.fromEntries(versions.map((m) => [m,m==="C-v1"?12-i:i+1])),
    modelDetailsByVersion:{"A-v2":{formulaHash:definition,rawIndicators:{priceMomentum:i-9,volatility20:1+i%3}}},
    riskFlags:{overbought:i===9},factors:{riskPenalty:i%3}
  })) };
const frozen = structuredClone(snapshot);
const rows = researchUniverse(snapshot,"A-v1");
assert.equal(rows.length,12);
assert.equal(marketConditions(rows).get("KOSPI").band,"down");
const select = (model) => makeSelections(researchUniverse(snapshot,model),model,entry(model));
assert.equal(select("B-v1").find((s) => s.id==="B-v2-research").members.length,0);
assert.equal(select("C-v1").find((s) => s.id==="C-v3-research").members.length,9);
assert.equal(select("D-v1").find((s) => s.id==="D-v1-cap5pct").allocationFraction,0.5);
assert.deepEqual(select("D-v1").find((s) => s.id==="D-v3-research").members.map((r) => r.ticker),
  [...researchUniverse(snapshot,"D-v1")].sort((a,b) => Math.min(b.b,b.c)-Math.min(a.b,a.c)||a.rank-b.rank).slice(0,10).map((r) => r.ticker));
assert.ok(inputLineage(snapshot,"A-v1"));
const bad = structuredClone(snapshot);bad.records[0].modelDetailsByVersion["A-v2"].formulaHash=v;
assert.equal(inputLineage(bad,"A-v1"),null);
bad.records[1].ranksByVersion["A-v1"]=1;assert.deepEqual(researchUniverse(bad,"A-v1"),[]);
bad.records[0].modelDetailsByVersion["A-v2"].rawIndicators.volatility20=null;
assert.ok(!makeSelections(researchUniverse(bad,"B-v1"),"B-v1",entry("B-v1")).some((s) => s.id==="B-v2-research"));
const days = ["19","20","21","22","23","26","27","28"].map((day) => "2026-10-"+day);
const calendar={dates:Object.fromEntries(days.map((day) => [day,{status:"tradingDay"}]))};
assert.equal(executionWindow(snapshot,calendar,5,[days[0],days[4]]).reason,"PURGED_CROSS_BOUNDARY");
assert.equal(executionWindow({...snapshot, signalComputedAt:days[2]+"T09:01:00+09:00"},calendar,1,plan.chronologicalCheck).reason,"GENERATION_NOT_BEFORE_ENTRY");
const ledgers = days.map((date) => ({schemaVersion:2,date,source:"data-go-kr-official-daily-price",records:snapshot.records.map((r,i) => ({code:r.code,date,executable:true,openPrice:100,closePrice:99+i}))}));
const inputs = { snapshots:[snapshot], plan, calendar, ledgers,
  ledgerMap:new Map(prepareMarketPriceLedgers(ledgers).map((l) => [l.date,l])), simulate:simulateFundedPortfolio };
const result = runStrategyStudy(inputs);
const c = result.cohorts.find((s) => s.model==="C-v1");
assert.equal(c.strategies["C-v3-research"].matureLegs,9);
assert.equal(c.strategies["C-v3-research"].account.tradeCount,9);
assert.equal(c.strategies["C-v3-research"].completeDates,1); // nine fills, one intentional cash slot
assert.equal(c.strategies["C-v1"].meanNetMinusOfficialIndex,null);
assert.equal(result.evidence[days[0]].certifiedForRankBacktest,false);
assert.equal(result.promotion,"DISABLED");
assert.deepEqual(snapshot,frozen);
const poisoned=structuredClone(snapshot);
for(const r of poisoned.records) {r.futureReturns={future1dReturn:777}; r.executionReturnsByPolicy={"public-eod-t2-open-v1":{returns:{holding1dReturn:777}}};}
assert.deepEqual(runStrategyStudy({...inputs,snapshots:[poisoned]}).cohorts,result.cohorts);
assert.throws(() => runStrategyStudy({...inputs,snapshots:[{...snapshot,asOfDate:plan.prospectiveStart}]}),/cutoff/);
const registry = await loadModelRegistry(), implementation=(await fs.readFile("lib/daily-strategy-challengers.mjs","utf8")).replaceAll("\r\n","\n");
for (const candidate of plan.candidates) {
  const m = registry.models.find((r) => r.modelVersion===candidate.modelId+"-"+candidate.version);
  assert.equal(m.evaluationOnly,true);assert.equal(m.formulaHash,hashObject({candidate,implementation}));
}
console.log("PASS: candidate lineage, missing inputs, cash, chronological purge, opportunity timing, future leakage, immutable originals, funded execution and prospective lock.");
