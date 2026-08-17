export class KisQuoteError extends Error { constructor(code) { super(code); this.name = "KisQuoteError"; this.code = code; } }
const date = (value) => typeof value === "string" && /^\d{8}$/.test(value) ? `${value.slice(0,4)}-${value.slice(4,6)}-${value.slice(6,8)}` : null;
const time = (value) => typeof value === "string" && /^\d{6}$/.test(value) ? `${value.slice(0,2)}:${value.slice(2,4)}:${value.slice(4,6)}` : null;
export function parseKisQuote(payload, requestedCode, receivedAt) {
  if (payload?.rt_cd !== "0" || !payload?.output) throw new KisQuoteError("KIS_BUSINESS_ERROR");
  const o=payload.output; const responseCode=typeof o.stck_shrn_iscd==="string"?o.stck_shrn_iscd:null;
  if(responseCode&&responseCode!==requestedCode) throw new KisQuoteError("KIS_SYMBOL_MISMATCH");
  const optionalNumber=(value)=>value===null||value===undefined||value===""?null:Number(value);
  const quote={code:requestedCode,source:"KIS",priceBasis:"lastQuotedPrice",price:Number(o.stck_prpr),open:optionalNumber(o.stck_oprc),high:Number(o.stck_hgpr),low:Number(o.stck_lwpr),volume:Number(o.acml_vol),change:Number(o.prdy_vrss),rate:Number(o.prdy_ctrt),asOfDate:date(o.stck_bsop_date),asOfTime:time(o.stck_cntg_hour),receivedAt};
  if(![quote.price,quote.high,quote.low].every((v)=>Number.isFinite(v)&&v>0)||(quote.open!==null&&(!Number.isFinite(quote.open)||quote.open<0))||!Number.isFinite(quote.volume)||quote.volume<0||![quote.change,quote.rate].every(Number.isFinite)) throw new KisQuoteError("KIS_INVALID_QUOTE");
  if(quote.high<Math.max(quote.open??quote.price,quote.price)||quote.low>Math.min(quote.open&&quote.open>0?quote.open:quote.price,quote.price)||quote.high<quote.low) throw new KisQuoteError("KIS_INVALID_OHLC");
  return quote;
}
export function createKisQuoteProvider({fetchQuote,now=()=>Date.now(),ttlMs=5000}) {
  const cache=new Map(),inFlight=new Map(),generations=new Map();
  async function getQuote(code){const hit=cache.get(code);if(hit&&hit.expiresAt>now())return hit.quote;if(inFlight.has(code))return inFlight.get(code);const generation=(generations.get(code)??0)+1;generations.set(code,generation);const promise=(async()=>{const quote=await fetchQuote(code);if(generations.get(code)===generation)cache.set(code,{quote,generation,expiresAt:now()+ttlMs});return quote;})().finally(()=>{if(inFlight.get(code)===promise)inFlight.delete(code);});inFlight.set(code,promise);return promise;}
  function invalidate(code){cache.delete(code);inFlight.delete(code);generations.set(code,(generations.get(code)??0)+1);}
  function clear(){cache.clear();inFlight.clear();generations.clear();}
  return {getQuote,invalidate,clear,_state:{cache,inFlight,generations}};
}
