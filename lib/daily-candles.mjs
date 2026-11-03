// Presentation only. No closing-price interpolation and no LIVE or model writes.
export function candleDate(v){
  const s=String(v??"").replace(/^(\d{4})(\d{2})(\d{2})$/,"$1-$2-$3");
  if(!/^\d{4}-\d{2}-\d{2}$/.test(s))return null;
  const d=new Date(s+"T00:00:00Z");return Number.isFinite(+d)&&d.toISOString().slice(0,10)===s?s:null;
}
const number=v=>typeof v==="number"?v:typeof v==="string"&&/^\d+(\.\d+)?$/.test(v.trim())?Number(v):NaN;
const shift=(s,n)=>new Date(Date.parse(s)+n*86400000).toISOString().slice(0,10);
const weekday=d=>![0,6].includes(new Date(d).getUTCDay());
export function candleWindow(rows,{through,calendar={},peers=[],receivedAt=null,failedPages=0}){
  const bars=new Map(),bad=new Set(),sessions=new Set(), unknown=[];
  const state=d=>calendar?.dates?.[d]?.status;
  let badDates=0;
  for(const r of rows){
    const date=candleDate(r.date);if(!date){badDates++;continue;}if(date>through||!weekday(date)||state(date)==="marketClosed")continue;
    sessions.add(date);
    const [open,high,low,close]=[r.open,r.high,r.low,r.close].map(number);
    if(r.noTrade||![open,high,low,close].every(n=>Number.isFinite(n)&&n>0)||low>Math.min(open,close)||high<Math.max(open,close)){bad.add(date);continue;}
    const prior=bars.get(date);
    if(prior&&[open,high,low,close].some((v,i)=>v!==[prior.open,prior.high,prior.low,prior.close][i]))bad.add(date);
    else bars.set(date,{date,open,high,low,close});
  }
  const availableThrough=[...sessions,...peers.filter(d=>candleDate(d)&&d<=through)].sort().at(-1);
  for(const d of [...Object.keys(calendar?.dates??{}).filter(d=>state(d)==="tradingDay"),...peers]){
    if(candleDate(d)&&d<=through&&d<=availableThrough&&weekday(d)&&state(d)!=="marketClosed")sessions.add(d);
  }
  const dates=[...sessions].sort().slice(-50), selected=dates.flatMap(d=>bars.has(d)&&!bad.has(d)?[bars.get(d)]:[]);
  const missing=dates.filter(d=>!bars.has(d)&&!bad.has(d)),invalid=dates.filter(d=>bad.has(d));
  for(let d=dates[0];d&&d<=dates.at(-1);d=shift(d,1))if(weekday(d)&&!sessions.has(d)&&state(d)!=="marketClosed")unknown.push(d);
  return {bars:selected,latest:selected.at(-1)?.date??null,missing,invalid,unknown,receivedAt,failedPages,badDates,
    status:!selected.length?(failedPages?"ERROR":"EMPTY"):selected.length<50||invalid.length||missing.length||failedPages||badDates?"PARTIAL":"AVAILABLE"};
}
