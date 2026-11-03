import { loadPrivateBenchmarkLegs,loadResearchIndexSeries,deriveMarketBenchmarkLegs,indexLegKey } from "./research-index-benchmarks.mjs";
import { matchedBenchmark } from "./model-performance-research.mjs";
import {hashObject} from "./rank-backtest-engine.mjs";
/** Authenticated research read path. Only dates from the frozen report are used. */
export async function compareOfficialMarkets(report,indexRequest,{archive=loadPrivateBenchmarkLegs,seriesReader=loadResearchIndexSeries}={}){
  const pairs=new Map();
  for(const s of report.summary){
    for(const w of s.weights)pairs.set(w.entryDate+"/"+w.exitDate,{entryDate:w.entryDate,exitDate:w.exitDate});
    if(s.from&&s.to)pairs.set(s.from+"/"+s.to,{entryDate:s.from,exitDate:s.to});
  }
  const periods=[...pairs.values()],saved=await archive(periods),keys=new Set(saved.map(indexLegKey));
  const gaps=periods.filter(p=>["KOSPI","KOSDAQ"].some(m=>!keys.has(indexLegKey({...p,market:m}))));
  const series=await seriesReader(gaps.flatMap(p=>[p.entryDate,p.exitDate]),indexRequest);
  const legs=[...saved,...deriveMarketBenchmarkLegs(series,gaps).filter(l=>!keys.has(indexLegKey(l)))],asOf=Date.now();
  return report.summary.map(s=>{
    const {weights,...rest}=s;let pnl=0,matched=0;const evidence=[];
    for(const w of weights){const l=matchedBenchmark(w,legs,asOf);if(l){pnl+=w.fraction*l.returnPercent;matched+=w.n;evidence.push([indexLegKey(w),l.sourceHash,l.returnPercent,w.fraction]);}}
    const benchmark=Number.isFinite(s.total)&&matched===s.trades?pnl:null;
    return {...rest,matchedTrades:matched,marketMatched:benchmark,benchmarkEvidenceHash:evidence.length?hashObject(evidence):null,excess:benchmark===null?null:s.total-benchmark,
      indices:Object.fromEntries(["KOSPI","KOSDAQ"].map(m=>[m,matchedBenchmark({market:m,entryDate:s.from,exitDate:s.to},legs,asOf)?.returnPercent??null]))};
  });
}
