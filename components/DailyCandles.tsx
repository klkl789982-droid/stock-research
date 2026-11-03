"use client";
import {useState} from "react";
import styles from "./DailyCandles.module.css";
export type Candle={date:string;open:number;high:number;low:number;close:number};
export type CandleData={bars:Candle[];latest:string|null;missing:string[];invalid:string[];unknown:string[];receivedAt:string|null;failedPages:number;status:string;badDates?:number};
const kst=new Intl.DateTimeFormat("ko-KR",{timeZone:"Asia/Seoul",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hourCycle:"h23"});
export default function DailyCandles({title,unit,data,source,retry,loading=false}:{title:string;unit:"원"|"pt";data?:CandleData|null;source:string;retry:()=>void;loading?:boolean}){
  const [selection,setSelection]=useState<string|null>(null);
  const bars=data?.bars??[],n=bars.length, latest=bars.at(-1),selected=bars.find(b=>b.date===selection)??latest;
  const num=(v:number)=>v.toLocaleString("ko-KR",{minimumFractionDigits:unit==="pt"?2:0,maximumFractionDigits:unit==="pt"?2:0});
  if(!latest||!selected||!data)return <section className={styles.empty} aria-label={title+" 일봉"} role="status"><strong>{title} · 일봉</strong>
    <p>{loading?"일봉 조회 중…":data?.status==="EMPTY"?"거래일·OHLC가 일치하는 일봉이 없습니다.":"일봉 조회 실패 또는 원천 응답 없음"}</p>{!loading&&<button type="button" onClick={retry}>다시 조회</button>}</section>;
  const bottom=Math.min(...bars.map(b=>b.low)),top=Math.max(...bars.map(b=>b.high)),pad=Math.max((top-bottom)*.08,top*.001,unit==="원"?1:.01);
  const lo=bottom-pad,hi=top+pad,y=(v:number)=>(hi-v)/(hi-lo)*240;
  const idx=bars.indexOf(selected), x=(i:number)=>(i+.5)*1000/n, w=Math.min(15,1000/n*.65);
  const ticks=[...new Set([0,Math.floor((n-1)/2),n-1])];
  const pick=(clientX:number,el:SVGSVGElement)=>{const r=el.getBoundingClientRect();if(r.width)setSelection(bars[Math.max(0,Math.min(n-1,Math.floor((clientX-r.left)/r.width*n)))].date)};
  return <figure className={styles.figure} aria-label={title+" 일봉 캔들"}>
    <figcaption><strong>{title} · 일봉</strong><span>{n}거래일 · 단위 {unit}</span></figcaption>
    <p className={styles.meta}>최신 봉 {latest.date} · {unit==="pt"?"마감 확정 여부 미확인":"공식 일봉 · 별도 마감 확정 표식 없음"}</p>
    {(n<50||data.failedPages>0||data.missing.length>0||data.invalid.length>0||!!data.badDates)&&<p className={styles.notice}>{n}/50거래일 · {data.failedPages?"일부 구간 조회 실패":data.invalid.length?"무거래 또는 OHLC 검증 제외":data.missing.length?"해당 거래일 일봉 누락":"원천에서 확보한 유효 자료 부족"} <button type="button" onClick={retry}>다시 조회</button></p>}
    <div className={styles.frame}><div className={styles.plot}>
      <svg viewBox="0 0 1000 240" preserveAspectRatio="none" tabIndex={0} role="slider" aria-label={title+" 캔들 날짜 선택"} aria-valuemin={1} aria-valuemax={n} aria-valuenow={idx+1} aria-valuetext={selected.date+" 종가 "+num(selected.close)+unit}
        onPointerMove={e=>pick(e.clientX,e.currentTarget)} onPointerDown={e=>pick(e.clientX,e.currentTarget)}
        onKeyDown={e=>{const next=({ArrowLeft:idx-1,ArrowRight:idx+1,Home:0,End:n-1} as Record<string,number>)[e.key];if(next!==undefined){e.preventDefault();setSelection(bars[Math.min(n-1,Math.max(0,next))].date)}}}>
        {[0,1,2,3,4].map(i=><line key={i} x1={0} x2={1000} y1={i*60} y2={i*60} className={styles.grid}/>)}
        <line x1={x(idx)} x2={x(idx)} y1={0} y2={240} stroke="#94a3b8" strokeDasharray="3 4" vectorEffect="non-scaling-stroke"/>
        {bars.map((b,i)=>{const color=b.close>b.open?"var(--tb-positive)":b.close<b.open?"var(--tb-negative)":"#526175",doji=b.open===b.close;
          return <g key={b.date} data-session={b.date}><line x1={x(i)} x2={x(i)} y1={y(b.high)} y2={y(b.low)} stroke={color} vectorEffect="non-scaling-stroke"/>
          <rect x={x(i)-w/2} y={doji?y(b.open)-.8:y(Math.max(b.open,b.close))} width={w} height={doji?1.6:Math.abs(y(b.open)-y(b.close))} fill={color}/></g>})}
      </svg>
      <div className={styles.dates}>{ticks.map(i=><span key={i}>{bars[i].date.slice(5).replace("-",".")}</span>)}</div>
    </div><div className={styles.axis} aria-label={"가격축 "+unit}>{[0,1,2,3,4].map(i=><span key={i}>{num(hi-(hi-lo)*i/4)}</span>)}</div></div>
    <div className={styles.readout}><strong>{selected.date}</strong>{([["시가",selected.open],["고가",selected.high],["저가",selected.low],["종가",selected.close]] as const).map(([k,v])=><span key={k}>{k} <b>{num(v)}{unit}</b></span>)}</div>
    <details><summary>데이터 상세{data.unknown.length?" · 휴장 여부 미확인 "+data.unknown.length+"일":""}</summary>
      <p>{source} · {bars[0].date} ~ {latest.date} · 시스템 수신 {data.receivedAt?kst.format(new Date(data.receivedAt))+" KST":"미확인"}</p>
      <p>{unit==="pt"?"원천 일봉 지수 단위(pt), 별도 배율 적용 없음. 카드 등락률은 전 거래일 종가 대비입니다.":"원천 공시 시가·고가·저가·종가(원)를 그대로 표시합니다. 자체 수정주가 보정 없음. 원천의 소급 조정 여부는 미확인으로, 분할·병합·증자 전후 가격이 불연속일 수 있습니다."}</p>
      <p>빨강: 종가가 시가보다 높음 · 파랑: 낮음 · 회색: 보합. 마우스·터치 또는 좌우 화살표로 날짜를 선택합니다.</p>
      {data.missing.length>0&&<p>자료 없는 거래일: {data.missing.join(", ")}</p>}{data.invalid.length>0&&<p>무거래·값 오류·중복 충돌 제외: {data.invalid.join(", ")}</p>}
      {!!data.badDates&&<p>날짜를 식별할 수 없는 원천 행 {data.badDates}개 제외</p>}
      {data.unknown.length>0&&<p>일봉·달력만으로 휴장과 결측을 구분하지 못한 평일: {data.unknown.join(", ")}. 빈 날짜는 보간하지 않았습니다.</p>}
    </details></figure>;
}
