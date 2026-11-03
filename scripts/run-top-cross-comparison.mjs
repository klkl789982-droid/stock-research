import fs from "node:fs/promises";
import path from "node:path";
import {hashObject} from "../lib/rank-backtest-engine.mjs";
import {buildTransitionRows} from "../lib/transition-screener.mjs";
import {taxEligibilityForStudy} from "../lib/research-sell-tax.mjs";
import {identifyStoredResearchSignal} from "../lib/model-performance-research-store.mjs";
import {simulateFundedPortfolio} from "../lib/funded-research-portfolio.mjs";
import {selectThree,summarizeAccount} from "../lib/top-cross-comparison.mjs";
import {loadPrivateBenchmarkLegs} from "../lib/research-index-benchmarks.mjs";
import {createKisEodPrivateStore} from "../lib/kis-eod-private-store.mjs";
import {publishedLivePerformance} from "../lib/published-live-performance.mjs";
import {locateExecutionTradingDay as shift} from "../lib/execution-return-resolver.mjs";
const read=async f=>JSON.parse(await fs.readFile(f,"utf8")),files=async d=>(await fs.readdir(d)).filter(f=>/^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
const cfg=await read("config/top-cross-comparison-v1.json"),cal=await read("data/trading-calendar/status.json"),master=await read("data/universe.json");
const through=cfg.dataThrough, dates=(await files("data/history")).map(f=>f.slice(0,10)).filter(d=>d>=cfg.signalFrom&&d<=through);
const ledgers=await Promise.all((await files("data/market-prices")).filter(f=>f.slice(0,10)<=through).map(f=>read("data/market-prices/"+f)));
const receipts=(await read("data/model-validation/daily-publication-evidence.json")).evidence, models=[cfg.primary,...cfg.secondary];
const selections={}, inventory=[], inputHashes={}, tradeAudit={}, summary=[], pairs=[], optional=new Set(await files("data/model-history"));
for(const d of dates){
  const name=d+".json",h=await read("data/history/"+name),seed=await read("data/analysis/market-seeds/"+name);
  const compact=optional.has(name)?await read("data/model-history/"+name):null;
  const dir="data/daily-runs/"+d;let manifests=[];try{manifests=await Promise.all((await fs.readdir(dir)).filter(n=>n.endsWith(".json")).map(n=>read(dir+"/"+n)));}catch(e){if(e.code!=="ENOENT")throw e;}
  const signal=identifyStoredResearchSignal(h,compact,manifests,receipts);
  const published=signal.availabilityEvidence==="VERIFIED"&&signal.classification==="AS_PUBLISHED"?signal.availableAt:null;
  inputHashes[d]={seed:seed.contentHash,compact:compact?.contentHash??null,formula:h.sourceManifest?.modelFormulaHashes,universe:h.sourceManifest?.universe?.contentHash};
  const log={date:d,published,seedGeneratedAt:seed.generatedAt,seedHash:seed.contentHash,formulaHashes:h.sourceManifest?.modelFormulaHashes??{},models:{}};inventory.push(log);
  let transitions;try{transitions=buildTransitionRows({history:h,seed,calendar:cal});}catch(e){log.error=e.message;continue;}
  const tax=taxEligibilityForStudy(master,[h]);
  for(const model of models){
    const v=selectThree(h,model,transitions,r=>tax(d,{code:r.ticker,market:r.market},d.slice(0,4)+"-12-31"));
    selections[d]??={};selections[d][model]=v;
    log.models[model]={status:v.status,eligible:v.pool.length,excluded:v.excluded.length,top:v.TOP.length,cross:v.CROSS.length,both:v.BOTH.length};
  }
}
const sessions=Object.keys(cal.dates).filter(d=>cal.dates[d].status==="tradingDay"&&d<=through).sort();
const phases={daily:[],published:[]};
for(const day of inventory)for(const layer of Object.keys(phases)){
  const d=day.date, next=shift(cal,d,1), entry=layer==="daily"?(next.status==="resolved"?next.date:null):day.published?sessions.find(s=>s>d&&Date.parse(s+"T09:00:00+09:00")>Math.max(Date.parse(day.published),Date.parse(day.seedGeneratedAt))):null;
  const exit=entry?shift(cal,entry,4):null;
  day[layer]={entry:entry??null,exit:exit?.status==="resolved"?exit.date:null,status:!entry?(layer==="published"&&!day.published?"PUBLICATION_UNKNOWN":"NO_CONFIRMED_OPEN"):!exit||exit.status!=="resolved"||exit.date>through?"IMMATURE_OR_CALENDAR_GAP":"MATURE"};
  if(day[layer].status!=="MATURE")continue;
  phases[layer].push({signalDate:d,entryDate:entry,exitDate:exit.date});pairs.push({entryDate:entry,exitDate:exit.date});
}
let store=null,live={status:"NOT_QUERIED"};
if(process.env.PRIVATE_LIVE_DELIVERY_READ_TOKEN){
  store=createKisEodPrivateStore({repository:"klkl789982-droid/tight-budget-private-data",token:process.env.PRIVATE_LIVE_DELIVERY_READ_TOKEN,fetchImpl:(u,i)=>{if(i.method!=="GET")throw Error("GET_ONLY");return fetch(u,i);}});
  await store.verifyPrivateRepository();
  const v=await publishedLivePerformance({store});live={status:"INVENTORIED",publications:v.publications.map(p=>({date:p.signalDate,status:p.status,knownAt:p.publishedAt??p.authenticatedReadAt??null,depth:p.selectionDepth??null,evaluation:p.evaluation}))};
}
const key=(a,b)=>a+"/"+b;
for(const days of Object.values(phases))if(days.length)pairs.push({entryDate:days[0].entryDate,exitDate:days.at(-1).exitDate});
const benchmark=store?await loadPrivateBenchmarkLegs(pairs,{store}):[];
for(const [layer,days] of Object.entries(phases))for(const model of models){
  for(const [basis,arm] of [...cfg.groups.map(a=>["COMMON",a]),...cfg.groups.map(a=>["ALL_MODELS_COMMON",a]),["CROSS_EXTENDED","CROSS"]]){
    const map=new Map();for(const p of days){const v=selections[p.signalDate]?.[model];
      if(v&&(basis==="CROSS_EXTENDED"?v.pool.length>0:basis==="ALL_MODELS_COMMON"?models.every(m=>selections[p.signalDate]?.[m]?.status==="READY"):v.status==="READY"))map.set(p.entryDate,p);}
    const common=[...map.values()].sort((a,b)=>a.entryDate.localeCompare(b.entryDate));
    const plans=common.map(p=>({...p,tickers:selections[p.signalDate][model][arm],capacity:10}));
    const account=simulateFundedPortfolio({selections:plans,ledgers,calendar:cal,holdingDays:5,cost:cfg.cost,fixedSlots:10,endDate:common.at(-1)?.exitDate});
    const metrics=summarizeAccount(account,t=>selections[t.signalDate][model].pool.find(r=>r.code===t.ticker).market,benchmark,Date.now());
    const weights=new Map();
    for(const t of account.trades??[]){const market=selections[t.signalDate][model].pool.find(r=>r.code===t.ticker).market;
      const id=[market,t.entryDate,t.exitDate].join("/"),v=weights.get(id)??{market,entryDate:t.entryDate,exitDate:t.exitDate,fraction:0,n:0};
      v.fraction+=t.outlay/account.startingCapitalKrw;v.n++;weights.set(id,v);}
    summary.push({layer,model,arm,basis,commonDays:plans.length,selected:plans.reduce((n,p)=>n+p.tickers.length,0),...metrics,weights:[...weights.values()]});
    tradeAudit[[layer,model,arm,basis].join("/") ]={plans,...account};
  }
}
const report={version:cfg.version,planHash:hashObject(cfg),inputHash:hashObject(inputHashes),through,inventory,live,summary,
  indexIntervals:benchmark.length,periodIndices:Object.fromEntries(Object.entries(phases).map(([k,p])=>[k,p.length?benchmark.filter(b=>key(b.entryDate,b.exitDate)===key(p[0].entryDate,p.at(-1).exitDate)).map(b=>({market:b.market,return:b.returnPercent})):[]]))};
await fs.writeFile("data/model-validation/top-cross-comparison-v1.json",JSON.stringify(report,null,2)+"\n");
if(process.argv[2])await fs.writeFile(path.resolve(process.argv[2]),JSON.stringify({planHash:report.planHash,inputHashes,selections,tradeAudit}),{flag:"wx"});
console.log(JSON.stringify({days:dates.length,live:live.status,indexIntervals:benchmark.length,summary:summary.filter(s=>s.model===cfg.primary)},null,2));
