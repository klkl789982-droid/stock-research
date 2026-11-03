import fs from "node:fs/promises";
import path from "node:path";
import {panel,liveRanks,spearman,round} from "./dual-target-research.mjs";
import {features,challengerRanks} from "./dual-challenger.mjs";
import challenge from "../data/model-validation/dual-challenger-v2.json" with {type:"json"};
import report from "../data/model-validation/dual-target-aggregate-v1.json" with {type:"json"};
import plan from "../config/dual-target-study-v1.json" with {type:"json"};
import master from "../data/universe.json" with {type:"json"};
const dir=path.join(process.cwd(),"data/analysis/market-seeds");let cache;
export async function dualTargetView(h,target,variant="v1"){
 if(!["auto","v1","v2"].includes(variant))throw Error("INVALID_VERSION");
 if(![5,20].includes(h)||!["R","P"].includes(target))throw Error("INVALID_FILTER");
 const name=(await fs.readdir(dir)).filter(n=>/^\d{4}-\d{2}-\d{2}\.json$/.test(n)).sort().at(-1);
 if(!name||name.slice(0,10)<report.through)throw Error("SEED_UNAVAILABLE");
 if(cache?.name!==name){const src=JSON.parse(await fs.readFile(path.join(dir,name),"utf8"));if(src.requestedDate!==name.slice(0,10)||(src.requestedDate===report.through&&src.contentHash!==report.seedHash))throw Error("SEED_MISMATCH");
 const p=panel(src,master),fr=features(p,p.days.length-1);cache={name,fr,date:p.date,generatedAt:p.generatedAt};}
 const {fr,date,generatedAt}=cache,study=report.horizons[h];
 const ch=challenge.horizons[h],showExperiment=k=>variant==="v2"||variant==="auto"&&challenge.horizons[5].gate[k];
 const tables=Object.fromEntries(["R","P"].map(k=>[k,showExperiment(k)?challengerRanks(fr,ch.final,k):liveRanks(fr,study.lastFit[k],plan.candidates[study.chosen[k]])]));
 const other=new Set(tables.P.slice(0,10).map(r=>r.code)),ps=new Map(tables.P.map(r=>[r.code,r.score]));
 const compact=r=>({id:r.id,metrics:r.metrics,account:r.account,calibration:r.calibration,days:r.days});
 return {variant,version:showExperiment(target)?challenge.version:report.version,date,generatedAt,fittedThrough:report.through,h,target,chosen:showExperiment(target)?target+"3":study.chosen[target],rows:tables[target],excluded:fr.excluded,
 challenge:{pass:challenge.horizons[5].gate[target],summary:ch.summary,folds:ch.folds.map(f=>({start:f.start,days:f.days,runs:f.runs.map(compact)})),common:Object.fromEntries(Object.entries(ch.common).map(([k,rs])=>[k,rs.map(compact)]))},
 overlap:tables.R.slice(0,10).filter(r=>other.has(r.code)).length,correlation:round(spearman(tables.R.map(r=>r.score),tables.R.map(r=>ps.get(r.code)))),
 folds:study.folds,comparisons:study.comparisons,matureDays:study.matureDays,immatureDates:study.immatureDates};
}
