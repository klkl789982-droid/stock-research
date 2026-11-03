import assert from "node:assert/strict";
import {summarizeAccount} from "../lib/top-cross-comparison.mjs";
import {matchedBenchmark} from "../lib/model-performance-research.mjs";
import {readFile} from "node:fs/promises";
import {hashObject} from "../lib/rank-backtest-engine.mjs";
import {compareOfficialMarkets} from "../lib/top-cross-benchmark.mjs";
const report=JSON.parse(await readFile("data/model-validation/top-cross-comparison-v1.json")),plan=JSON.parse(await readFile("config/top-cross-comparison-v1.json"));
assert.equal(report.planHash,hashObject(plan));
const zero=summarizeAccount({status:"VALUED",trades:[],startingCapitalKrw:1e8,totalReturn:0,maxDrawdown:0,averageExposurePct:0,nav:[{date:"2000-01-01"}]},()=>null,[],0);
assert.equal(zero.status,"CASH_ONLY");assert.equal(zero.win,null);assert.equal(zero.cashPct,100);
assert.equal(summarizeAccount({status:"UNAVAILABLE",reason:"MARK_OR_EXIT_UNAVAILABLE"}).reason,"MARK_OR_EXIT_UNAVAILABLE");
assert.equal(matchedBenchmark({market:"KOSDAQ",entryDate:"2026-10-01",exitDate:"2026-10-08"},[],Date.now()),null);
for(const model of [plan.primary,...plan.secondary])for(const layer of ["daily","published"]){
  const r=report.summary.filter(s=>s.basis==="COMMON"&&s.model===model&&s.layer===layer);assert.equal(r.length,3);
  assert.ok(r.every(v=>v.from===r[0].from&&v.to===r[0].to&&v.commonDays===r[0].commonDays));
  assert.ok(r.every(v=>v.exposure>=0&&v.exposure<=100&&Math.abs(v.exposure+v.cashPct-100)<1e-5));
}
console.log("Frozen contract, segregated layers, comparable dates and zero-trade behavior passed");
const window={entryDate:"2026-10-01",exitDate:"2026-10-08"};
const sample={summary:[{from:window.entryDate,to:window.exitDate,total:2,trades:1,weights:[{...window,market:"KOSPI",fraction:.1,n:1}]}]};
const leg={...window,market:"KOSPI",entryBasis:"officialDailyOpen",exitBasis:"officialDailyClose",source:"official-index",returnPercent:10,provenance:{verified:true,observedAt:"2026-10-09T00:00:00Z",sourceHash:"a".repeat(64)}};
for(const market of ["KOSPI","KOSDAQ"]){
  const [r]=await compareOfficialMarkets(sample,null,{archive:async()=>[{...leg,market}],seriesReader:async()=>[]});
  assert.equal(r.marketMatched,market==="KOSPI"?1:null);assert.equal(r.excess,market==="KOSPI"?1:null);
}
