import assert from "node:assert/strict";
import {regress,estimate,challengerRanks} from "../lib/dual-challenger.mjs";
import {dualTargetView} from "../lib/dual-target-view.mjs";
import report from "../data/model-validation/dual-challenger-v2.json" with {type:"json"};
import v1 from "../data/model-validation/dual-target-aggregate-v1.json" with {type:"json"};
const rows=[-1,0,1].map((v,i)=>({X:[1,v,0,0,0,0,0,0,0,0],y:v*.03,code:String(i).padStart(6,"0"),x:[0,0,0]})),days=Array.from({length:12},()=>({rows}));
const m={R:regress(days,false),P:regress(days,true),offset:.2};
assert.ok(Math.abs(m.R[1]-.03*(2/3)/(.02+2/3))<1e-10);
assert.ok(estimate(m,rows[0],"P")<estimate(m,rows[2],"P"));assert.ok(estimate(m,rows[2],"P")>estimate(m,rows[2],"Praw"));
const t=challengerRanks({rows:[rows[0],{...rows[0],code:"000005"},rows[1]]},m,"R");assert.deepEqual(t.map(x=>x.rank),[1,2,2]);assert.deepEqual(t.map(x=>x.tied),[1,2,2]);
for(const h of [5,20]){
 const s=report.horizons[h];
 for(const [i,f] of s.folds.entries()){
 assert.ok(f.fitCutoffs[0]<f.fitCutoffs[1] && f.fitCutoffs[2]<f.start);
 const find=k=>f.runs.find(r=>r.id===k),p=find("P3"),raw=find("P3raw");
 assert.equal(p.metrics.auc,raw.metrics.auc);assert.equal(p.metrics.lift,raw.metrics.lift);assert.deepEqual(p.account,raw.account);
 for(const k of ["R1","P2","BASE"]){const old=v1.horizons[h].folds[i].results.find(r=>r.candidate===k);assert.equal(find(k).metrics.ic,old.ic);assert.equal(find(k).metrics.brier,old.brier);assert.equal(find(k).account.net,old.account.net);}
 if(p.metrics.brier!==null)assert.ok(Math.abs(p.metrics.marketError+p.metrics.withinError-p.metrics.brier)<.00002);
 }
 for(const target of ["P","R"]){const [auto,experiment]=await Promise.all([dualTargetView(h,target,"auto"),dualTargetView(h,target,"v2")]);assert.equal(experiment.chosen,target+"3");assert.equal(auto.chosen,report.horizons[5].gate[target]?target+"3":v1.horizons[h].chosen[target]);
 assert.equal(experiment.rows.length+experiment.excluded.length,553);assert.equal(experiment.rows[0].probability,undefined);}
}console.log("PASS independent ridge, logistic ordering, ties, calibration vs discrimination, all control folds, honest default and 4 challenger views");
