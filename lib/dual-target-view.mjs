import fs from "node:fs/promises";
import path from "node:path";
import {panel,frame,liveRanks,spearman,round} from "./dual-target-research.mjs";
import report from "../data/model-validation/dual-target-aggregate-v1.json" with {type:"json"};
import plan from "../config/dual-target-study-v1.json" with {type:"json"};
import master from "../data/universe.json" with {type:"json"};
const dir=path.join(process.cwd(),"data/analysis/market-seeds");let cache;
export async function dualTargetView(h,target){
 if(![5,20].includes(h)||!["R","P"].includes(target))throw Error("INVALID_FILTER");
 const name=(await fs.readdir(dir)).filter(n=>/^\d{4}-\d{2}-\d{2}\.json$/.test(n)).sort().at(-1);
 if(!name||name.slice(0,10)<report.through)throw Error("SEED_UNAVAILABLE");
 if(cache?.name!==name){const src=JSON.parse(await fs.readFile(path.join(dir,name),"utf8"));if(src.requestedDate!==name.slice(0,10)||(src.requestedDate===report.through&&src.contentHash!==report.seedHash))throw Error("SEED_MISMATCH");
 const p=panel(src,master),fr=frame(p,p.days.length-1);cache={name,fr,date:p.date,generatedAt:p.generatedAt};}
 const {fr,date,generatedAt}=cache,study=report.horizons[h];
 const tables=Object.fromEntries(["R","P"].map(k=>[k,liveRanks(fr,study.lastFit[k],plan.candidates[study.chosen[k]])]));
 const other=new Set(tables.P.slice(0,10).map(r=>r.code)),ps=new Map(tables.P.map(r=>[r.code,r.score]));
 return {version:report.version,date,generatedAt,fittedThrough:report.through,h,target,chosen:study.chosen[target],rows:tables[target],excluded:fr.excluded,
 overlap:tables.R.slice(0,10).filter(r=>other.has(r.code)).length,correlation:round(spearman(tables.R.map(r=>r.score),tables.R.map(r=>ps.get(r.code)))),
 folds:study.folds,comparisons:study.comparisons,matureDays:study.matureDays,immatureDates:study.immatureDates};
}
