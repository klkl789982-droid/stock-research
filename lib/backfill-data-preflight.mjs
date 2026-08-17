const normalizeItems=(items)=>!items?[]:Array.isArray(items)?items:[items];
const number=(value)=>{const parsed=Number(value);return Number.isFinite(parsed)?parsed:null;};
export class RateLimitStopError extends Error{constructor(){super("HTTP 429: preflight stopped");this.name="RateLimitStopError";}}
export class AuthenticationStopError extends Error{constructor(status){super(`HTTP ${status}: preflight authentication stopped`);this.name="AuthenticationStopError";this.status=status;}}

export function analyzePriceRows(rows,{today=new Date().toISOString().slice(0,10).replaceAll("-","")}={}){
  const normalized=rows.map((row)=>({date:String(row.basDt??""),open:number(row.mkp),high:number(row.hipr),low:number(row.lopr),close:number(row.clpr),volume:number(row.trqu),tradingValue:number(row.trPrc),marketCap:number(row.mrktTotAmt)}));
  const dates=normalized.map((row)=>row.date),unique=[...new Set(dates)].sort();
  const invalid=normalized.filter((row)=>![row.open,row.high,row.low,row.close].every((value)=>value!==null&&value>0)||row.high<Math.max(row.open,row.close,row.low)||row.low>Math.min(row.open,row.close,row.high)||row.volume===null||row.volume<0);
  const zeroVolume=normalized.filter((row)=>row.volume===0),haltLike=zeroVolume.filter((row)=>row.open===row.high&&row.high===row.low&&row.low===row.close);
  const descending=dates.every((date,index)=>index===0||dates[index-1]>=date),ascending=dates.every((date,index)=>index===0||dates[index-1]<=date);
  return {rowCount:rows.length,totalUniqueTradingDays:unique.length,firstDate:unique[0]??null,lastDate:unique.at(-1)??null,order:descending?"descending":ascending?"ascending":"unsorted",duplicateDateCount:dates.length-unique.length,futureDateCount:unique.filter((date)=>date>today).length,invalidOhlcvCount:invalid.length,zeroVolumeCount:zeroVolume.length,tradingHaltSuspectCount:haltLike.length,dates:unique};
}

export function estimateEligibility(dates){
  const models={"A-v1":260,"A-v2":260,"B-v1":260,"C-v1":34,"D-v1":260},horizons={T1:1,T5:5,T20:20},result={};
  for(const [model,warmup] of Object.entries(models)){result[model]={firstEligibleSignalDate:dates[warmup-1]??null};for(const [horizon,future] of Object.entries(horizons))result[model][horizon]={lastResolvableSignalDate:dates.length>warmup+future-1?dates[dates.length-future-1]:null,estimatedSignalDateCount:Math.max(0,dates.length-warmup-future+1)};}
  return result;
}

export function createPreflightClient({fetchImpl,serviceKey,endpoint,maxRequests=30,intervalMs=150,wait=(ms)=>new Promise((resolve)=>setTimeout(resolve,ms))}){
  let requests=0;const cache=new Map();
  const request=(code,pageNo,numOfRows)=>{const key=`${code}:${pageNo}:${numOfRows}`;if(cache.has(key))return cache.get(key);const operation=(async()=>{if(requests>=maxRequests)throw new Error("PREFLIGHT_REQUEST_LIMIT_REACHED");if(requests>0)await wait(intervalMs);requests++;let decodedKey;try{decodedKey=decodeURIComponent(serviceKey);}catch{decodedKey=serviceKey;}const query=new URLSearchParams({serviceKey:decodedKey,resultType:"json",pageNo:String(pageNo),numOfRows:String(numOfRows),likeSrtnCd:code});const response=await fetchImpl(`${endpoint}?${query}`);if(response.status===429)throw new RateLimitStopError();if(response.status===401||response.status===403)throw new AuthenticationStopError(response.status);if(!response.ok)throw new Error(`HTTP ${response.status}`);const payload=await response.json(),header=payload?.response?.header??{},body=payload?.response?.body??{};if(header.resultCode&&!['00','0','NORMAL_CODE'].includes(String(header.resultCode)))throw new Error(`UPSTREAM_${header.resultCode}`);return {httpStatus:response.status,resultCode:String(header.resultCode??""),totalCount:Number(body.totalCount??0),rows:normalizeItems(body.items?.item)};})();cache.set(key,operation);operation.catch(()=>cache.delete(key));return operation;};
  return {request,getRequestCount:()=>requests};
}

export async function inspectSymbol(client,symbol){
  const full=await client.request(symbol.code,1,10000),firstPage=await client.request(symbol.code,1,260),secondPage=firstPage.totalCount>260?await client.request(symbol.code,2,260):{rows:[],totalCount:firstPage.totalCount};
  const rows=full.rows.filter((row)=>String(row.srtnCd??"").replace(/^A/,"").toUpperCase()===symbol.code.toUpperCase());
  const analysis=analyzePriceRows(rows),page1Dates=new Set(firstPage.rows.map((row)=>row.basDt)),boundaryDuplicates=secondPage.rows.filter((row)=>page1Dates.has(row.basDt)).length;
  return {...symbol,httpStatus:full.httpStatus,businessStatus:full.resultCode,totalCount:full.totalCount,fullResponseRows:rows.length,pageRows:[firstPage.rows.length,secondPage.rows.length],pageBoundaryDuplicateCount:boundaryDuplicates,moreThan260Available:full.totalCount>260,maxRowsObserved:rows.length,...analysis,eligibility:estimateEligibility(analysis.dates)};
}
