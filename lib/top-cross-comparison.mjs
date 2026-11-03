import {researchUniverse,median} from "./daily-strategy-challengers.mjs";
import {matchedBenchmark} from "./model-performance-research.mjs";
import {FORMULA_HASHES} from "../infra/cloudflare-live-kis-diagnostic/formula-manifest.mjs";
const source={"A-v1":"technical-strength","B-v1":"trend-strength","C-v1":"entry-strength","D-v1":"combined-technical-score"};
const avg=a=>a.length?a.reduce((x,y)=>x+y,0)/a.length:null;
export function selectThree(snapshot,model,transitions,taxEligible){
  const ranked=researchUniverse(snapshot,model), byCode=new Map(transitions.map(r=>[r.code,r]));
  const pool=[], excluded=[];
  for(const r of ranked){
    const t=byCode.get(r.ticker);
    const reason=!t?.transitions?.["5-20"]?(t?.missingReasons?.join(",")||"NO_MA"):!taxEligible(r)?"TAX_BASIS_UNKNOWN":null;
    if(reason){excluded.push([r.ticker,reason]);continue;}
    pool.push({code:r.ticker,market:r.market,rank:r.rank,cross:t.transitions["5-20"].status==="CROSS_OCCURRED"});
  }
  const top=pool.filter(r=>r.rank<=10), entrants=pool.filter(r=>r.cross).sort((a,b)=>a.code.localeCompare(b.code));
  const current=snapshot.sourceManifest?.modelFormulaHashes?.[model]===FORMULA_HASHES["lib/"+source[model]+".mjs"];
  const native=ranked.filter(r=>r.rank<=10);
  const nativeTOP=current&&native.length===10&&native.every(taxEligible)?native.map(r=>({code:r.ticker,market:r.market})):null;
  const certified=new Set(ranked.map(r=>r.ticker));
  for(const r of snapshot.records)if(!certified.has(r.code))excluded.push([r.code,"NOT_QUALITY_ELIGIBLE_OR_MODEL_RANK_UNAVAILABLE"]);
  return {status:!current?"FORMULA_LINEAGE_MISMATCH":!ranked.length?"NO_CERTIFIED_RANKS":top.length!==10?"ORIGINAL_TOP10_INCOMPLETE":"READY",nativeTOP,pool,excluded,
    TOP:top.map(r=>r.code),CROSS:entrants.slice(0,10).map(r=>r.code),BOTH:top.filter(r=>r.cross).map(r=>r.code)};
}
export function summarizeAccount(account,marketOf,benchmarks,asOf){
  if(account.status!=="VALUED")return {status:account.status,reason:account.reason};
  if(account.openPositions)throw Error("MATURE_STUDY_HAS_OPEN_POSITIONS");
  const t=account.trades,returns=t.map(x=>x.netPct), byStock={},byExit={};let indexPnl=0,matched=0;
  for(const trade of t){
    const match=matchedBenchmark({...trade,market:marketOf(trade)},benchmarks,asOf);
    if(match){indexPnl+=trade.outlay*match.returnPercent/100;matched++;}
    byStock[trade.ticker]=(byStock[trade.ticker]??0)+Math.abs(trade.pnl);
    byExit[trade.exitDate]=(byExit[trade.exitDate]??0)+Math.abs(trade.pnl);
  }
  const concentration=g=>{const v=Object.values(g),s=v.reduce((x,y)=>x+y,0);return s?100*Math.max(...v)/s:null;};
  const benchmark=matched===t.length?indexPnl/account.startingCapitalKrw*100:null;
  return {status:t.length?"VALUED":"CASH_ONLY",total:account.totalReturn,mdd:account.maxDrawdown,marketMatched:benchmark,excess:benchmark===null?null:account.totalReturn-benchmark,
    matchedTrades:matched,trades:t.length,signals:new Set(t.map(v=>v.signalDate)).size,stocks:new Set(t.map(v=>v.ticker)).size,
    mean:avg(returns),median:median(returns),win:t.length?100*returns.filter(x=>x>0).length/t.length:null,
    exposure:account.averageExposurePct,cashPct:100-account.averageExposurePct,stockConcentration:concentration(byStock),exitConcentration:concentration(byExit),
    from:account.nav[0].date,to:account.nav.at(-1).date};
}
