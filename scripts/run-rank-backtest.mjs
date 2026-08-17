import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { buildRankBacktest, MODEL_VERSIONS } from "../lib/rank-backtest-engine.mjs";
import { saveRankBacktest } from "../lib/rank-backtest-storage.mjs";

const args=Object.fromEntries(process.argv.slice(2).filter((value)=>value.startsWith("--")).map((value)=>{const [key,...rest]=value.slice(2).split("=");return [key,rest.length?rest.join("="):true];}));
const datePattern=/^\d{4}-\d{2}-\d{2}$/;
if(args.from&&!datePattern.test(args.from))throw new Error("--from은 YYYY-MM-DD 형식이어야 합니다.");
if(args.to&&!datePattern.test(args.to))throw new Error("--to는 YYYY-MM-DD 형식이어야 합니다.");
const models=args.models?String(args.models).split(","):MODEL_VERSIONS;
if(models.some((model)=>!MODEL_VERSIONS.includes(model)))throw new Error("지원하지 않는 model version입니다.");
const evaluations=args.evaluation==="both"||!args.evaluation?["predictive","executable"]:[args.evaluation];
if(evaluations.some((value)=>!["predictive","executable"].includes(value)))throw new Error("--evaluation은 predictive|executable|both입니다.");
const root=process.cwd(),historyDir=path.join(root,"data","history"),config=JSON.parse(await fs.readFile(path.join(root,"config","rank-backtest.json"),"utf8"));
const names=(await fs.readdir(historyDir)).filter((name)=>/^\d{4}-\d{2}-\d{2}\.json$/.test(name)).sort();
const selected=names.filter((name)=>(!args.from||name.slice(0,10)>=args.from)&&(!args.to||name.slice(0,10)<=args.to));
const snapshots=[];
for(const name of selected){const bytes=await fs.readFile(path.join(historyDir,name));snapshots.push({date:name.slice(0,10),hash:createHash("sha256").update(bytes).digest("hex"),snapshot:JSON.parse(bytes.toString("utf8"))});}
const generatedAt=new Date().toISOString();
const result=buildRankBacktest({snapshots,models,evaluations,config,includeProvisional:args["include-provisional"]===true||config.includeProvisionalByDefault,generatedAt});
const summary={inputSnapshotDates:result.inputSnapshotDates,models,evaluations,metricCount:result.metrics.length,commonMetricCount:result.commonComparisonMetrics.length,statuses:Object.fromEntries([...new Set(result.metrics.map((item)=>item.status))].map((status)=>[status,result.metrics.filter((item)=>item.status===status).length])),contentHash:result.contentHash,dryRun:args["dry-run"]===true};
if(args["dry-run"]!==true)summary.output=await saveRankBacktest(result,{root});
console.log(JSON.stringify(summary,null,2));
