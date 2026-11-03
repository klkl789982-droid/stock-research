import {taxEligibilityForStudy} from "./research-sell-tax.mjs";
import {validateIntradayMarketSeed} from "./intraday-market-seed.mjs";
export const names=["5일 수익률","20일 수익률","20일 변동성","상승일 비중","5/20 신규 골든크로스","거래량 배율"];
const closed=new Set("01-01 02-16 02-17 02-18 03-02 05-01 05-05 05-25 06-03 07-17 08-17 09-24 09-25 10-05 10-09 12-25 12-31".split(" "));
export const mean=a=>a.length?a.reduce((s,v)=>s+v,0)/a.length:null;
export const round=v=>Number.isFinite(v)?+v.toFixed(5):null;
export function midranks(arr){
  const ord=arr.map((v,i)=>[v,i]).sort((a,b)=>a[0]-b[0]),out=[];
  for(let i=0;i<ord.length;){let j=i+1;while(j<ord.length&&ord[j][0]===ord[i][0])j++;
    for(let k=i;k<j;k++)out[ord[k][1]]=(i+j)/(2*ord.length);i=j;}return out;
}
export function spearman(x,y){if(x.length<2)return null;const a=midranks(x),b=midranks(y);let s=0,aa=0,bb=0;
 for(let i=0;i<a.length;i++){const u=a[i]-.5,v=b[i]-.5;s+=u*v;aa+=u*u;bb+=v*v}return aa*bb?s/Math.sqrt(aa*bb):null;}
export function panel(seed,master){
 if(!/^2026-/.test(seed.requestedDate)||validateIntradayMarketSeed(seed,553).length)throw Error("UNVERIFIED_SEED_OR_YEAR");
 const date=seed.requestedDate,calendar={dates:{}},days=[];
 for(let t=Date.parse("2026-01-01");t<=Date.parse(date);t+=86400000){const e=new Date(t),d=e.toISOString().slice(0,10);const open=![0,6].includes(e.getUTCDay())&&!closed.has(d.slice(5));
 calendar.dates[d]={status:open?"tradingDay":"marketClosed"};if(open)days.push(d);}
 const tax=taxEligibilityForStudy(master,[{asOfDate:date,sourceManifest:seed.sourceManifest}]);
 const assets=seed.records.map(r=>{const map=new Map();for(const b of r.rows){const d=b[0];map.set(d,map.has(d)?null:b);}
 return {code:r.code,name:r.name,market:r.market,reason:!r.eligible?"공식 seed 적격 제외":!tax(date,r,"2026-12-31")?"보통주·세율 근거 부족":null,bars:days.map(d=>map.get(d.replaceAll("-","")))}});
 return {days,assets,calendar,date,generatedAt:seed.generatedAt};
}
export function tradable(b){return !!b&&b.slice(1,6).length===5&&b.slice(1,6).every(v=>Number.isFinite(v)&&v>0)&&b[3]<=Math.min(b[1],b[4])&&b[2]>=Math.max(b[1],b[4]);}
export function chain(bars){return bars.length>0&&Array.from(bars).every((b,i)=>tradable(b)&&(!i||Math.abs(b[4]/bars[i-1][4]-1)<=.301));}
export function frame(p,i){
 const rows=[],excluded=[];
 for(const a of p.assets){const b=a.bars.slice(Math.max(0,i-20),i+1);const reason=a.reason??(b.length!==21?"21거래일 미성숙":!chain(b)?"거래·OHLCV 공백 또는 가격 단절":null);
 if(reason){excluded.push({code:a.code,name:a.name,reason});continue;}
 const c=b.map(x=>x[4]),ret=c.slice(1).map((v,j)=>v/c[j]-1),av=mean(ret);
 rows.push({code:a.code,name:a.name,market:a.market,raw:[c[20]/c[15]-1,c[20]/c[0]-1,Math.sqrt(mean(ret.map(v=>(v-av)**2))),ret.filter(v=>v>0).length/20,
 Number(mean(c.slice(15,20))<=mean(c.slice(0,20))&&mean(c.slice(16))>mean(c.slice(1))),b[20][5]/mean(b.slice(0,20).map(v=>v[5]))],x:[]});}
 for(let k=0;k<6;k++){const ranks=midranks(rows.map(r=>r.raw[k]));rows.forEach((r,j)=>r.x.push(ranks[j]));}
 return {rows,excluded};
}
export function outcome(a,entry,h){
 const b=a.bars.slice(entry,entry+h);if(b.length!==h||!chain(b))return null;
 const prior=a.bars[entry-1];if(!tradable(prior)||Math.abs(b[0][1]/prior[4]-1)>.301||Math.abs(b[0][4]/prior[4]-1)>.301)return null;
 return b.at(-1)[4]/b[0][1]-1;
}
export function fit(days,target){
 const acc=Array.from({length:6},()=>Array.from({length:5},()=>[0,0]));let sum=0,n=0;
 for(const day of days){const valid=day.rows.filter(r=>Number.isFinite(r.y));if(!valid.length)continue;n++;
 for(const r of valid){const w=1/valid.length,y=target==="R"?r.y:Number(r.y>0);sum+=w*y;for(let j=0;j<6;j++){const v=acc[j][Math.min(4,Math.floor(r.x[j]*5))];v[0]+=w*y;v[1]+=w;}}}
 if(n<10)throw Error("TRAINING_DAYS_INSUFFICIENT");const base=sum/n;
 return {base,days:n,bins:acc.map(c=>c.map(([s,w])=>(s+2*base)/(w+2)))};
}
export function predict(fit,r,features){
 const parts=features.map(k=>{const z=Math.max(0,Math.min(4,r.x[k]*5-.5)),lo=Math.floor(z),hi=Math.ceil(z);return fit.bins[k][lo]+(fit.bins[k][hi]-fit.bins[k][lo])*(z-lo);});
 return {value:mean(parts),parts};
}
export function liveRanks(current,fitted,features){
 const rows=current.rows.map(r=>{const {value,parts}=predict(fitted,r,features);
 const drivers=features.map((k,i)=>({k,impact:parts[i]-fitted.base})).sort((a,b)=>b.impact-a.impact);
 const label=k=>names[k]+" "+(k===4?(r.raw[k]?"발생":"없음"):k===5?r.raw[k].toFixed(2)+"배":(r.raw[k]*100).toFixed(1)+"%");
 return {code:r.code,name:r.name,value,reason:drivers.slice(0,2).map(d=>label(d.k)).join(" · "),risk:r.x[2]>.8?"상대 고변동":r.x[0]>.9?"최근 급등":"체결·기업행사 미확인"};});
 const ranks=midranks(rows.map(r=>r.value)),ties=new Map();for(const r of rows)ties.set(r.value,(ties.get(r.value)??0)+1);
 return rows.map((r,i)=>({...r,score:round(ranks[i]*100)})).sort((a,b)=>b.value-a.value||a.code.localeCompare(b.code)).map((r,i)=>({rank:i+1,code:r.code,name:r.name,score:r.score,tied:ties.get(r.value),reason:r.reason,risk:r.risk}));
}
