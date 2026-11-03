"use client";

import { useEffect, useState } from "react";
import styles from "./HomeDashboard.module.css";

type Market = "KOSPI" | "KOSDAQ";
import DailyCandles, {type CandleData} from "./DailyCandles";
type Index = { market: Market; status: "UNAVAILABLE"; candles?:CandleData } | {
  market: Market; status: "AVAILABLE"; date: string; close: number; changePct: number | null;
  observedAt: string; candles:CandleData;
};
const number = new Intl.NumberFormat("ko-KR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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
  const lookup = (name: Market) => indices?.find(row => row.market === name);
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
              <small className={row.changePct === null || row.changePct === 0 ? "" : row.changePct > 0 ? styles.up : styles.down}>{row.changePct === null ? "등락 미확인" : `${row.changePct > 0 ? "+" : ""}${number.format(row.changePct)}%`}</small><small>{row.date} · 전 거래일 대비</small></> : <small>{indices === null ? "조회 중" : "지수 미확인"}</small>}
          </button>;
        })}
      </div>
      <div className="min-w-0"><DailyCandles key={market+":"+index?.candles?.latest} title={market} unit="pt" data={index?.candles} source="한국투자증권 · 국내업종기간별시세 FHKUP03500100" loading={indices===null} retry={retry}/></div>
    </div>
  </section>;
}
