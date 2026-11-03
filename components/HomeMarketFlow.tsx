"use client";

import { useEffect, useState } from "react";
import styles from "./HomeDashboard.module.css";

type Market = "KOSPI" | "KOSDAQ";
type Point = { date: string; close: number };
type Index = { market: Market; status: "UNAVAILABLE" } | {
  market: Market; status: "AVAILABLE"; date: string; close: number; changePct: number | null;
  observedAt: string; recentCloses: Point[];
};
const number = new Intl.NumberFormat("ko-KR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const received = new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

export function IndexFlowChart({ points, market }: { points: Point[]; market: Market }) {
  if (points.length < 2) return <p role="status" className={styles.noChart}>연속된 지수 일봉이 부족해 흐름을 표시할 수 없습니다.</p>;
  const values = points.map(p => p.close);
  const high = Math.max(...values), low = Math.min(...values);
  const y = (n: number) => high === low ? 50 : 8 + 84 * (high - n) / (high - low);
  const vertices = values.map((value, i) => `${(i * 100 / (values.length - 1)).toFixed(2)},${y(value).toFixed(2)}`).join(" ");
  return <figure className={styles.figure}>
    <figcaption><strong>{market}</strong> · 최근 {points.length}거래일 지수 <span>단위 pt</span></figcaption>
    <div className={styles.chart}>
      <div aria-hidden="true" className={styles.axis}><span>{number.format(high)}</span>{high !== low && <span>{number.format(low)}</span>}</div>
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label={`${market} 거래일별 지수. ${points.map(p => p.date + " " + number.format(p.close)).join(", ")}`}>
        {[8,50,92].map(row => <line key={row} x1="0" x2="100" y1={row} y2={row} stroke="var(--tb-border)" strokeWidth="1" vectorEffect="non-scaling-stroke" />)}
        <polygon points={`0,100 ${vertices} 100,100`} fill="#eaf2ff" fillOpacity=".7" />
        <polyline points={vertices} fill="none" stroke="var(--tb-blue)" strokeWidth="2.6" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
      </svg>
    </div>
    <div className={styles.chartDates} aria-hidden="true">{points.map(point => <span key={point.date}>{point.date.slice(5).replace("-", ".")}</span>)}</div>
  </figure>;
}

export default function HomeMarketFlow() {
  const [market, setMarket] = useState<Market>("KOSPI");
  const [indices, setIndices] = useState<Index[] | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/market-overview", { cache: "no-store", signal: controller.signal })
      .then(async res => {
        if (!res.ok) throw new Error();
        const body = await res.json();
        if (!Array.isArray(body.indices)) throw new Error();
        if (!controller.signal.aborted) setIndices(body.indices);
      })
      .catch(() => { if (!controller.signal.aborted) setIndices([]); });
    return () => controller.abort();
  }, [attempt]);
  const lookup = (name: Market) => indices?.find(row => row.market === name && row.status === "AVAILABLE");
  const index = lookup(market);
  const retry = () => { setIndices(null); setAttempt(n => n + 1); };
  return <section className="tb-card min-w-0 p-4 sm:p-6" aria-labelledby="home-market-flow">
    <div className={styles.titleRow}><h2 id="home-market-flow">시장 흐름</h2>{index?.status === "AVAILABLE" && <span>지수 거래일 {index.date}</span>}</div>
    <div className={styles.flow}>
      <div className={styles.indices} role="group" aria-label="시장 지수 선택">
        {(["KOSPI","KOSDAQ"] as const).map(name => {
          const row = lookup(name);
          return <button key={name} type="button" className={"tb-focus " + styles.index} aria-pressed={market === name} onClick={() => setMarket(name)}>
            <span>{name}</span>{row?.status === "AVAILABLE" ? <><strong>{number.format(row.close)}</strong>
              <small className={row.changePct === null || row.changePct === 0 ? "" : row.changePct > 0 ? styles.up : styles.down}>{row.changePct === null ? "등락 미확인" : `${row.changePct > 0 ? "+" : ""}${number.format(row.changePct)}%`}</small></> : <small>{indices === null ? "조회 중" : "지수 미확인"}</small>}
          </button>;
        })}
      </div>
      <div className="min-w-0">{index?.status === "AVAILABLE" ? <>
        <IndexFlowChart points={index.recentCloses ?? []} market={market} />
        <p className={styles.receipt}>일봉 · 거래소 기준시각·마감 확정 여부 미확인 · 시스템 수신 {received.format(new Date(index.observedAt))} KST</p>
      </> : <div className={styles.noChart} role="status">{indices === null ? "지수 일봉을 불러오는 중입니다." : <><span>{market} 지수 자료를 확인할 수 없습니다.</span><button className="tb-focus" type="button" onClick={retry}>다시 조회</button></>}</div>}</div>
    </div>
  </section>;
}
