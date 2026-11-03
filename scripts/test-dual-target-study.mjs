import assert from "node:assert/strict";
import fs from "node:fs/promises";
import {panel,frame,outcome,fit,predict,midranks,spearman,chain} from "../lib/dual-target-research.mjs";
import {dualTargetView} from "../lib/dual-target-view.mjs";
import cfg from "../config/dual-target-study-v1.json" with {type:"json"};
import report from "../data/model-validation/dual-target-aggregate-v1.json" with {type:"json"};
assert.deepEqual(midranks([3,1,1,2]),[.875,.25,.25,.625]);assert.equal(spearman([1,2,3],[3,2,1]),-1);
const x=[0,0,0,0,0,0],synthetic=Array.from({length:12},()=>({rows:[{x,y:-.5},{x,y:.1},{x,y:.1}]}));
assert.ok(Math.abs(predict(fit(synthetic,"R"),{x},[0]).value+.1)<1e-9);
assert.ok(Math.abs(predict(fit(synthetic,"P"),{x},[0]).value-2/3)<1e-9);
const b=(o,c)=>["20260101",o,Math.max(o,c),Math.min(o,c),c,5],bars=[b(10,10),b(10,10),b(11,12),b(12,13)];
assert.equal(outcome({bars},2,2),13/11-1);assert.equal(outcome({bars},2,5),null);assert.equal(outcome({bars:[...bars.slice(0,3),undefined]},2,2),null);
assert.equal(chain([b(10,10),b(5,5)]),false);
const read=async name=>JSON.parse(await fs.readFile(name,"utf8"));
const seed=await read("data/analysis/market-seeds/"+cfg.through+".json"),p=panel(seed,await read("data/universe.json"));
const i=100,a=frame(p,i);assert.deepEqual(frame({...p,assets:p.assets.map(r=>({...r,bars:r.bars.slice(0,i+1)}))},i),a,"future prices never enter features");
for(const h of cfg.horizons){
 const s=report.horizons[h];assert.equal(s.folds.length,3);for(const f of s.folds){assert.ok(f.trainingExit<f.start);assert.ok(f.results.every(r=>r.days===f.dates));}
 const both=await Promise.all(["R","P"].map(t=>dualTargetView(h,t)));
 for(const v of both){assert.equal(v.rows.length+v.excluded.length,553);assert.equal(new Set(v.rows.map(r=>r.code)).size,v.rows.length);
 assert.ok(v.rows.every((r,j)=>r.rank===j+1&&/^\w{6}$/.test(r.code)&&r.score>=0&&r.score<=100&&r.tied>=1&&(j===0||v.rows[j-1].score>=r.score)));assert.equal(v.rows[0].probability,undefined);}
 assert.equal(both[0].overlap,both[0].rows.slice(0,10).filter(r=>both[1].rows.slice(0,10).some(z=>z.code===r.code)).length);
}
await assert.rejects(dualTargetView(1,"P"));console.log("PASS: signed return vs price-up labels, tenor maturity, missing bars and actions, tied ranks, causal features, purged folds, live target separation and exclusions");
