"use client";
import { useMemo, useState } from "react";
import { prepareOfficialChart, PUBLIC_PRICE_CHART_APPROVED } from "../lib/stock-chart.mjs";
type Meta = { code: string; source: string; priceBasis: string; asOfDate: string; closePrice: number };
type Bar = { date: string; open: number; high: number; low: number; close: number; volume: number; ma5: number | null; ma20: number | null; ma60: number | null };
type Row = { basDt: string; srtnCd: string; mkp: string | number; hipr: string | number; lopr: string | number; clpr: string | number; trqu: string | number };

export default function StockPriceChart({ rows, meta, displayApproved = PUBLIC_PRICE_CHART_APPROVED }: { rows: Row[]; meta: Meta | null; displayApproved?: boolean }) {
  const [period, setPeriod] = useState(60), [selected, setSelected] = useState<string | null>(null);
  const chart = useMemo(() => {
    if (!displayApproved || !meta) return null;
    try { return prepareOfficialChart(rows, meta); } catch { return null; }
  }, [rows, meta, displayApproved]);
  const bars: Bar[] = chart?.bars.slice(-period) ?? [], firstDate = bars[0]?.date;
  const selectedBar = bars.find((bar) => bar.date === selected) ?? bars.at(-1);
  const allPrices = bars.flatMap((b) => [b.low, b.high, b.ma5, b.ma20, b.ma60].filter((n): n is number => n !== null));
  const min = Math.min(...allPrices), max = Math.max(...allPrices), span = Math.max(max - min, max * .02, 1);
  const x = (i: number) => 40 + (i + .5) * 660 / Math.max(bars.length, 1);
  const y = (price: number) => 22 + (max - price) / span * 220;
  const maxVolume = Math.max(...bars.map((b) => b.volume), 1);
  const path = (key: "ma5" | "ma20" | "ma60") => bars.flatMap((b, i) => b[key] === null ? [] : [`${i === 0 || bars[i - 1][key] === null ? "M" : "L"}${x(i)},${y(b[key]!)}`]).join(" ");
  return <section aria-label="일봉 가격 차트" className="mt-3 rounded-xl border border-slate-200 bg-[#f7f3eb] p-3">
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-semibold">일봉 · 거래량 · MA5/20/60</h3><span className="text-xs text-slate-600">{meta?.asOfDate ?? "기준일 미확인"} · 공식 일봉 · 실시간 아님</span></div>
    {!displayApproved ? <p className="mt-2 text-xs leading-relaxed text-slate-600">가격 차트 공개 연결 보류: 공급처의 웹사이트 표시·재배포 권한 확인이 필요합니다. 차트 구조와 검증은 준비되어 있으며, 미승인 KIS 시세는 연결하지 않습니다.</p> : !chart ? <p className="mt-2 text-xs text-amber-800">가격 데이터의 코드·기준일·OHLCV 정합성을 확인할 수 없어 차트를 표시하지 않습니다.</p> : <>
      <div className="mt-2 flex flex-wrap gap-1" aria-label="차트 기간">{[20, 60, 120, 260].map((n) => <button key={n} type="button" aria-pressed={period === n} onClick={() => { setPeriod(n); setSelected(null); }} className={`tb-focus rounded px-3 py-2 text-xs ${period === n ? "bg-slate-900 text-white" : "bg-[#e9e3d8]"}`}>{n}거래일</button>)}</div>
      <svg viewBox="0 0 740 330" role="img" aria-label="공식 일봉 캔들과 거래량, 이동평균, 골든·데드크로스" className="mt-2 w-full">
        {[0, 1, 2, 3].map((n) => <g key={n}><line x1="40" x2="700" y1={22 + n * 220 / 3} y2={22 + n * 220 / 3} stroke="#d6d2c9" /><text x="704" y={26 + n * 220 / 3} fontSize="9" fill="#596579">{Math.round(max - n * span / 3).toLocaleString()}</text></g>)}
        {bars.map((b, i) => <g key={b.date} fill={b.close >= b.open ? "#c94342" : "#3971ad"}><title>{`${b.date} 시가 ${b.open} 고가 ${b.high} 저가 ${b.low} 종가 ${b.close} 거래량 ${b.volume}`}</title><line x1={x(i)} x2={x(i)} y1={y(b.high)} y2={y(b.low)} stroke={b.close >= b.open ? "#c94342" : "#3971ad"} /><rect x={x(i) - Math.max(1, 220 / bars.length)} y={y(Math.max(b.open, b.close))} width={Math.max(2, 440 / bars.length)} height={Math.max(1, Math.abs(y(b.open) - y(b.close)))} /><rect x={x(i) - Math.max(1, 220 / bars.length)} y={302 - b.volume / maxVolume * 42} width={Math.max(2, 440 / bars.length)} height={b.volume / maxVolume * 42} opacity=".55" /></g>)}
        {(["ma5", "ma20", "ma60"] as const).map((key, i) => <path key={key} d={path(key)} fill="none" stroke={["#ad643b", "#427e73", "#7567a1"][i]} strokeWidth="1.5" />)}
        {chart.crosses.filter((c) => c.date >= firstDate).map((c) => { const i = bars.findIndex((b) => b.date === c.date); return <text key={c.date + c.pair} x={x(i)} y={c.direction === "golden" ? y(bars[i].low) + 13 : y(bars[i].high) - 5} textAnchor="middle" fontSize="10" fill={c.direction === "golden" ? "#b95435" : "#3971ad"}><title>{`${c.date} ${c.pair} ${c.direction === "golden" ? "골든" : "데드"}크로스`}</title>{c.direction === "golden" ? "▲" : "▼"}</text>; })}
        <text x="40" y="322" fontSize="10" fill="#596579">{firstDate}</text><text x="700" y="322" textAnchor="end" fontSize="10" fill="#596579">{bars.at(-1)?.date}</text>
      </svg>
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-600"><span className="text-[#ad643b]">MA5</span><span className="text-[#427e73]">MA20</span><span className="text-[#7567a1]">MA60</span><span>▲ 골든 / ▼ 데드</span><label className="ml-auto">날짜 확인 <select className="tb-focus rounded border border-slate-200 p-1" value={selectedBar?.date ?? ""} onChange={(e) => setSelected(e.target.value)}>{bars.map((b) => <option key={b.date}>{b.date}</option>)}</select></label></div>
      {selectedBar && <p className="mt-2 text-xs text-slate-700">{selectedBar.date} · O {selectedBar.open.toLocaleString()} / H {selectedBar.high.toLocaleString()} / L {selectedBar.low.toLocaleString()} / C {selectedBar.close.toLocaleString()} · 거래량 {selectedBar.volume.toLocaleString()}</p>}
    </>}
  </section>;
}
