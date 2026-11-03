import {readIndexPage} from "./research-index-benchmarks.mjs";
import {candleDate,candleWindow} from "./daily-candles.mjs";
const shift=(s,n)=>new Date(Date.parse(s)+86400000*n).toISOString().slice(0,10);
export function indexCandleReader(){
  const cache=new Map();
  async function page(m,from,to,request,ttl){
    const k=[m,from,to].join("/"),prior=cache.get(k);if(prior&&prior.until>Date.now())return prior.task;
    if(cache.size>=32)cache.delete(cache.keys().next().value);
    const task=readIndexPage(m,from,to,request).then(({items,observedAt})=>items.flatMap(r=>{
      const date=candleDate(r.stck_bsop_date);return date&&date>=from&&date<=to?[{date,open:r.bstp_nmix_oprc,high:r.bstp_nmix_hgpr,low:r.bstp_nmix_lwpr,close:r.bstp_nmix_prpr,observedAt,
        sourceTuple:[r.bstp_nmix_oprc,r.bstp_nmix_hgpr,r.bstp_nmix_lwpr,r.bstp_nmix_prpr].map(Number)}]:[];
    })).catch(()=>null);
    const entry={task,until:Date.now()+ttl};cache.set(k,entry);
    const values=await task;if(!values?.length)entry.until=Date.now()+60000;return values;
  }
  return async function load(today,request,calendar){
    const anchor=shift(today,-((new Date(today).getUTCDay()+6)%7)),values={};
    for(const market of ["KOSPI","KOSDAQ"]){
      const old=await page(market,shift(anchor,-88),shift(anchor,-1),request,86400000),recent=await page(market,anchor,today,request,300000);
      let rows=[...(old??[]),...(recent??[])],failed=Number(!old)+Number(!recent);
      if(old?.length&&new Set(rows.map(r=>r.date)).size<50){const extra=await page(market,shift(anchor,-176),shift(anchor,-89),request,86400000);rows=[...(extra??[]),...rows];failed+=Number(!extra);}
      values[market]={rows,failed};
    }
    const dates=Object.values(values).flatMap(v=>v.rows.map(r=>r.date));
    return ["KOSPI","KOSDAQ"].map(market=>{
      const {rows,failed}=values[market],receivedAt=rows.map(r=>r.observedAt).sort().at(-1)??null;
      const candles=candleWindow(rows,{through:today,calendar,peers:dates,receivedAt,failedPages:failed});
      const originals=new Map(rows.map(r=>[r.date,r.sourceTuple]));
      const sourceMatched=candles.bars.filter(b=>[b.open,b.high,b.low,b.close].every((v,i)=>v===originals.get(b.date)?.[i])).length;
      if(sourceMatched!==candles.bars.length)throw Error("INDEX_OHLC_MISMATCH");
      const observations=new Map(rows.map(r=>[r.date,r.observedAt]));
      return {market,candles:{...candles,sourceMatched},series:candles.bars.map(r=>({market,date:r.date,close:r.close,observedAt:observations.get(r.date)}))};
    });
  };
}
export const loadIndexCandles=indexCandleReader();
