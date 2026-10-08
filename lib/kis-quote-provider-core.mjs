export class KisQuoteError extends Error { constructor(code) { super(code); this.name = "KisQuoteError"; this.code = code; } }
const date = (value) => typeof value === "string" && /^\d{8}$/.test(value) ? `${value.slice(0,4)}-${value.slice(4,6)}-${value.slice(6,8)}` : null;
const time = (value) => typeof value === "string" && /^\d{6}$/.test(value) ? `${value.slice(0,2)}:${value.slice(2,4)}:${value.slice(4,6)}` : null;
const compactTime = (value) => typeof value === "string" && /^\d{6}$/.test(value) ? value : null;
const minuteRows = (payload) => {
  if (payload?.rt_cd !== "0" || !Array.isArray(payload?.output2)) throw new KisQuoteError("KIS_MINUTE_OBSERVATION_INVALID");
  return payload.output2.map((row) => ({ date: String(row?.stck_bsop_date ?? ""), time: compactTime(String(row?.stck_cntg_hour ?? "")) }));
};

export function inspectKisMinuteObservation(payload, { requestedDate, requestedTime }) {
  const rows = minuteRows(payload);
  const dateValue = String(requestedDate ?? "").replaceAll("-", "");
  const requested = compactTime(String(requestedTime ?? "").replaceAll(":", ""));
  if (!/^\d{8}$/u.test(dateValue) || !requested) throw new KisQuoteError("KIS_MINUTE_OBSERVATION_REQUEST_INVALID");
  const completeRows = rows.filter((row) => /^\d{8}$/u.test(row.date) && row.time);
  const matchingDateRows = completeRows.filter((row) => row.date === dateValue);
  const eligibleRows = matchingDateRows.filter((row) => row.time <= requested);
  const observedDates = [...new Set(completeRows.map((row) => row.date))].sort();
  return {
    rowCount: rows.length,
    timestampCompleteCount: completeRows.length,
    matchingDateCount: matchingDateRows.length,
    eligibleTimestampCount: eligibleRows.length,
    observedDateRange: { min: observedDates.at(0) ?? null, max: observedDates.at(-1) ?? null },
  };
}
export function parseKisQuote(payload, requestedCode, receivedAt) {
  if (payload?.rt_cd !== "0" || !payload?.output) throw new KisQuoteError("KIS_BUSINESS_ERROR");
  const o=payload.output; const responseCode=typeof o.stck_shrn_iscd==="string"?o.stck_shrn_iscd:null;
  if(responseCode&&responseCode!==requestedCode) throw new KisQuoteError("KIS_SYMBOL_MISMATCH");
  const optionalNumber=(value)=>value===null||value===undefined||value===""?null:Number(value);
  const asOfDate=date(o.stck_bsop_date),asOfTime=time(o.stck_cntg_hour);
  const missingFields=[...(asOfDate?[]:["asOfDate"]),...(asOfTime?[]:["asOfTime"])];
  const quote={code:requestedCode,source:"KIS",priceBasis:"lastQuotedPrice",price:Number(o.stck_prpr),open:optionalNumber(o.stck_oprc),high:Number(o.stck_hgpr),low:Number(o.stck_lwpr),volume:Number(o.acml_vol),change:Number(o.prdy_vrss),rate:Number(o.prdy_ctrt),asOfDate,asOfTime,receivedAt,valueStatus:"valid",metadataAvailability:{status:missingFields.length?"incomplete":"complete",missingFields,usableForDatedCalculation:asOfDate!==null,usableForFreshness:missingFields.length===0}};
  if(![quote.price,quote.high,quote.low].every((v)=>Number.isFinite(v)&&v>0)||(quote.open!==null&&(!Number.isFinite(quote.open)||quote.open<0))||!Number.isFinite(quote.volume)||quote.volume<0||![quote.change,quote.rate].every(Number.isFinite)) throw new KisQuoteError("KIS_INVALID_QUOTE");
  if(quote.high<Math.max(quote.open??quote.price,quote.price)||quote.low>Math.min(quote.open&&quote.open>0?quote.open:quote.price,quote.price)||quote.high<quote.low) throw new KisQuoteError("KIS_INVALID_OHLC");
  return quote;
}

// inquire-price deliberately has no exchange date/time fields.  The intraday
// signal path pairs it with KIS's current-day minute-chart response solely for
// an observed KIS timestamp; daily OHLCV still comes from inquire-price.
export function attachKisMinuteObservation(quote, payload, { requestedDate, requestedTime }) {
  if (!quote) throw new KisQuoteError("KIS_MINUTE_OBSERVATION_INVALID");
  const rows = minuteRows(payload);
  const dateValue = String(requestedDate ?? "").replaceAll("-", "");
  const requested = compactTime(String(requestedTime ?? "").replaceAll(":", ""));
  if (!/^\d{8}$/u.test(dateValue) || !requested) throw new KisQuoteError("KIS_MINUTE_OBSERVATION_REQUEST_INVALID");
  const candidates = rows
    .filter((row) => row.date === dateValue && row.time && row.time <= requested)
    .sort((left, right) => right.time.localeCompare(left.time));
  const observed = candidates[0];
  if (!observed) throw new KisQuoteError("KIS_MINUTE_OBSERVATION_TIMESTAMP_MISSING");
  const asOfDate = date(observed.date);
  const asOfTime = time(observed.time);
  if (!asOfDate || !asOfTime) throw new KisQuoteError("KIS_MINUTE_OBSERVATION_TIMESTAMP_INVALID");
  return {
    ...quote,
    asOfDate,
    asOfTime,
    timestampSource: "KIS_INQUIRE_TIME_ITEMCHARTPRICE",
    metadataAvailability: { status: "complete", missingFields: [], usableForDatedCalculation: true, usableForFreshness: true },
  };
}
export function createKisQuoteProvider({fetchQuote,now=()=>Date.now(),ttlMs=5000}) {
  const cache=new Map(),inFlight=new Map(),generations=new Map();
  async function getQuote(code){const hit=cache.get(code);if(hit&&hit.expiresAt>now())return hit.quote;if(inFlight.has(code))return inFlight.get(code);const generation=(generations.get(code)??0)+1;generations.set(code,generation);const promise=(async()=>{const quote=await fetchQuote(code);if(generations.get(code)===generation)cache.set(code,{quote,generation,expiresAt:now()+ttlMs});return quote;})().finally(()=>{if(inFlight.get(code)===promise)inFlight.delete(code);});inFlight.set(code,promise);return promise;}
  function invalidate(code){cache.delete(code);inFlight.delete(code);generations.set(code,(generations.get(code)??0)+1);}
  function clear(){cache.clear();inFlight.clear();generations.clear();}
  return {getQuote,invalidate,clear,_state:{cache,inFlight,generations}};
}
