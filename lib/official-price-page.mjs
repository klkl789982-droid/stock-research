// Bounded per-instance server cache. Realtime overlays never invalidate the official ledger.
const cache=new Map();
export async function officialPricePage(code,page,key){
  const id=code+"/"+page,prior=cache.get(id);
  if(prior&&prior.expires>Date.now())return prior.task;
  const q=new URLSearchParams({pageNo:String(page),numOfRows:"260",resultType:"json",likeSrtnCd:code});
  const task=(async()=>{
    const res=await fetch("https://apis.data.go.kr/1160100/service/GetStockSecuritiesInfoService/getStockPriceInfo?serviceKey="+key+"&"+q,{cache:"no-store",signal:AbortSignal.timeout(20000)});
    if(!res.ok)throw Error(res.status===429?"OFFICIAL_RATE_LIMIT":"OFFICIAL_HTTP_ERROR");
    const j=await res.json();if(j?.response?.header?.resultCode!=="00")throw Error(j?.response?.header?.resultCode==="22"?"OFFICIAL_RATE_LIMIT":"OFFICIAL_RESPONSE_ERROR");
    const raw=j.response.body?.items?.item;
    return {rows:Array.isArray(raw)?raw:raw?[raw]:[],total:Number(j.response.body?.totalCount),receivedAt:new Date().toISOString()};
  })();
  if(cache.size>=96)cache.delete(cache.keys().next().value);
  cache.set(id,{task,expires:Date.now()+300000});
  try{return await task;}catch(e){if(cache.get(id)?.task===task)cache.delete(id);throw e;}
}
