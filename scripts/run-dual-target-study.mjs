import fs from "node:fs/promises";
import {panel,frame,fit,predict,spearman,outcome,tradable,mean,round} from "../lib/dual-target-research.mjs";
import {simulateFundedPortfolio} from "../lib/funded-research-portfolio.mjs";
import {createMarketPriceLedger} from "../lib/market-price-ledger.mjs";
import {researchUniverse} from "../lib/daily-strategy-challengers.mjs";
import {taxEligibilityForStudy} from "../lib/research-sell-tax.mjs";
import {identifyStoredResearchSignal} from "../lib/model-performance-research-store.mjs";
import {hashObject} from "../lib/rank-backtest-engine.mjs";
import {FORMULA_HASHES} from "../infra/cloudflare-live-kis-diagnostic/formula-manifest.mjs";
const read=async f=>JSON.parse(await fs.readFile(f,"utf8")),cfg=await read("config/dual-target-study-v1.json"),master=await read("data/universe.json");
const seed=await read("data/analysis/market-seeds/"+cfg.through+".json"),p=panel(seed,master),dates=p.days;
const by=new Map(p.assets.map(a=>[a.code,a])), frames=dates.map((d,i)=>({date:d,i,...frame(p,i)}));
const ledgers=dates.map((d,i)=>createMarketPriceLedger(d,p.assets.filter(a=>tradable(a.bars[i])).map(a=>({code:a.code,openPrice:a.bars[i][1],closePrice:a.bars[i][4]}))));
const archive=new Map(),lineage=[],vintage=(await read("data/model-validation/top-cross-comparison-v1.json")).inventory;
const receipts=(await read("data/model-validation/daily-publication-evidence.json")).evidence;
const optional=async (file,fallback)=>{try{return await read(file)}catch(e){if(e.code==="ENOENT")return fallback;throw e;}};
for(const a of vintage){
 const s=await read("data/history/"+a.date+".json"),tax=taxEligibilityForStudy(master,[s]);
 const dir="data/daily-runs/"+a.date;let entries=[];try{entries=await fs.readdir(dir)}catch(e){if(e.code!=="ENOENT")throw e;}
 const sig=identifyStoredResearchSignal(s,await optional("data/model-history/"+a.date+".json",null),
 await Promise.all(entries.filter(f=>f.endsWith(".json")).map(f=>read(dir+"/"+f))),receipts);
 const availability=sig.classification==="AS_PUBLISHED"&&sig.availabilityEvidence==="VERIFIED"?sig.availableAt:null;
 const maps=["A","B","C","D"].map((m,i)=>{
 const k=["technical-strength","trend-strength","entry-strength","combined-technical-score"][i];
 return new Map((s.sourceManifest?.modelFormulaHashes?.[m+"-v1"]===FORMULA_HASHES["lib/"+k+".mjs"]?researchUniverse(s,m+"-v1"):[]).filter(r=>tax(a.date,{code:r.ticker,market:r.market},"2026-12-31")).map(r=>[r.ticker,r.score]));});
 archive.set(a.date,{maps,at:availability&&[availability,a.seedGeneratedAt].sort().at(-1)});
 lineage.push([a.date,sig.sourceSnapshotHash??null,hashObject(s.records.map(r=>[r.code,r.ranksByVersion,r.scores,r.qualityEligibility])),availability,a.seedHash,a.seedGeneratedAt]);
}
const inputHash=hashObject({seed:seed.contentHash,master:seed.sourceManifest.universe.contentHash,plan:cfg,lineage});
const fields={...cfg.candidates,R2NoCross:cfg.candidates.R2.filter(k=>k!==4),P2NoCross:cfg.candidates.P2.filter(k=>k!==4)}, report={version:cfg.version,through:cfg.through,seedHash:seed.contentHash,inputHash,horizons:{}};
const net=g=>((1+g)*(1-.0005)*(1-.0002-.002)/((1+.0005)*(1+.0002))-1);
const safeMean=a=>round(mean(a.filter(Number.isFinite)));
function evaluate(days,candidate,fits,h){
 const plan=[],metrics=[],cal=Array.from({length:10},()=>[0,0,0]), picks=new Map();let unavailable=0,missing=0;
 for(const d of days){
 const prob=candidate.startsWith("P")||candidate==="BASE";const fitted=prob?fits.P:fits.R;
 const list=d.rows.map(r=>({...r,z:candidate==="BASE"?fits.P.base:candidate==="MOM"?r.raw[1]:fields[candidate]?predict(fitted,r,fields[candidate]).value:r.native["ABCD".indexOf(candidate)]})).sort((a,b)=>b.z-a.z||a.code.localeCompare(b.code));
 if(list.length<20)continue;
 const top=list.slice(0,10),t20=list.slice(0,20),valid=list.filter(r=>Number.isFinite(r.y)),labels=valid.map(r=>r.y);
 const metric=(arr,fn)=>arr.length&&arr.every(r=>Number.isFinite(r.y))?mean(arr.map(fn)):null;
 plan.push({signalDate:d.date,entryDate:dates[d.entry],exitDate:dates[d.exit],tickers:top.map(r=>r.code),capacity:10});top.forEach(r=>picks.set(r.code,(picks.get(r.code)||0)+1));
 missing+=list.length-valid.length;if(!valid.length){unavailable++;continue}
 const cut=Math.floor(list.length/5),u=valid.filter(r=>r.y>0).length/valid.length;
 const upper=[...labels].sort((a,b)=>b-a)[Math.ceil(labels.length*.1)-1];
 let brier=null,loss=null;
 if(prob){brier=mean(valid.map(r=>(r.z-Number(r.y>0))**2));loss=mean(valid.map(r=>-Math.log(Math.max(1e-8,r.y>0?r.z:1-r.z))));
 for(const r of valid){const c=cal[Math.min(9,Math.floor(r.z*10))],w=1/valid.length;c[0]+=w;c[1]+=w*r.z;c[2]+=w*Number(r.y>0);}}
 const market=mean(list.map(r=>r.raw[1]))>=0?"up":"down";
 metrics.push({ic:spearman(valid.map(r=>r.z),labels),top10:metric(top,r=>100*r.y),top20:metric(t20,r=>100*r.y),hit:metric(top,r=>100*Number(r.y>0)),netHit:metric(top,r=>100*Number(net(r.y)>0)),base:100*u,large:metric(top,r=>100*Number(r.y>=upper)),middle:metric(list.slice(2*cut,3*cut),r=>100*r.y),bottom:metric(list.slice(-cut),r=>100*r.y),upper:metric(list.slice(0,cut),r=>100*r.y),brier,loss,market,hot:mean(top.map(r=>Number(r.x[2]>.8))),chase:mean(top.map(r=>Number(r.x[0]>.9)))});
 }
 const agg=Object.fromEntries(["ic","top10","top20","hit","netHit","base","large","middle","bottom","upper","brier","loss","hot","chase"].map(k=>[k,safeMean(metrics.map(r=>r[k]))]));
 const a=simulateFundedPortfolio({selections:plan,ledgers,calendar:p.calendar,holdingDays:h,cost:cfg.cost,fixedSlots:10,endDate:plan.at(-1)?.exitDate});
 const pnl=new Map(),timePnl=new Map();for(const t of a.trades??[]){let profit=t.proceeds-t.outlay;for(const [map,key] of [[pnl,t.ticker],[timePnl,t.exitDate.slice(0,7)]])map.set(key,(map.get(key)||0)+profit);}
 const concentration=map=>{let v=[...map.values()].map(Math.abs);return v.length&&v.reduce((a,b)=>a+b)>0?round(Math.max(...v)/v.reduce((a,b)=>a+b)*100):null};
 return {candidate,days:plan.length,topCompleteDays:metrics.filter(v=>v.top10!==null).length,unavailable,missingLabels:missing,...agg,
 calibration:cal.flatMap(([w,pred,obs],bin)=>w?[{bin,pred:round(pred/w),actual:round(obs/w),dayWeight:round(w)}]:[]),
 regime:Object.fromEntries(["up","down"].map(k=>[k,{days:metrics.filter(r=>r.market===k).length,top10:safeMean(metrics.filter(r=>r.market===k).map(r=>r.top10))}])),
 selectedCodes:picks.size,mostSelectedDayShare:plan.length?round(Math.max(...picks.values())/plan.length):null,
 account:{status:a.status,reason:a.reason,net:a.totalReturn,mdd:a.maxDrawdown,exposure:a.averageExposurePct,trades:a.tradeCount,tickerPnlPct:concentration(pnl),monthPnlPct:concentration(timePnl)}};
}
for(const h of cfg.horizons){
 const make=(f,entry)=>({...f,entry,exit:entry+h-1,rows:f.rows.map(r=>({...r,y:outcome(by.get(r.code),entry,h)}))});
 const days=frames.filter(f=>f.rows.length>=20&&f.i+h+1<dates.length).map(f=>make(f,f.i+2));
 const folds=[],byFold=[];let chosen;
 for(let k=0;k<cfg.folds.length;k++){
 const start=cfg.folds[k],end=cfg.folds[k+1]??"9999",train=days.filter(d=>dates[d.exit]<start),test=days.filter(d=>d.date>=start&&dates[d.exit]<end);
 const fits={R:fit(train,"R"),P:fit(train,"P")};
 const results=["R1","R2","P1","P2","BASE","MOM"].map(c=>evaluate(test,c,fits,h));
 if(k===0){const pick=(options,key,order)=>results.filter(r=>options.includes(r.candidate)&&Number.isFinite(r[key])).sort((a,b)=>order*(a[key]-b[key]))[0]?.candidate;
 chosen={R:pick(["R1","R2"],"ic",-1)??"R1",P:pick(["P1","P2"],"brier",1)??"P1"};}
 // Descriptive diagnostics, never inputs to candidate selection.
 const factors=Array.from({length:6},(_,j)=>{const perDay=test.map(d=>{
   const rs=d.rows.filter(r=>Number.isFinite(r.y)),top=rs.filter(r=>j===4?r.raw[j]===1:r.x[j]>=.8),rest=rs.filter(r=>j===4?r.raw[j]===0:r.x[j]<.8);
   return {ic:spearman(rs.map(r=>r.raw[j]),rs.map(r=>r.y)),edge:top.length&&rest.length?100*(mean(top.map(r=>r.y))-mean(rest.map(r=>r.y))):null,
    hitEdge:top.length&&rest.length?100*(mean(top.map(r=>+(r.y>0)))-mean(rest.map(r=>+(r.y>0)))):null};
 });return Object.fromEntries(["ic","edge","hitEdge"].map(k=>[k,safeMean(perDay.map(v=>v[k]))]));});
 const ablation=["R2NoCross","P2NoCross"].map(c=>evaluate(test,c,fits,h));
 folds.push({start,end:k===2?cfg.through:end,trainingDays:train.length,trainingExit:dates[train.at(-1).exit],dates:test.length,results,factors,ablation});byFold.push({start,fits});
 }
 const comparisons={};for(const layer of ["reconstructed","publishedTiming"]){
 const matched=new Map();
 for(const f of frames){const a=archive.get(f.date);if(!a||f.date<cfg.folds[2])continue;
 const entry=layer==="publishedTiming"?a.at?dates.findIndex(d=>d>f.date&&Date.parse(d+"T09:00:00+09:00")>Date.parse(a.at)):-1:f.i+2;
 if(entry<0||entry+h-1>=dates.length)continue;const d=make(f,entry);
 d.rows=d.rows.flatMap(r=>{let native=a.maps.map(m=>m.get(r.code));return native.every(Number.isFinite)?[{...r,native}]:[]});
 if(d.rows.length>=20)matched.set(entry,d);}
 const ds=[...matched.values()].sort((a,b)=>a.entry-b.entry);comparisons[layer]=[chosen.R,chosen.P,"A","B","C","D","MOM","BASE"].map(c=>evaluate(ds,c,byFold[2].fits,h));
 }
 const lastFit={R:fit(days,"R"),P:fit(days,"P")};
 report.horizons[h]={chosen,folds,comparisons,lastFit,matureDays:days.length,immatureDates:frames.filter(f=>f.rows.length>=20&&f.i+h+1>=dates.length).length};
}
await fs.writeFile("data/model-validation/dual-target-aggregate-v1.json",JSON.stringify(report)+"\n");
console.log("Aggregate only:",inputHash,Object.entries(report.horizons).map(([h,v])=>[h,v.matureDays,v.chosen]));
