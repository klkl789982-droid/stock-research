import fs from "node:fs/promises";
import {panel,frame,fit,predict,outcome,tradable,mean,round,spearman,midranks} from "../lib/dual-target-research.mjs";
import {features,trainChallengers,estimate} from "../lib/dual-challenger.mjs";
import {simulateFundedPortfolio} from "../lib/funded-research-portfolio.mjs";
import {createMarketPriceLedger} from "../lib/market-price-ledger.mjs";
import {researchUniverse} from "../lib/daily-strategy-challengers.mjs";
import {FORMULA_HASHES} from "../infra/cloudflare-live-kis-diagnostic/formula-manifest.mjs";
import {hashObject} from "../lib/rank-backtest-engine.mjs";
const read=async f=>JSON.parse(await fs.readFile(f,"utf8")),cfg=await read("config/dual-target-challenger-v2.json"),root="data/analysis/market-seeds/";
const [seed,old,master,v1,v1plan,vintage]=await Promise.all([read(root+cfg.through+".json"),read(root+cfg.olderSeed+".json"),read("data/universe.json"),read("data/model-validation/dual-target-aggregate-v1.json"),read("config/dual-target-study-v1.json"),read("data/model-validation/top-cross-comparison-v1.json")]);
const base=panel(seed,master);panel(old,master);const calendar=base.calendar,older=new Map(old.records.map(r=>[r.code,r])),counts=new Map();
let conflicts=0,added=0;
const prep=seed.records.map(r=>{const s=new Map(r.rows.map(b=>[b[0],b])),early=older.get(r.code)?.rows??[],first=r.rows.at(-1)?.[0];
 const inconsistent=early.some(b=>s.has(b[0])&&JSON.stringify(b)!==JSON.stringify(s.get(b[0])));if(inconsistent)conflicts++;
 if(!inconsistent&&first&&r.eligible)for(const b of early)if(b[0]<first&&!s.has(b[0])){s.set(b[0],b);added++;}
 for(const d of s.keys())if(d.startsWith("2025"))counts.set(d,(counts.get(d)||0)+1);return s;});
const prior=[...counts].filter(([,n])=>n>=300).map(([d])=>d).sort(),iso=d=>d.slice(0,4)+"-"+d.slice(4,6)+"-"+d.slice(6);
const days=[...prior.map(iso),...base.days],assets=base.assets.map((a,j)=>({...a,bars:[...prior.map(d=>prep[j].get(d)),...a.bars]})),p={...base,assets,days};
const by=new Map(assets.map(a=>[a.code,a])),frames=days.map((date,i)=>({date,i,...features(p,i)}));
const control=base.days.map((date,i)=>({date,i,...frame(base,i)})),cb=new Map(base.assets.map(a=>[a.code,a]));
const ledgers=base.days.map((d,i)=>createMarketPriceLedger(d,base.assets.filter(a=>tradable(a.bars[i])).map(a=>({code:a.code,openPrice:a.bars[i][1],closePrice:a.bars[i][4]}))));
const archive=new Map();for(const day of vintage.inventory){
 const s=await read("data/history/"+day.date+".json");archive.set(day.date,{at:day.published&&[day.published,day.seedGeneratedAt].sort().at(-1),maps:["A","B","C","D"].map((m,i)=>{
 const key=["technical-strength","trend-strength","entry-strength","combined-technical-score"][i];return new Map((s.sourceManifest?.modelFormulaHashes?.[m+"-v1"]===FORMULA_HASHES["lib/"+key+".mjs"]?researchUniverse(s,m+"-v1"):[]).map(r=>[r.ticker,r.score]));})});}
function targetDays(frames,ds,map,h){return frames.filter(f=>f.rows.length>=20&&f.i+h+1<ds.length).map(f=>({...f,entry:ds[f.i+2],exitDate:ds[f.i+1+h],rows:f.rows.map(r=>({...r,y:outcome(map.get(r.code),f.i+2,h)}))}));}
const metricAvg=a=>round(mean(a.filter(Number.isFinite))),prob=id=>["BASE","P1","P2","P3","P3raw"].includes(id);
function score(fits,r,k){
 if(k==="BASE")return fits.P.base;if(k==="MOM")return r.raw[1];if(k==="R3"||k==="P3"||k==="P3raw")return estimate(fits.v2,r,k==="R3"?"R":k==="P3"?"P":"Praw");
 if(k.length===1)return r.native["ABCD".indexOf(k)];return predict(fits[k[0]],r,v1plan.candidates[k]).value;
}
const avgPct=(r,fn)=>r.length&&r.every(x=>Number.isFinite(x.y))?100*mean(r.map(fn)):null;
function evaluate(ds,k,fits,h){
 const ms=[],plans=[],bins=Array.from({length:10},()=>[0,0,0]);let missing=0;
 for(const d of ds){
 const all=d.rows.map(r=>({...r,z:score(fits,r,k)})).sort((a,b)=>b.z-a.z||a.code.localeCompare(b.code)),valid=all.filter(r=>Number.isFinite(r.y)),top=all.slice(0,10),targets=valid.map(r=>r.y),up=r=>+(r.y>0);
 missing+=all.length-valid.length;plans.push({signalDate:d.date,entryDate:d.entry,exitDate:d.exitDate,capacity:10,tickers:top.map(r=>r.code)});
 if(!valid.length)continue;const rate=mean(valid.map(up)),avg=mean(targets),ordered=[...targets].sort((a,b)=>a-b),n=Math.floor(all.length/5);
 const hit=avgPct(top,up),ret=avgPct(top,r=>r.y),m={date:d.date,ic:spearman(valid.map(r=>r.z),targets),hit,ret,base:100*rate,edge:ret===null?null:ret-100*avg,lift:hit===null?null:hit-100*rate,
 top20:avgPct(all.slice(0,20),r=>r.y),upper:avgPct(all.slice(0,n),r=>r.y),middle:avgPct(all.slice(2*n,3*n),r=>r.y),bottom:avgPct(all.slice(-n),r=>r.y),
 winners:avgPct(top,r=>+(r.y>=ordered[Math.ceil(.9*ordered.length)-1])),losers:avgPct(top,r=>+(r.y<=ordered[Math.floor(.1*ordered.length)])),obs:valid.length};
 if(prob(k)){const ranks=midranks(valid.map(r=>r.z)),pos=valid.filter(r=>r.y>0).length;
 m.auc=pos>0&&pos<valid.length?(mean(ranks.filter((_,i)=>valid[i].y>0))-.5*rate)/(1-rate):null;
 m.brier=mean(valid.map(r=>(r.z-up(r))**2));m.loss=mean(valid.map(r=>-Math.log(Math.max(1e-12,r.y>0?r.z:1-r.z))));
 const dailyPred=mean(valid.map(r=>r.z));m.bias=dailyPred-rate;
 m.marketError=(dailyPred-rate)**2;
 m.withinError=m.brier-m.marketError;
 m.spread=Math.max(...valid.map(r=>r.z))-Math.min(...valid.map(r=>r.z));
 for(const r of valid){const b=bins[Math.min(9,Math.floor(r.z*10))];b[0]+=1/valid.length;b[1]+=r.z/valid.length;b[2]+=up(r)/valid.length;}}
 ms.push(m);}
 const acc=simulateFundedPortfolio({selections:plans,ledgers,calendar,holdingDays:h,cost:v1plan.cost,fixedSlots:10,endDate:plans.at(-1)?.exitDate});
 const conc=key=>{const map=new Map();for(const r of acc.trades??[])map.set(r[key],(map.get(r[key])??0)+r.pnl);const z=[...map.values()].map(Math.abs);return z.length?round(100*Math.max(...z)/z.reduce((a,b)=>a+b,0)):null;};
 return {id:k,days:ms.length,missing,pairedTopDays:ms.filter(m=>m.lift!==null).length,metrics:Object.fromEntries(["ic","edge","lift","hit","ret","base","auc","brier","loss","bias","marketError","withinError","spread","upper","middle","bottom","winners","losers","top20"].map(key=>[key,metricAvg(ms.map(m=>m[key]))])),
 calibration:bins.filter(b=>b[0]).map(b=>b.map((v,j)=>round(j?v/b[0]:v))),account:{status:acc.status,reason:acc.reason,net:acc.totalReturn,mdd:acc.maxDrawdown,exposure:acc.averageExposurePct,trades:acc.tradeCount,stock:conc("ticker"),date:conc("exitDate")},daily:ms.map(m=>[m.date,round(m.ic),round(m.edge),round(m.lift),round(m.brier),m.obs])};
}
const result={version:cfg.version,through:cfg.through,protocolHash:hashObject(cfg),baselineHash:hashObject(v1),seeds:[old.contentHash,seed.contentHash],extension:{from:days[0],additionalRows:added,overlapConflictCodes:conflicts,extraSessions:prior.length},status:"RESEARCH_ONLY",horizons:{}};
for(const h of [5,20]){
 const ds=targetDays(frames,days,by,h),controls=targetDays(control,base.days,cb,h),folds=[];let lastFit;
 for(let j=0;j<3;j++){const start=cfg.folds[j],end=cfg.folds[j+1]??"9999",train=ds.filter(d=>d.exitDate<start),vtrain=controls.filter(d=>d.exitDate<start),test=ds.filter(d=>d.date>=start&&d.exitDate<end);
 const fits={v2:trainChallengers(train),R:fit(vtrain,"R"),P:fit(vtrain,"P")};lastFit=fits;
 const ids=["R1","P2","BASE","MOM","R3","P3raw","P3",...(h===20?["P1"]:[])],runs=ids.map(k=>evaluate(test,k,fits,h));
 const find=k=>runs.find(r=>r.id===k).metrics,r=find("R3"),p=find("P3"),b=find("BASE"),rr=find("R1"),pp=find("P2");
 const paired=(candidate,control,col)=>{const baseline=new Map(runs.find(x=>x.id===control).daily.map(x=>[x[0],x[col]]));
   const pairs=runs.find(x=>x.id===candidate).daily.filter(x=>Number.isFinite(x[col])&&Number.isFinite(baseline.get(x[0])));
   return {days:pairs.length,candidate:mean(pairs.map(x=>x[col])),control:mean(pairs.map(x=>baseline.get(x[0])))};};
 const pairs={R:paired("R3","R1",2),P:paired("P3","P2",3)};
 const pass={R:r.ic>0&&r.ic>=rr.ic+.01&&pairs.R.candidate>0&&pairs.R.candidate>pairs.R.control,P:pairs.P.candidate>=1&&pairs.P.candidate>pairs.P.control&&p.auc>.5&&p.brier<=Math.min(b.brier,pp.brier)-.001};
 folds.push({start,training:train.length,controlDays:vtrain.length,fitCutoffs:[fits.v2.coreEnd,fits.v2.calibrationStart,fits.v2.trainEnd],days:test.length,pairs,pass,runs});}
 const common={};for(const layer of ["reconstructed","publishedTiming"]){
 const picked=new Map();for(const d of ds){const a=archive.get(d.date);if(!a||d.date<cfg.folds[2])continue;const en=layer==="reconstructed"?d.i+2:a.at?days.findIndex(day=>day>d.date&&Date.parse(day+"T09:00:00+09:00")>Date.parse(a.at)):-1;
 if(en<0||en+h>days.length)continue;const rows=d.rows.flatMap(r=>{const native=a.maps.map(m=>m.get(r.code));return native.every(Number.isFinite)?[{...r,native,y:outcome(by.get(r.code),en,h)}]:[]});if(rows.length>=20)picked.set(en,{...d,rows,entry:days[en],exitDate:days[en+h-1]});}
 common[layer]=["R1","P2","R3","P3","A","B","C","D"].map(k=>evaluate([...picked.values()].sort((a,b)=>a.entry.localeCompare(b.entry)),k,lastFit,h));}
 const summary={trainDays:ds.length,from:ds[0].date,observations:ds.reduce((n,d)=>n+d.rows.filter(r=>r.y!==null).length,0),featureEligible:frames.reduce((n,f)=>n+f.rows.length,0),featurePossible:frames.length*assets.length};
 result.horizons[h]={summary,folds,common,final:trainChallengers(ds),gate:{R:folds.every(f=>f.pass.R),P:folds.every(f=>f.pass.P)}};
}
await fs.writeFile("data/model-validation/dual-challenger-v2.json",JSON.stringify(result)+"\n");console.log(result.extension,Object.values(result.horizons).map(v=>[v.summary,v.gate]));
