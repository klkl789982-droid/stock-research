"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Selection = { code: string; name: string };
type Filters = { pair: string; state: string; market: string; macd: string; rsiMin: string; rsiMax: string; volumeMin: string; volumeMax: string; changeMin: string; changeMax: string; scoreA: string; scoreB: string; scoreC: string; scoreD: string; model: string; sort: string; direction: string };
type Row = { code: string; name: string; market: string; referenceDate: string; status: string; pair: string; gapPercent: number; shortSlopePercent: number | null; previousShortSlopePercent: number | null; crossDate: string | null; aboveTradingDays: number; aboveDaysLowerBound: boolean; qualityStatus: string; score: number | null; models: Record<string, { score: number | null }>; indicators: { rsi: number | null; macdState: string | null; volumeMultiple: number | null; dailyChangePercent: number | null } };
type Response = { referenceDate: string; ruleVersion: string; totalUniverse: number; indicatorCoverage: number; quarantinedCount: number | null; sourceQualityGrade: string; isPartialRanking: boolean; resultCount: number; results: Row[]; exclusions: { dataMissing: number; filterMissing: number; conditionNotMet: number }; supportedFilters: { rsi: boolean; macd: boolean; volume: boolean; change: boolean; models: Record<string, boolean> } };
const INITIAL: Filters = { pair: "5-20", state: "all", market: "all", macd: "all", rsiMin: "", rsiMax: "", volumeMin: "", volumeMax: "", changeMin: "", changeMax: "", scoreA: "", scoreB: "", scoreC: "", scoreD: "", model: "A-v1", sort: "state", direction: "asc" };
const queryFor = (filters: Filters) => {
  const params = new URLSearchParams({ tab: "transition" });
  for (const [key, value] of Object.entries(filters)) if (value) params.set(key, value);
  return params.toString();
};
const format = (value: number | null, suffix = "") => value === null ? "미확인" : `${value.toFixed(2)}${suffix}`;
const statusLabel = (row: Row) => ({ CROSS_OCCURRED: "교차 발생", APPROACHING: "접근 중 · 연구용", CONFIRMED: "교차 후 확인 · 연구용", NONE: "신호 없음" }[row.status] ?? "미확인");
const macdLabel = (value: string | null) => ({ rising: "상승 (MACD > Signal)", falling: "하락 (MACD < Signal)", neutral: "동일" }[value ?? ""] ?? "미확인");
const fieldClass = "tb-focus mt-1 min-h-10 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 disabled:bg-slate-100 disabled:text-slate-400";
const PAGE_SIZE = 30;

export default function TransitionScreenerPanel({ onSelectStock, initialPair = "5-20", initialState = "all" }: { onSelectStock: (stock: Selection) => void | Promise<void>; initialPair?: string; initialState?: string }) {
  const [filters, setFilters] = useState({ ...INITIAL, pair: initialPair, state: initialState });
  const [data, setData] = useState<Response | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const controller = useRef<AbortController | null>(null);
  const sequence = useRef(0);
  const run = useCallback((next: Filters) => {
    controller.current?.abort();
    const abort = new AbortController(); controller.current = abort;
    const request = ++sequence.current;
    return fetch(`/api/screener?${queryFor(next)}`, { cache: "no-store", signal: abort.signal })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body?.error?.message ?? "전환 신호 조회 실패");
        return body;
      })
      .then((body) => { if (request === sequence.current && !abort.signal.aborted) setData(body); })
      .catch((caught: unknown) => { if (request === sequence.current && !abort.signal.aborted) setError(caught instanceof Error ? caught.message : "전환 신호를 불러오지 못했습니다."); })
      .finally(() => { if (request === sequence.current && !abort.signal.aborted) setLoading(false); });
  }, []);
  useEffect(() => { void run({ ...INITIAL, pair: initialPair, state: initialState }); return () => { sequence.current += 1; controller.current?.abort(); }; }, [run, initialPair, initialState]);
  const search = (next: Filters) => { setLoading(true); setError(null); setData(null); setPage(0); void run(next); };
  const numeric = (key: keyof Filters, label: string, enabled = true) => <label className="text-xs font-medium text-slate-600">{label}<input aria-label={label} inputMode="decimal" value={filters[key]} disabled={!enabled} onChange={(e) => setFilters({ ...filters, [key]: e.target.value })} className={fieldClass} placeholder={enabled ? "조건 없음" : "데이터 없음"} /></label>;
  const visibleRows = data?.results.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE) ?? [];
  const modelScores = (row: Row) => ["A", "B", "C", "D"].map((letter) => `${letter} ${format(row.models[`${letter}-v1`]?.score ?? null)}`).join(" · ");
  const changeTone = (value: number | null) => value !== null && value > 0 ? "text-red-600" : value !== null && value < 0 ? "text-blue-600" : "text-slate-700";
  return <section className="space-y-3" aria-labelledby="transition-heading">
    <div className="tb-card p-4 sm:p-5">
      <h2 id="transition-heading" className="text-xl font-semibold text-slate-950">전환 신호 · 확정 일봉</h2>
      <p className="mt-1 text-sm text-slate-600">확정 일봉으로 접근·실제 교차·교차 후 유지를 구분합니다. 매수 추천·상승 확률이 아닙니다.</p>
      <p className="mt-2 text-xs leading-relaxed text-amber-800">접근 중·교차 후 확인은 transition-research-v1 초기 연구 규칙입니다. 검증된 매수 신호가 아니며 A~D 점수·순위와 독립입니다.</p>
      <details className="mt-2 text-xs text-slate-600"><summary className="tb-focus cursor-pointer rounded">연구 규칙과 해석 주의점</summary><p className="mt-2 leading-relaxed">접근: 최근 3개 확정 거래일 모두 단기선이 장기선 아래, 절대 상대 간격 |단기선/장기선−1|이 2회 연속 축소, 단기선의 최근 변화율이 양수이고 이전 변화율보다 큼. 교차: 전일 단기선 ≤ 장기선, 당일 단기선 &gt; 장기선. 확인: 관측된 실제 교차일부터 당일까지 3거래일 이상 연속 단기선 &gt; 장기선 (교차일 포함). 재교차·동일선은 유지 기간을 끊습니다. 관측 범위 이전 교차는 추정하지 않습니다. 3일은 잡음을 줄이기 위한 초기값이며 장기 유지·성공 확률을 보증하지 않습니다. 접근은 간격이 클 때도 나올 수 있고 확인은 늦게 포착되거나 횡보장에서 반복 발생할 수 있습니다.</p></details>
      <details className="mt-3 text-xs text-slate-600"><summary className="tb-focus cursor-pointer rounded">지표·데이터 기준 자세히 보기</summary><p className="mt-2 leading-relaxed">RSI14·MACD는 기존 market-analysis-v1 계산기를 재사용합니다. MACD 상태는 MACD와 Signal의 대소 관계이며 MACD 값 자체의 전일 변화 방향이 아닙니다. 거래량 배율은 당일을 포함한 최근 20개 공식 일봉 평균 대비 배율입니다. 모델 점수는 동일 기준일의 저장 A-v1/B-v1/C-v1/D-v1 결과이며 재계산하지 않습니다. 신규 상장·격리·정지·기준일 불일치·일봉 누락은 제외합니다. 조정주가·기업행위·완전한 과거 거래일 마스터 인증은 기존 데이터의 한계를 그대로 갖습니다.</p></details>
      <form onSubmit={(e) => { e.preventDefault(); search(filters); }} className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <label className="text-xs font-medium text-slate-600">이평선 조합<select className={fieldClass} value={filters.pair} onChange={(e) => setFilters({ ...filters, pair: e.target.value })}><option value="5-20">5일 / 20일</option><option value="20-60">20일 / 60일</option></select></label>
        <label className="text-xs font-medium text-slate-600">신호 상태<select className={fieldClass} value={filters.state} onChange={(e) => setFilters({ ...filters, state: e.target.value })}><option value="all">전체</option><option value="APPROACHING">접근 중 · 연구용</option><option value="CROSS_OCCURRED">교차 발생</option><option value="CONFIRMED">교차 후 확인 · 연구용</option><option value="NONE">신호 없음</option></select></label>
        <label className="text-xs font-medium text-slate-600">시장<select className={fieldClass} value={filters.market} onChange={(e) => setFilters({ ...filters, market: e.target.value })}><option value="all">전체</option><option>KOSPI</option><option>KOSDAQ</option></select></label>
        <label className="text-xs font-medium text-slate-600">MACD 상태<select className={fieldClass} value={filters.macd} disabled={data?.supportedFilters.macd !== true} onChange={(e) => setFilters({ ...filters, macd: e.target.value })}><option value="all">전체</option><option value="rising">상승 · MACD &gt; Signal</option><option value="falling">하락 · MACD &lt; Signal</option><option value="neutral">동일</option></select></label>
        {numeric("rsiMin", "RSI 최소", data?.supportedFilters.rsi === true)}{numeric("rsiMax", "RSI 최대", data?.supportedFilters.rsi === true)}
        {numeric("volumeMin", "거래량 최소 배율", data?.supportedFilters.volume === true)}{numeric("volumeMax", "거래량 최대 배율", data?.supportedFilters.volume === true)}
        {numeric("changeMin", "전일 대비 최소 등락률 (%)", data?.supportedFilters.change === true)}{numeric("changeMax", "전일 대비 최대 등락률 (%)", data?.supportedFilters.change === true)}
        {(["A", "B", "C", "D"] as const).map((letter) => <div key={letter}>{numeric(`score${letter}`, `모델 ${letter} 최소 점수`, data?.supportedFilters.models[`${letter}-v1`] === true)}</div>)}
        <label className="text-xs font-medium text-slate-600">정렬 기준 모델<select className={fieldClass} value={filters.model} onChange={(e) => setFilters({ ...filters, model: e.target.value })}>{["A", "B", "C", "D"].map((m) => <option key={m} value={`${m}-v1`}>모델 {m}</option>)}</select></label>
        <label className="text-xs font-medium text-slate-600">정렬<select className={fieldClass} value={`${filters.sort}:${filters.direction}`} onChange={(e) => { const [sort, direction] = e.target.value.split(":"); setFilters({ ...filters, sort, direction }); }}><option value="state:asc">교차 발생 우선</option><option value="gap:asc">절대 이평선 간격 작은 순</option><option value="volume:desc">거래량 배율 높은 순</option><option value="score:desc">선택 모델 점수 높은 순</option><option value="name:asc">종목명 순</option></select></label>
        <div className="flex flex-wrap gap-2 sm:col-span-2 xl:col-span-4"><button type="submit" className="tb-focus rounded-lg bg-[var(--tb-orange)] px-4 py-2.5 text-sm font-semibold text-white">{loading ? "조회 중 · 다시 검색 가능" : "AND 조건 검색"}</button><button type="button" className="tb-focus rounded-lg border border-slate-200 px-4 py-2.5 text-sm text-slate-700" onClick={() => { setFilters(INITIAL); search(INITIAL); }}>조건 초기화</button></div>
      </form>
    </div>
    {error && <p role="alert" className="rounded-lg bg-amber-50 p-4 text-sm text-amber-800">{error}</p>}
    {loading && <p role="status" className="text-sm text-slate-200">저장된 확정 일봉 조회 중입니다.</p>}
    {data && <div className="tb-card min-w-0 overflow-hidden p-4 sm:p-5">
      <h3 className="font-semibold text-slate-950">검색 결과 {data.resultCount}종목</h3>
      <p className="mt-1 text-xs text-slate-600">기준일 {data.referenceDate} · 일봉 지표 {data.indicatorCoverage}/{data.totalUniverse} · 격리 {data.quarantinedCount ?? "미확인"}</p>
      <p className="mt-1 text-xs text-slate-600">데이터 부족 제외 {data.exclusions.dataMissing} · 필터 입력 결측 제외 {data.exclusions.filterMissing} · 조건 미충족 {data.exclusions.conditionNotMet} (중복 없는 종목 수)</p>
      <p className="mt-1 text-xs text-amber-800">원천 전체 품질 {data.sourceQualityGrade} · {data.isPartialRanking ? "부분 ranking" : "저장 ranking"} · 본 결과는 개별 입력 검증 통과 종목만 포함합니다.</p>
      <details className="mt-2 text-xs text-slate-600"><summary className="tb-focus cursor-pointer">재현·향후 성과 검증 기준</summary><p className="mt-1">규칙 {data.ruleVersion} · 공식 종가 기준 · 동일 입력은 동일 결과입니다. 별도 transition-signals / transition-outcomes 계약을 준비했으며 조회 시 파일을 생성하지 않습니다. 진입가격 계약과 자동 신호 저장은 아직 미승인이고 미래 성과는 생성하지 않습니다.</p></details>
      <div className="mt-3 hidden overflow-x-auto md:block"><table className="w-full min-w-[1100px] text-left text-xs"><thead className="border-b border-slate-200 text-slate-600"><tr>{["종목 / 시장", "신호 / 조합", "간격", "RSI", "MACD", "거래량", "등락률", "모델 점수", "기준일 / 품질"].map((title) => <th key={title} className="px-2 py-2 font-medium">{title}</th>)}</tr></thead><tbody className="divide-y divide-slate-200/70">{visibleRows.map((row) => <tr key={row.code}><td className="px-2 py-3"><button type="button" onClick={() => void onSelectStock({ code: row.code, name: row.name })} className="tb-focus text-left font-semibold text-slate-950 hover:text-[var(--tb-orange)]">{row.name}</button><p className="mt-1 text-slate-600">{row.code} · {row.market}</p></td><td className="px-2 py-3"><p className={row.status === "CROSS_OCCURRED" ? "font-semibold text-[var(--tb-orange)]" : "text-slate-700"}>{statusLabel(row)} · {row.pair}</p><p className="mt-1 text-slate-600">위 유지 {row.aboveDaysLowerBound ? "≥" : ""}{row.aboveTradingDays}일{row.crossDate ? ` · 교차 ${row.crossDate}` : ""}</p></td><td className="px-2 py-3 tabular-nums">{format(row.gapPercent, "%")}{row.status === "APPROACHING" && <p className="mt-1 text-[10px] text-slate-600">기울기 {format(row.shortSlopePercent, "%")}<br />직전 {format(row.previousShortSlopePercent, "%")}</p>}</td><td className="px-2 py-3 tabular-nums">{format(row.indicators.rsi)}</td><td className="px-2 py-3">{macdLabel(row.indicators.macdState)}</td><td className="px-2 py-3 tabular-nums">{format(row.indicators.volumeMultiple, "x")}</td><td className={`px-2 py-3 tabular-nums ${changeTone(row.indicators.dailyChangePercent)}`}>{format(row.indicators.dailyChangePercent, "%")}</td><td className="px-2 py-3"><p>{format(row.score)}</p><details><summary className="tb-focus mt-1 cursor-pointer text-slate-600">A~D</summary>{modelScores(row)}</details></td><td className="px-2 py-3 text-slate-600">{row.referenceDate}<p className="mt-1">개별 입력 검증</p></td></tr>)}</tbody></table></div>
      <div className="mt-3 space-y-2 md:hidden">{visibleRows.map((row) => <article key={row.code} className="rounded-lg border border-slate-200 bg-[rgba(250,247,241,0.96)] p-3 text-xs"><div className="flex items-start justify-between gap-2"><button type="button" onClick={() => void onSelectStock({ code: row.code, name: row.name })} className="tb-focus min-w-0 text-left"><p className="break-words text-sm font-semibold text-slate-950">{row.name}</p><p className="mt-1 text-slate-600">{row.code} · {row.market}</p></button><span className="shrink-0 text-[var(--tb-orange)]">{statusLabel(row)}<br />{row.pair}</span></div><div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-slate-700"><p>간격 {format(row.gapPercent, "%")}</p><p>RSI {format(row.indicators.rsi)}</p><p>거래량 {format(row.indicators.volumeMultiple, "x")}</p><p className={changeTone(row.indicators.dailyChangePercent)}>등락 {format(row.indicators.dailyChangePercent, "%")}</p><p className="col-span-2">MACD {macdLabel(row.indicators.macdState)}</p><p className="col-span-2">{modelScores(row)}</p>{row.status === "APPROACHING" && <p className="col-span-2">단기선 기울기 {format(row.shortSlopePercent, "%")} · 직전 {format(row.previousShortSlopePercent, "%")}</p>}<p className="col-span-2">위 유지 {row.aboveDaysLowerBound ? "≥" : ""}{row.aboveTradingDays}거래일 · 관측 교차 {row.crossDate ?? "미확인"}</p><p className="col-span-2 text-slate-600">{row.referenceDate} · 개별 입력 검증</p></div></article>)}</div>
      {!data.resultCount && <p className="py-6 text-center text-sm text-slate-600">조건에 해당하는 검증 가능 종목이 없습니다.</p>}
      {data.resultCount > PAGE_SIZE && <div className="mt-3 flex items-center justify-center gap-3 text-xs"><button type="button" disabled={!page} className="tb-focus rounded border border-slate-200 px-3 py-2 disabled:opacity-40" onClick={() => setPage(page - 1)}>이전</button><span>{page + 1} / {Math.ceil(data.resultCount / PAGE_SIZE)}</span><button type="button" disabled={(page + 1) * PAGE_SIZE >= data.resultCount} className="tb-focus rounded border border-slate-200 px-3 py-2 disabled:opacity-40" onClick={() => setPage(page + 1)}>다음</button></div>}
    </div>}
  </section>;
}
