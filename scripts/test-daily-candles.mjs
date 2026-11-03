import assert from "node:assert/strict";
import {candleDate,candleWindow} from "../lib/daily-candles.mjs";
import {indexCandleReader} from "../lib/index-candles.mjs";
const row=(date)=>({date,open:"101",high:"103",low:"99",close:"102"});
const opts={through:"2026-11-03",calendar:{dates:{"2026-11-02":{status:"tradingDay"},"2026-10-09":{status:"marketClosed"}}}};
assert.equal(candleDate("20260230"),null);
const d="2026-11-03", r=row(d);
for(const x of [{high:100},{low:103},{close:""},{open:0},{noTrade:true}])assert.deepEqual(candleWindow([{...r,...x}],opts).invalid,[d]);
assert.equal(candleWindow([r,{...r,open:102}],opts).bars.length,0);
assert.equal(candleWindow([r,r,row("2026-10-09"),row("2026-11-01"),row("2026-11-04")],opts).bars.length,1);
assert.deepEqual(candleWindow([row("2026-10-30"),r],opts).missing,["2026-11-02"]);
assert.equal(candleWindow([r],opts).status,"PARTIAL");
assert.equal(candleWindow([],{...opts,failedPages:1}).status,"ERROR");
const load=indexCandleReader();let calls=0;
const request=async url=>{
  calls++;const q=url.searchParams,id=q.get("FID_INPUT_ISCD"),from=candleDate(q.get("FID_INPUT_DATE_1")),to=candleDate(q.get("FID_INPUT_DATE_2"));
  const output2=[];for(let t=Date.parse(from);t<=Date.parse(to);t+=86400000){
    const date=new Date(t);if(![0,6].includes(date.getUTCDay()))output2.push({stck_bsop_date:date.toISOString().slice(0,10).replaceAll("-",""),bstp_nmix_oprc:"100",bstp_nmix_hgpr:"110",bstp_nmix_lwpr:"95",bstp_nmix_prpr:id==="0001"?"102":"99"});
  }return Response.json({rt_cd:"0",output1:{bstp_cls_code:id},output2:output2.reverse()});
};
const [a,b]=await Promise.all([load(d,request,opts.calendar),load(d,request,opts.calendar)]);
assert.deepEqual(a,b);assert.equal(calls,4);
for(const {market,candles} of a){
 assert.equal(candles.bars.length,50);assert.equal(candles.latest,d);assert.equal(candles.bars.at(-1).close,market==="KOSPI"?102:99);
 assert.deepEqual(candles.bars.map(v=>v.date),candles.bars.map(v=>v.date).sort());
}
assert.equal((await indexCandleReader()(d,async()=>Response.json({rt_cd:"0",output1:{bstp_cls_code:"WRONG"},output2:[]}),{}))[0].candles.status,"ERROR");
console.log("PASS: dates, session gaps, invalid & conflicting OHLC, short history, exchange identity, paging/cache and ordering");
