import { createHash } from "node:crypto";
import { isReadableModelHistorySchemaVersion } from "./model-history-schema.mjs";

export const MODEL_VERSIONS=["A-v1","A-v2","B-v1","C-v1","D-v1"];
export const HORIZONS={T1:{predictive:"future1dReturn",executable:"nextOpenToT1CloseReturn"},T5:{predictive:"future5dReturn",executable:"nextOpenToT5CloseReturn"},T20:{predictive:"future20dReturn",executable:"nextOpenToT20CloseReturn"}};
const LEGACY={"A-v1":"modelA","B-v1":"modelB","C-v1":"modelC","D-v1":"modelD"};
const canonical=(v)=>Array.isArray(v)?v.map(canonical):v&&typeof v==="object"?Object.fromEntries(Object.keys(v).sort().map((k)=>[k,canonical(v[k])])):v;
export const hashObject=(value)=>createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
const finite=(value)=>typeof value==="number"&&Number.isFinite(value);
const mean=(values)=>values.length?values.reduce((a,b)=>a+b,0)/values.length:null;
const median=(values)=>{if(!values.length)return null;const sorted=[...values].sort((a,b)=>a-b),m=Math.floor(sorted.length/2);return sorted.length%2?sorted[m]:(sorted[m-1]+sorted[m])/2;};
const stdev=(values)=>{if(!values.length)return null;const m=mean(values);return Math.sqrt(mean(values.map((v)=>(v-m)**2)));};
const round=(value)=>finite(value)?Number(value.toFixed(10)):null;
const scoreRank=(snapshot,record,version)=>{
  if(finite(record.scoresByVersion?.[version])&&Number.isInteger(record.ranksByVersion?.[version])){const legacyKey=LEGACY[version];return {score:record.scoresByVersion[version],rank:record.ranksByVersion[version],count:record.rankingUniverseCountByVersion?.[version]??(legacyKey?record.rankingUniverseCount?.[legacyKey]:null)??null,percentile:record.rankPercentileByVersion?.[version]??(legacyKey?record.rankPercentile?.[legacyKey]:null)??null};}
  const key=LEGACY[version],definition=Object.values(snapshot.modelDefinitions??{}).find((item)=>item?.modelVersion===version);
  if(!key||!definition||!finite(record.scores?.[key])||!Number.isInteger(record.ranks?.[key]))return null;
  return {score:record.scores[key],rank:record.ranks[key],count:record.rankingUniverseCount?.[key]??null,percentile:record.rankPercentile?.[key]??null};
};
const returnValue=(record,evaluation,horizon)=>evaluation==="predictive"?record.futureReturns?.[HORIZONS[horizon].predictive]:record.backtestReturns?.returns?.[HORIZONS[horizon].executable];
const inBucket=(meta,bucket)=>bucket.type==="all"?true:bucket.type==="rank"?meta.rank<=bucket.maxRank:finite(meta.percentile)?meta.percentile<=bucket.maxPercentile:Number.isInteger(meta.count)&&meta.count>0?meta.rank/meta.count<=bucket.maxPercentile:false;
const portfolioMetrics=(dateGroups,minimumDates,tradingDays)=>{
  const observations=dateGroups.flatMap((group)=>group.returns),daily=dateGroups.map((group)=>mean(group.returns)).filter(finite),values=observations;
  let wealth=1,peak=1,mdd=0;for(const value of daily){wealth*=1+value/100;peak=Math.max(peak,wealth);mdd=Math.min(mdd,(wealth/peak-1)*100);}
  const sd=stdev(values),annualReady=daily.length>=minimumDates,annualVol=annualReady&&stdev(daily)!=null?stdev(daily)*Math.sqrt(tradingDays):null;
  return {signalDateCount:dateGroups.length,observationCount:values.length,meanReturn:round(mean(values)),medianReturn:round(median(values)),standardDeviation:round(sd),minReturn:values.length?Math.min(...values):null,maxReturn:values.length?Math.max(...values):null,positiveRate:values.length?round(values.filter((v)=>v>0).length/values.length):null,negativeRate:values.length?round(values.filter((v)=>v<0).length/values.length):null,zeroRate:values.length?round(values.filter((v)=>v===0).length/values.length):null,cumulativeEqualWeightReturn:daily.length?round((wealth-1)*100):null,annualizedReturn:annualReady?round((wealth**(tradingDays/daily.length)-1)*100):null,annualizedVolatility:round(annualVol),SharpeLikeRatio:annualReady&&annualVol>0?round((mean(daily)*tradingDays)/annualVol):null,maxDrawdown:daily.length?round(mdd):null};
};

export function buildRankBacktest({snapshots,models=MODEL_VERSIONS,evaluations=["predictive","executable"],config,includeProvisional=true,generatedAt="1970-01-01T00:00:00.000Z"}){
  const structurallyValid=(item)=>{const records=item.snapshot?.records;if(!isReadableModelHistorySchemaVersion(item.snapshot?.schemaVersion)||!Array.isArray(records)||!records.length)return false;const codes=records.map((record)=>record.code);return codes.every((code)=>typeof code==="string"&&code.length>0)&&new Set(codes).size===codes.length;};
  const readable=snapshots.filter(structurallyValid),qualityBlocked=readable.filter((item)=>item.snapshot.dataQuality?.eligibleForRankBacktest===false);
  const valid=readable.filter((item)=>item.snapshot.dataQuality?.eligibleForRankBacktest!==false).filter((item)=>includeProvisional||!(["PROVISIONAL","provisional"].includes(item.snapshot.dataQuality?.overallGrade??item.snapshot.dataQuality?.grade)));
  const metrics=[],commonComparisonMetrics=[],pendingSummary=[];
  for(const model of models)for(const evaluation of evaluations)for(const horizon of Object.keys(HORIZONS)){
    const prepared=valid.map(({date,snapshot})=>({date,snapshot,eligible:snapshot.records.map((record)=>({record,meta:scoreRank(snapshot,record,model)})).filter((item)=>item.meta)}));
    const versionDates=prepared.filter((item)=>item.eligible.length);
    for(const bucket of config.rankBuckets){
      const groups=[],benchmarks=[],spreads=[];let eligibleCount=0,pending=0,unavailable=0;
      for(const day of versionDates){const selected=day.eligible.filter((item)=>inBucket(item.meta,bucket));eligibleCount+=selected.length;const returns=[];for(const item of selected){const value=returnValue(item.record,evaluation,horizon);if(finite(value))returns.push(value);else if(value===null)pending++;else unavailable++;}const universeReturns=day.eligible.map((item)=>returnValue(item.record,evaluation,horizon)).filter(finite);if(returns.length){groups.push({date:day.date,returns});if(universeReturns.length){benchmarks.push(mean(universeReturns));spreads.push(mean(returns)-mean(universeReturns));}}}
      const base=portfolioMetrics(groups,config.minimumAnnualizationSignalDates,config.tradingDaysPerYear);
      const status=!valid.length&&qualityBlocked.length?"DATA_QUALITY_BLOCKED":!versionDates.length?"VERSION_DATA_NOT_AVAILABLE":!base.observationCount?"NO_RESOLVED_RETURNS":base.signalDateCount<config.minimumAnnualizationSignalDates?"INSUFFICIENT_DATA":pending+unavailable>0?"PARTIAL":"READY";
      metrics.push({universeType:"nativeUniverse",modelVersion:model,evaluation,horizon,rankBucket:bucket.id,status,eligibleObservationCount:eligibleCount,pendingCount:pending,unavailableCount:unavailable,grossReturn:true,...base,averageCrossSectionalSpread:round(mean(spreads)),benchmark:{meanReturn:round(mean(benchmarks)),averageExcessReturn:round(mean(spreads)),excessPositiveRate:spreads.length?round(spreads.filter((value)=>value>0).length/spreads.length):null}});
      pendingSummary.push({modelVersion:model,evaluation,horizon,rankBucket:bucket.id,pendingCount:pending,unavailableCount:unavailable});
    }
    const commonDays=prepared.map((day)=>{const records=day.snapshot.records.filter((record)=>models.every((version)=>scoreRank(day.snapshot,record,version)&&finite(returnValue(record,evaluation,horizon))));return {date:day.date,snapshot:day.snapshot,records,codesHash:hashObject(records.map((record)=>record.code).sort())};});
    const commonVersionAvailable=models.every((version)=>prepared.some((day)=>day.snapshot.records.some((record)=>scoreRank(day.snapshot,record,version))));
    for(const bucket of config.rankBuckets){const groups=[],benchmarks=[],spreads=[],codes=[];for(const day of commonDays){if(!day.records.length)continue;const universeReturns=day.records.map((record)=>returnValue(record,evaluation,horizon));const selected=day.records.filter((record)=>inBucket(scoreRank(day.snapshot,record,model),bucket));if(!selected.length)continue;const returns=selected.map((record)=>returnValue(record,evaluation,horizon));const spread=mean(returns)-mean(universeReturns);groups.push({date:day.date,returns});benchmarks.push(mean(universeReturns));spreads.push(spread);codes.push({date:day.date,count:day.records.length,codesHash:day.codesHash});}const base=portfolioMetrics(groups,config.minimumAnnualizationSignalDates,config.tradingDaysPerYear);const status=!valid.length&&qualityBlocked.length?"DATA_QUALITY_BLOCKED":!commonVersionAvailable?"VERSION_DATA_NOT_AVAILABLE":base.observationCount?(base.signalDateCount<config.minimumAnnualizationSignalDates?"INSUFFICIENT_DATA":"READY"):"NO_RESOLVED_RETURNS";commonComparisonMetrics.push({universeType:"commonComparisonUniverse",modelVersion:model,evaluation,horizon,rankBucket:bucket.id,status,eligibleObservationCount:groups.reduce((sum,g)=>sum+g.returns.length,0),pendingCount:0,unavailableCount:0,grossReturn:true,...base,averageCrossSectionalSpread:round(mean(spreads)),benchmark:{meanReturn:round(mean(benchmarks)),averageExcessReturn:round(mean(spreads)),excessPositiveRate:spreads.length?round(spreads.filter((value)=>value>0).length/spreads.length):null},comparisonUniverseByDate:codes});}
  }
  const inputSnapshotDates=valid.map((item)=>item.date).sort(),inputSnapshotHashes=Object.fromEntries(valid.map((item)=>[item.date,item.hash]));
  const result={schemaVersion:1,engineVersion:config.engineVersion,generatedAt,inputSnapshotDates,inputSnapshotHashes,modelVersions:models,horizons:Object.keys(HORIZONS),evaluationTypes:evaluations,rankBuckets:config.rankBuckets,qualityPolicy:{includeProvisional,grossReturn:true,riskFreeRate:0},metrics,commonComparisonMetrics,pendingSummary,dataLimitations:["gross returns; transaction costs are not deducted","intraday results are excluded","annualized metrics require the configured minimum signal dates"]};
  return {...result,contentHash:hashObject({...result,generatedAt:null})};
}
