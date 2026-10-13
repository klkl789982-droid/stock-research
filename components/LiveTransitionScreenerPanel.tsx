"use client";

import { useEffect, useState } from "react";
import { useLiveTransitionRevalidation } from "./useLiveTransitionRevalidation";
import { LiveTransitionMetadata, LiveTransitionMetrics, LiveTransitionRules, liveDate, liveNumber, livePrice, liveQuoteStamp, liveStatusLabel, type LiveTransitionResponse } from "./LiveTransitionDetails";

type Selection = { code: string; name: string; market?: string };
type Filters = { pair: string; nearPercent: string; state: string; market: string };
const PAGE_SIZE = 30;
const fieldClass = "tb-focus mt-1 min-h-10 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900";
const initialFilters = (pair: string, state: string): Filters => ({ pair, nearPercent: "1", state: ["CROSS_OCCURRED", "APPROACHING", "ALREADY_ABOVE", "NONE"].includes(state) ? state : "candidates", market: "all" });

export default function LiveTransitionScreenerPanel({ onSelectStock, initialPair = "5-20", initialState = "all" }: { onSelectStock: (stock: Selection) => void | Promise<void>; initialPair?: string; initialState?: string }) {
  const { rootRef, refreshVersion } = useLiveTransitionRevalidation(true);
  const [filters, setFilters] = useState(() => initialFilters(initialPair, initialState));
  const [search, setSearch] = useState(() => ({ filters: initialFilters(initialPair, initialState), revision: 0 }));
  const [page, setPage] = useState(0);
  const submit = (next: Filters) => { setPage(0); setSearch((previous) => ({ filters: { ...next }, revision: previous.revision + 1 })); };
  return <section ref={rootRef} className="space-y-3" aria-labelledby="live-transition-heading">
    <div className="tb-card p-4 sm:p-5">
      <div className="flex flex-wrap items-center gap-2"><h2 id="live-transition-heading" className="text-xl font-semibold text-slate-950">전환 신호 · LIVE</h2><span className="rounded-full bg-orange-100 px-2 py-1 text-xs font-semibold text-orange-800">장중 잠정</span></div>
      <p className="mt-2 text-sm text-slate-700">TOP LIVE의 저장된 14:30 관측가로 골든크로스 진입과 근접 후보를 살펴봅니다.</p>
      <p className="mt-2 text-xs leading-relaxed text-amber-800">실시간 스트리밍이 아닙니다. 관측일과 종목별 실제 시세 시각을 확인하세요. 장중 신호는 이후 또는 종가에서 되돌아갈 수 있습니다.</p>
      <LiveTransitionRules nearPercent={Number(search.filters.nearPercent)} />
      <form className="mt-4 grid grid-cols-2 gap-3 xl:grid-cols-4" onSubmit={(event) => { event.preventDefault(); submit(filters); }}>
        <label className="text-xs font-medium text-slate-600">이평선 조합<select className={fieldClass} value={filters.pair} onChange={(event) => setFilters({ ...filters, pair: event.target.value })}><option value="5-20">5일 / 20일</option><option value="20-60">20일 / 60일</option></select></label>
        <label className="text-xs font-medium text-slate-600">신호 상태<select className={fieldClass} value={filters.state} onChange={(event) => setFilters({ ...filters, state: event.target.value })}><option value="candidates">진입 · 근접 후보</option><option value="all">전체 판정</option><option value="CROSS_OCCURRED">골든크로스 진입 · 잠정</option><option value="APPROACHING">근접 후보 · 잠정</option><option value="ALREADY_ABOVE">기존 상단 유지</option><option value="NONE">조건 미충족</option></select></label>
        <label className="text-xs font-medium text-slate-600">시장<select className={fieldClass} value={filters.market} onChange={(event) => setFilters({ ...filters, market: event.target.value })}><option value="all">전체</option><option>KOSPI</option><option>KOSDAQ</option></select></label>
        <label className="text-xs font-medium text-slate-600">근접 기준 · 필요 추가 상승률 (%)<input type="number" required min="0" max="5" step="any" inputMode="decimal" className={fieldClass} value={filters.nearPercent} onChange={(event) => setFilters({ ...filters, nearPercent: event.target.value })} /></label>
        <p className="col-span-2 text-xs text-slate-600 xl:col-span-4">기본 1%, 0~5% 설정 가능 · 가격 경계까지의 거리로 고르는 탐색 조건이며 검증된 확률이 아닙니다.</p>
        <div className="col-span-2 flex flex-wrap gap-2 xl:col-span-4"><button type="submit" className="tb-focus rounded-lg bg-[var(--tb-orange)] px-4 py-2.5 text-sm font-semibold text-white">LIVE 조건 검색</button><button type="button" className="tb-focus rounded-lg border border-slate-200 px-4 py-2.5 text-sm text-slate-700" onClick={() => { const next = initialFilters("5-20", "all"); setFilters(next); submit(next); }}>조건 초기화</button></div>
      </form>
    </div>
    <LiveTransitionResults key={`${search.revision}:${refreshVersion}`} filters={search.filters} page={page} onPageChange={setPage} onSelectStock={onSelectStock} />
  </section>;
}

export function LiveTransitionResults({ filters, page, onPageChange, onSelectStock }: { filters: Filters; page: number; onPageChange: (page: number) => void; onSelectStock: (stock: Selection) => void | Promise<void> }) {
  const [data, setData] = useState<LiveTransitionResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const query = new URLSearchParams({ tab: "transition", mode: "LIVE", ...filters }).toString();
  useEffect(() => {
    const abort = new AbortController();
    void fetch(`/api/screener?${query}`, { cache: "no-store", signal: abort.signal }).then(async (response) => {
      const body = await response.json();
      if (!response.ok) throw new Error(body?.error?.message ?? "LIVE 전환 신호를 불러오지 못했습니다.");
      if (body.mode !== "LIVE" || !Array.isArray(body.results) || body.results.some((row: LiveTransitionResponse["results"][number]) => row.pair !== filters.pair || row.referenceDate !== body.referenceDate || row.modelReferenceDate !== body.modelReferenceDate || row.qualityStatus !== "PROVISIONAL")) throw new Error("LIVE 응답의 관측일·모델 기준일·이평선 조합을 검증할 수 없습니다.");
      if (!abort.signal.aborted) setData(body);
    }).catch((caught: unknown) => { if (!abort.signal.aborted) setError(caught instanceof Error ? caught.message : "LIVE 전환 신호를 불러오지 못했습니다."); });
    return () => abort.abort();
  }, [query, filters.pair]);
  const pageCount = Math.max(1, Math.ceil((data?.results.length ?? 0) / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  useEffect(() => {
    if (data && page > pageCount - 1) onPageChange(pageCount - 1);
  }, [data, page, pageCount, onPageChange]);
  if (error) return <div role="alert" className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900"><p className="font-semibold">LIVE 조회 불가</p><p className="mt-1">{error}</p><p className="mt-2 text-xs">위의 EOD · 확정 일봉 비교를 선택해 별도로 확인할 수 있습니다.</p></div>;
  if (!data) return <p role="status" className="rounded-lg bg-white/90 p-4 text-sm text-slate-600">저장된 TOP LIVE 관측 스냅샷 조회 중입니다.</p>;
  const rows = data.results.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);
  return <div className="tb-card min-w-0 overflow-hidden p-4 sm:p-5" aria-label="LIVE 전환 검색 결과">
    <h3 className="font-semibold text-slate-950">검색 결과 {data.resultCount}종목 · {filters.pair.replace("-", "/")}일</h3>
    <LiveTransitionMetadata data={data} />
    <p className="mt-2 text-xs text-slate-600">데이터 부족 제외 {data.exclusions.dataMissing} · 조건 미충족 {data.exclusions.conditionNotMet} · 적용 근접 기준 {data.nearPercent}%</p>
    {!!Object.keys(data.reasonCounts ?? {}).length && <details className="mt-2 text-xs text-slate-600"><summary className="tb-focus w-fit cursor-pointer rounded">제외 사유별 집계</summary><ul className="mt-1 space-y-1">{Object.entries(data.reasonCounts).map(([reason, count]) => <li key={reason}>{reason}: {count}</li>)}</ul></details>}
    <p className="mt-2 text-xs leading-relaxed text-amber-800">경계가는 참고용 반올림 값입니다. 교차에는 원래 계산된 경계가를 초과하는 관측가가 필요합니다. 저장 모델 A~D는 직전 확정 일봉 점수입니다.</p>
    <div className="mt-4 hidden overflow-x-auto xl:block"><table className="min-w-[1120px] w-full text-left text-xs"><thead className="border-b border-slate-200 text-slate-600"><tr>{["종목 / 시장", "잠정 판정", "관측가 / 실제 시세 시각", "교차 경계가 초과", "필요 추가 상승률", "현재 / 직전 간격", "단기선 기울기", "저장 모델 A~D"].map((label) => <th key={label} className="px-2 py-2 font-medium">{label}</th>)}</tr></thead><tbody className="divide-y divide-slate-200/70">{rows.map((row) => <tr key={row.code}>
      <td className="px-2 py-3"><button type="button" onClick={() => void onSelectStock({ code: row.code, name: row.name, market: row.market })} className="tb-focus text-left font-semibold text-slate-950 hover:text-[var(--tb-orange)]">{row.name}</button><p className="mt-1 text-slate-600">{row.code} · {row.market}</p></td>
      <td className="px-2 py-3"><p className={row.status === "CROSS_OCCURRED" ? "font-semibold text-[var(--tb-orange)]" : "text-slate-700"}>{liveStatusLabel(row.status)}</p></td>
      <td className="px-2 py-3 tabular-nums"><p className="font-medium">{livePrice(row.observedPrice)}</p><p className="mt-1 text-slate-600">{liveQuoteStamp(row)}</p></td>
      <td className="px-2 py-3 tabular-nums">{row.crossRequiredPrice === null ? "미확인" : `약 ${livePrice(row.crossRequiredPrice, 4)} 초과`}</td>
      <td className="px-2 py-3 font-semibold tabular-nums">{liveNumber(row.requiredAdditionalRisePercent, "%")}</td>
      <td className="px-2 py-3 tabular-nums">{liveNumber(row.gapPercent, "%")}<p className="mt-1 text-slate-600">직전 {liveNumber(row.previousGapPercent, "%")}</p></td>
      <td className="px-2 py-3 tabular-nums">{liveNumber(row.shortSlopePercent, "%")}</td>
      <td className="px-2 py-3"><p className="text-slate-600">EOD {liveDate(row.modelReferenceDate)}</p><details className="mt-1"><summary className="tb-focus w-fit cursor-pointer rounded">점수 보기</summary><p className="mt-1">{["A", "B", "C", "D"].map((model) => `${model} ${liveNumber(row.models[`${model}-v1`]?.score)}`).join(" · ")}</p></details></td>
    </tr>)}</tbody></table></div>
    <div className="mt-4 grid gap-3 md:grid-cols-2 xl:hidden">{rows.map((row) => <article key={row.code} className="rounded-xl border border-slate-200 bg-[#faf7f1] p-3">
      <div className="flex flex-wrap items-start justify-between gap-2"><button type="button" aria-label={`${row.name} ${row.code} 상세 분석`} onClick={() => void onSelectStock({ code: row.code, name: row.name, market: row.market })} className="tb-focus rounded text-left"><span className="block text-sm font-semibold text-slate-950">{row.name}</span><span className="mt-1 block text-xs text-slate-600">{row.code} · {row.market}</span></button><p className="text-xs font-medium text-orange-800">{liveStatusLabel(row.status)}</p></div>
      <p className="mt-2 text-[11px] text-slate-600">실제 시세 {liveQuoteStamp(row)}</p>
      <LiveTransitionMetrics row={row} />
      <details className="mt-3 text-xs text-slate-700"><summary className="tb-focus w-fit cursor-pointer rounded">저장 모델 A~D · EOD {liveDate(row.modelReferenceDate)}</summary><p className="mt-1">{["A", "B", "C", "D"].map((model) => `${model} ${liveNumber(row.models[`${model}-v1`]?.score)}`).join(" · ")}</p></details>
    </article>)}</div>
    {!data.resultCount && <p className="py-6 text-center text-sm leading-relaxed text-slate-600">현재 조건에 해당하는 계산 가능 종목이 없습니다.<br />데이터 부족 {data.exclusions.dataMissing}종목과 조건 미충족 {data.exclusions.conditionNotMet}종목을 구분해 확인하세요.</p>}
    {data.resultCount > PAGE_SIZE && <div className="mt-4 flex items-center justify-center gap-3 text-xs"><button type="button" disabled={!currentPage} className="tb-focus rounded border border-slate-200 px-3 py-2 disabled:opacity-40" onClick={() => onPageChange(currentPage - 1)}>이전</button><span>{currentPage + 1} / {pageCount}</span><button type="button" disabled={currentPage + 1 >= pageCount} className="tb-focus rounded border border-slate-200 px-3 py-2 disabled:opacity-40" onClick={() => onPageChange(currentPage + 1)}>다음</button></div>}
  </div>;
}
