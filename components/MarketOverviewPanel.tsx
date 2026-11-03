"use client";

import { useEffect, useState } from "react";

type IndexRow = { market: "KOSPI" | "KOSDAQ" } & ({ status: "UNAVAILABLE" } | {
  status: "AVAILABLE"; close: number; date: string; observedAt: string; priorDate: string | null;
  change: number | null; changePct: number | null; return5Pct: number | null; volatility20Pct: number | null;
  timing: "CURRENT_SOURCE_DAY" | "BEHIND_DAILY" | "DATED_DAILY";
  exchangeAsOfTime: string | null; closeConfirmed: boolean | null;
});
type Breadth = { status: "UNAVAILABLE" } | { status: "AVAILABLE"; date: string; priorDate: string;
  universe: number; compared: number; unavailable: number; up: number; flat: number; down: number };
type MarketOverview = { indices: IndexRow[]; breadth: Breadth };
const amount = new Intl.NumberFormat("ko-KR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const clock = new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const signed = (n: number, unit = "") => `${n > 0 ? "+" : ""}${amount.format(n)}${unit}`;
const tone = (n: number | null) => n === null || n === 0 ? "text-slate-600" : n > 0 ? "text-[var(--tb-positive)]" : "text-[var(--tb-negative)]";

export default function MarketOverviewPanel() {
  const [data, setData] = useState<MarketOverview | null>(null);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/market-overview", { cache: "no-store", signal: controller.signal })
      .then(async res => {
        if (!res.ok) throw new Error("unavailable");
        const result: MarketOverview = await res.json();
        if (!controller.signal.aborted) setData(result);
      })
      .catch(() => { if (!controller.signal.aborted) setFailed(true); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [attempt]);
  const breadth = data?.breadth;
  const indexDates = [...new Set(data?.indices.flatMap(row => row.status === "AVAILABLE" ? [row.date] : []))];
  return <section className="tb-card min-w-0 p-4 sm:p-6" aria-labelledby="market-overview-title">
    <header className="flex items-center justify-between gap-3">
      <h1 id="market-overview-title" className="tb-page-title">시장 현황</h1>
      <button type="button" disabled={loading} onClick={() => { setFailed(false); setLoading(true); setAttempt(n => n + 1); }}
        className="tb-focus rounded-lg border border-[var(--tb-border)] px-3 py-2 text-sm font-medium disabled:opacity-50">새로고침</button>
    </header>
    {failed && <p role="alert" className="mt-4 text-sm text-amber-800">시장 현황을 불러오지 못했습니다.{data ? " 아래는 직전 조회 결과입니다." : " 다시 시도해 주세요."}</p>}
    {!data && loading && <p role="status" className="mt-4 text-sm text-slate-600">시장 자료를 조회하고 있습니다.</p>}
    {data && <>
      <h2 className="mt-6 text-base font-bold text-slate-900">코스피·코스닥 지수</h2>
      <p className="mt-1 text-xs text-slate-600">한국투자증권 일봉 · {indexDates.join(" / ") || "거래일 미확인"} · 원천 지연 시간 미확인</p>
      <div className="tb-index-grid">
        {data.indices.map(row => <article key={row.market} className="min-w-0 border-l-2 border-[var(--tb-border)] pl-4" aria-label={row.market}>
          <h3 className="text-sm font-semibold text-slate-700">{row.market === "KOSPI" ? "코스피" : "코스닥"}</h3>
          {row.status === "UNAVAILABLE" ? <p className="mt-2 text-sm text-slate-600">지수 자료를 확인할 수 없습니다.</p> : <>
            <p className="mt-1 text-2xl font-bold tabular-nums text-slate-950">{amount.format(row.close)}<span className="ml-1 text-xs font-normal text-slate-500">pt</span></p>
            <p className={`mt-1 text-sm tabular-nums ${tone(row.change)}`}>{row.change === null || row.changePct === null ? "직전 종가 비교 자료 부족" : `전 거래일 대비 ${signed(row.change, "pt")} (${signed(row.changePct, "%")})`}</p>
            <p className="mt-3 text-xs leading-relaxed text-slate-600">{indexDates.length > 1 && `지수 거래일 ${row.date} · `}{row.timing === "BEHIND_DAILY" ? "저장된 공식 거래일보다 이전 자료 · " : row.timing === "DATED_DAILY" ? "과거 일봉 · " : ""}
              {row.exchangeAsOfTime ? `거래소 기준 ${row.exchangeAsOfTime} KST` : "거래소 기준시각 미확인"} · {row.closeConfirmed === true ? "마감 확정" : "마감 확정 여부 미확인"}</p>
            <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs tabular-nums text-slate-700">
              <dt>최근 5거래일 등락</dt><dd>{row.return5Pct === null ? "자료 부족" : signed(row.return5Pct, "%")}</dd>
              <dt>20거래일 일간 변동성</dt><dd>{row.volatility20Pct === null ? "자료 부족" : amount.format(row.volatility20Pct) + "%"}</dd>
            </dl>
          </>}
        </article>)}
      </div>
      <h2 className="mt-6 text-base font-bold text-slate-900">분석 대상 종목의 등락</h2>
      {breadth?.status === "AVAILABLE" ? <>
        {indexDates.some(date => date !== breadth.date) && <p className="mt-1 text-xs text-amber-800">지수 거래일 {indexDates.join(" / ")} · 종목 등락 기준일 {breadth.date} · 서로 다른 날짜의 자료입니다.</p>}
        <p className="mt-1 text-xs text-slate-600">{breadth.priorDate} → {breadth.date} 공식 종가 · 전체 분석 대상 {breadth.universe}종목 중 비교 가능 {breadth.compared}종목</p>
        {breadth.compared > 0 && <div className="tb-breadth-bar" aria-hidden="true">{[breadth.up,breadth.flat,breadth.down].map((n,i)=><i key={i} style={{flexGrow:n}}/>)}</div>}
        <dl className="mt-3 grid grid-cols-3 gap-1 border-y border-[var(--tb-border)] py-3 text-sm tabular-nums">
          {([["상승", breadth.up], ["보합", breadth.flat], ["하락", breadth.down]] as const).map(([label, n]) => <div key={label}>
            <dt className="text-xs text-slate-600">{label}</dt>
            <dd className="mt-1 font-semibold">{n}종목 <span className="inline-block text-xs font-normal text-slate-600">{breadth.compared ? `(${(n / breadth.compared * 100).toFixed(1)}%)` : ""}</span></dd>
          </div>)}
        </dl>
        <p className="mt-2 text-xs text-slate-600">비교 제외 {breadth.unavailable}종목 · 품질 검토 대상, 무거래 또는 자료 누락</p>
      </> : <p className="mt-2 text-sm text-slate-600">직전 거래일과 일치하는 종목별 공식 종가 자료를 확인할 수 없습니다.</p>}
      <details className="mt-4 text-xs text-slate-600"><summary className="tb-focus cursor-pointer font-medium">데이터 상세 · 출처와 계산 기준</summary>{data.indices.map(row=>row.status === "AVAILABLE" && <p key={row.market}>{row.market} · 지수 거래일 {row.date} · 시스템 수신 {clock.format(new Date(row.observedAt))} KST</p>)}
        <p className="mt-2 max-w-2xl leading-relaxed">지수 거래일은 원천 일봉의 영업 일자입니다. 수신시각은 이 서비스가 응답을 읽은 시각입니다. 일봉의 변경 여부만으로 마감 확정을 판단할 수 없습니다. <a className="underline" href="https://github.com/koreainvestment/open-trading-api/blob/main/examples_llm/domestic_stock/inquire_daily_indexchartprice/chk_inquire_daily_indexchartprice.py" target="_blank" rel="noreferrer">한국투자증권 필드 정의</a></p>
        <p className="mt-2 max-w-2xl leading-relaxed">지수 등락은 연속된 거래일의 종가를 비교합니다. 변동성은 최근 20개 일간 등락률의 표본 표준편차입니다. 종목 등락 비율의 분모는 두 거래일 모두 품질 검증을 통과하고 거래된 분석 대상입니다. 기업행사에 따른 가격 변동이 포함될 수 있습니다.</p>
      </details>
    </>}
  </section>;
}
