import assert from "node:assert/strict";
import fs from "node:fs/promises";
import {panel,frame,fit,predict,outcome} from "../lib/dual-target-research.mjs";
const load=async f=>JSON.parse(await fs.readFile(f,"utf8"));
const seed=await load("data/analysis/market-seeds/2026-11-02.json"),p=panel(seed,await load("data/universe.json")),base=await load("data/model-validation/dual-target-aggregate-v1.json");
const raw=new Map(seed.records.map(r=>[r.code,new Map(r.rows.map(b=>[b[0],b]))])),assets=new Map(p.assets.map(a=>[a.code,a]));
const frames=p.days.map((date,i)=>({date,i,...frame(p,i)}));
const dates=[...new Set(seed.records.flatMap(r=>r.rows.map(b=>b[0])))].sort();
const avg=a=>a.reduce((s,x)=>s+x,0)/a.length;
for(const h of [5,20]){
 const days=frames.filter(d=>d.rows.length>=20&&d.i+h+1<p.days.length).map(d=>({...d,exit:p.days[d.i+h+1],rows:d.rows.map(r=>({...r,y:outcome(assets.get(r.code),d.i+2,h)}))}));
 const train=days.filter(d=>d.exit<"2026-09-01"),test=days.filter(d=>d.date>="2026-09-01"),model=fit(train,"P"),bins=Array.from({length:6},()=>Array.from({length:5},()=>[0,0]));
 const baseP=avg(train.map(d=>{const rs=d.rows.filter(r=>r.y!==null);for(const r of rs)for(let j=0;j<6;j++){const b=bins[j][Math.min(4,Math.floor(r.x[j]*5))];b[0]+=+(r.y>0)/rs.length;b[1]+=1/rs.length;}return avg(rs.map(r=>+(r.y>0)));}));
 assert.ok(Math.abs(baseP-model.base)<1e-10);
 const get=(r,k)=>{const pos=Math.max(0,Math.min(4,5*r.x[k]-.5)),i=Math.floor(pos),frac=pos-i,cell=b=>(bins[k][b][0]+2*baseP)/(bins[k][b][1]+2);return (1-frac)*cell(i)+frac*cell(Math.min(i+1,4))};
 const brier=[],hits=[],actual=[],baseline=[];let example;
 for(const d of test){const rs=d.rows.filter(r=>r.y!==null),all=d.rows.map(r=>[r,avg([3,0,1,4,5].map(k=>get(r,k)))]).sort((a,b)=>b[1]-a[1]||a[0].code.localeCompare(b[0].code));
 for(const [r,q] of all)assert.ok(Math.abs(q-predict(model,r,[3,0,1,4,5]).value)<1e-10);
 const idx=dates.indexOf(d.date.replaceAll("-",""));const entry=dates[idx+2],exit=dates[idx+1+h];assert.equal(exit,d.exit.replaceAll("-",""));
 for(const r of rs){const src=raw.get(r.code),open=src.get(entry)[1],close=src.get(exit)[4];assert.equal(close/open-1,r.y);assert.equal(+(close>open),+(r.y>0));if(r.code==="005930"&&!example){assert.equal(r.raw[0],src.get(dates[idx])[4]/src.get(dates[idx-5])[4]-1);example={signal:d.date,code:r.code,entry,exit,open,close,up:close>open};}}
 const mature=all.filter(([r])=>r.y!==null);brier.push(avg(mature.map(([r,q])=>(q-+(r.y>0))**2)));baseline.push(avg(rs.map(r=>(baseP-+(r.y>0))**2)));actual.push(avg(rs.map(r=>+(r.y>0))));
 if(all.slice(0,10).every(([r])=>r.y!==null))hits.push(avg(all.slice(0,10).map(([r])=>+(r.y>0))));
 }
 const frozen=base.horizons[h].folds.at(-1).results.find(x=>x.candidate==="P2");
 assert.equal(+avg(brier).toFixed(5),frozen.brier);assert.equal(+(100*avg(hits)).toFixed(5),frozen.hit);
 console.log(JSON.stringify({h,example,trainBase:baseP,realized:avg(actual),brier:avg(brier),baseBrier:avg(baseline),pairedDays:hits.length}));
}
