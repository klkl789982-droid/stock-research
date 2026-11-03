// Independent reconstruction, reading only research outputs and official seed/ledger files.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const json=async p=>JSON.parse(await readFile(p,"utf8")),audit=await json(process.argv[2]),report=await json("data/model-validation/top-cross-comparison-v1.json");
assert.equal(audit.planHash,report.planHash);const close=(a,b,eps=1e-5)=>assert.ok(Math.abs(a-b)<eps,"numeric reconciliation");
for(const d of ["2026-10-01","2026-10-14","2026-10-26"]){
  const [h,seed]=await Promise.all([json("data/history/"+d+".json"),json("data/analysis/market-seeds/"+d+".json")]);
  const s=audit.selections[d]["B-v1"],pool=new Set(s.pool.map(r=>r.code)),cross=[];
  for(const r of seed.records.filter(r=>pool.has(r.code))){
    const closes=r.rows.slice(0,21).map(v=>v[4]);assert.equal(r.rows[0][0],d.replaceAll("-",""));
    const total=(i,n)=>closes.slice(i,i+n).reduce((a,b)=>a+b,0);
    if(4*total(1,5)<=total(1,20) && 4*total(0,5)>total(0,20))cross.push(r.code);
  }
  const top=h.records.filter(r=>pool.has(r.code)&&r.ranks.modelB>=1&&r.ranks.modelB<=10).sort((a,b)=>a.ranks.modelB-b.ranks.modelB).map(r=>r.code);
  assert.deepEqual(s.TOP,top);assert.deepEqual(s.CROSS,cross.sort().slice(0,10));assert.deepEqual(s.BOTH,top.filter(c=>cross.includes(c)));
}
const cal=(await json("data/trading-calendar/status.json")).dates,dates=Object.keys(cal).filter(d=>cal[d].status==="tradingDay").sort(),ledgers=new Map();
for(const d of dates.filter(d=>d>="2026-10-01"&&d<=report.through)){const l=await json("data/market-prices/"+d+".json");ledgers.set(d,new Map(l.records.map(v=>[v.code,v])));}
let checked=0, valuations=0;
for(const [k,a] of Object.entries(audit.tradeAudit)){
  if(a.status!=="VALUED")continue;
  const row=report.summary.find(r=>[r.layer,r.model,r.arm,r.basis].join("/")===k);assert.ok(row);let peak=1e8,mdd=0;
  for(const v of a.trades){
    assert.equal(dates[dates.indexOf(v.entryDate)+4],v.exitDate);
    assert.ok(v.entryDate>v.signalDate);assert.equal(v.open,ledgers.get(v.entryDate).get(v.ticker).openPrice);assert.equal(v.close,ledgers.get(v.exitDate).get(v.ticker).closePrice);
    close(v.outlay,v.units*v.open*1.0005*1.0002,1e-6);close(v.proceeds,v.units*v.close*.9995*(1-.0002-.002),1e-6);
    assert.ok(!a.trades.some(w=>w!==v&&w.ticker===v.ticker&&w.entryDate>=v.entryDate&&w.entryDate<=v.exitDate));checked++;
  }
  let prev=1e8;for(const n of a.nav){
    const open=a.trades.filter(t=>t.entryDate<=n.date&&t.exitDate>=n.date),held=open.filter(t=>t.exitDate>n.date);
    assert.ok(open.length<=10);const spent=a.trades.filter(t=>t.entryDate<=n.date).reduce((v,t)=>v+t.outlay,0),
      receipts=a.trades.filter(t=>t.exitDate<=n.date).reduce((v,t)=>v+t.proceeds,0),cash=1e8-spent+receipts;
    const equity=cash+held.reduce((v,t)=>v+t.units*ledgers.get(n.date).get(t.ticker).closePrice,0);
    for(const t of open.filter(t=>t.entryDate===n.date))assert.ok(t.outlay<=prev/10+0.00001);
    close(n.cash,cash/1e6);close(n.value,equity/1e6);assert.ok(cash>=-0.00001);peak=Math.max(peak,equity);mdd=Math.min(mdd,equity/peak-1);prev=equity;valuations++;
  }
  close(row.mdd,mdd*100);close(row.total,(prev/1e8-1)*100);
}
assert.ok(checked&&valuations);console.log(JSON.stringify({independentSignalDates:3,checkedTradeLegsAcrossOverlappingReports:checked,checkedDailyNAVs:valuations}));
