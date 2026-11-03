import { liveScoreBounds, validLiveScore } from "./live-model-score-contract.mjs";
export const versions = Object.freeze(["A-v1", "B-v1", "C-v1", "D-v1"]);
export const bounds = date => ({ start: Date.parse(`${date}T14:00:00+09:00`), end: Date.parse(`${date}T15:30:00+09:00`) });

export function requiredRowIssues(r, day) {
  const issues=[], b=bounds(day);
  const issue=(field, value, rule)=>issues.push({field, value, rule});
  if(r?.status!=="AVAILABLE") issue("status",r?.status??null,"AVAILABLE");
  if(!r)return issues;
  if(r.observedDate!==day)issue("observedDate",r.observedDate??null,day);
  for(const v of versions){const s=r.scores?.[v];if(!validLiveScore(v,s))issue("scores."+v,Number.isFinite(s)?s:null,"finite "+liveScoreBounds(v).join(".."));}
  const keys=["quoteRequestedAt","quoteReceivedAt","minuteRequestedAt","minuteReceivedAt"];
  keys.forEach((k,i)=>{const t=Date.parse(r[k]);if(!Number.isFinite(t)||t<b.start||t>b.end)issue(k,r[k]??null,"inside session");
    if(i&&Date.parse(r[keys[i-1]])>t)issue(k,r[k],"not before "+r[keys[i-1]]);});
  const local=Date.parse(r.observedDate+"T"+r.observedTime+"+09:00");
  if(!/^\d{2}:\d{2}:\d{2}$/u.test(r.observedTime??"")||!Number.isFinite(local))issue("observedTime",r.observedTime??null,"valid KST HH:mm:ss");
  else if(local<b.start)issue("observedTime",r.observedTime,"at or after 14:00:00 KST");
  else if(local>Date.parse(r.quoteReceivedAt))issue("observedTime",r.observedTime,"not after "+r.quoteReceivedAt);
  for(const k of ["originalRecordHash","responseHash"])if(!/^[a-f0-9]{64}$/u.test(r[k]??""))issue(k,r[k]==null?null:"invalid digest","SHA256");
  for(const [k,want] of [["rawPricesStored",false],["modelFormulaUnchanged",true]])if(r[k]!==want)issue(k,r[k]??null,String(want));
  return issues;
}
