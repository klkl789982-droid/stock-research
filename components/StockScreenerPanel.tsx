"use client";

import { useEffect, useState } from "react";
import TransitionScreenerPanel from "./TransitionScreenerPanel";

type Selection = { code: string; name: string };
type Result = { code: string; name: string; market: string; referenceDate: string; score: number; rank: number; selectedModel: string; company: { available: boolean; score: number | null; grade: string | null; referenceDate: string | null } };
type Response = { referenceDate: string; companyReferenceDate: string | null; selectedModel: string; totalUniverse: number; modelCoverage: number; companyCoverage: number; quarantinedCount: number | null; resultCount: number; exclusions: { missingModel: number; missingCompany: number }; results: Result[] };

const MODEL_LABELS: Record<string, string> = { "A-v1": "A-v1 · 기술 강도", "B-v1": "B-v1 · 추세 지속", "C-v1": "C-v1 · 진입 강도", "D-v1": "D-v1 · 추세 + 진입" };
const initial = { model: "A-v1", minScore: "", maxScore: "", maxRank: "", companyGrade: "", sort: "rank", direction: "asc" };
const queryFor = (value: typeof initial) => {
  const params = new URLSearchParams({ model: value.model, sort: value.sort, direction: value.direction });
  for (const key of ["minScore", "maxScore", "maxRank", "companyGrade"] as const) if (value[key]) params.set(key, value[key]);
  return params.toString();
};

export default function StockScreenerPanel({ onSelectStock, initialTab = "models", initialPair = "5-20", initialState = "all" }: { onSelectStock: (stock: Selection) => void | Promise<void>; initialTab?: "models" | "transition"; initialPair?: string; initialState?: string }) {
  const [filters, setFilters] = useState(initial);
  const [data, setData] = useState<Response | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"models" | "transition">(initialTab);

  const run = async (next = filters) => {
    setLoading(true); setError(null);
    try {
      const response = await fetch(`/api/screener?${queryFor(next)}`, { cache: "no-store" });
      const body = await response.json();
      if (!response.ok) throw new Error(body?.error?.message ?? "스크리닝 결과를 불러오지 못했습니다.");
      setData(body);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "스크리닝 결과를 불러오지 못했습니다."); }
    finally { setLoading(false); }
  };
  useEffect(() => {
    let active = true;
    fetch(`/api/screener?${queryFor(initial)}`, { cache: "no-store" })
      .then(async (response) => ({ response, body: await response.json() }))
      .then(({ response, body }) => {
        if (!active) return;
        if (!response.ok) throw new Error(body?.error?.message ?? "스크리닝 결과를 불러오지 못했습니다.");
        setData(body); setLoading(false);
      })
      .catch((caught) => { if (active) { setError(caught instanceof Error ? caught.message : "스크리닝 결과를 불러오지 못했습니다."); setLoading(false); } });
    return () => { active = false; };
  }, []);

  const reset = () => { setFilters(initial); void run(initial); };
  const field = "tb-focus min-h-10 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900";
  return <section aria-label="스크리닝" className="space-y-3">
    <div role="tablist" aria-label="스크리닝 영역" className="tb-card flex gap-2 p-2">{([["models", "모델·기업 조건"], ["transition", "전환 신호"]] as const).map(([value, label]) => <button key={value} type="button" role="tab" aria-selected={tab === value} onClick={() => setTab(value)} className={`tb-focus rounded-lg px-4 py-2 text-sm font-semibold ${tab === value ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100"}`}>{label}</button>)}</div>
    {tab === "transition" ? <TransitionScreenerPanel onSelectStock={onSelectStock} initialPair={initialPair} initialState={initialState} /> : <>
    <div className="tb-card p-4 sm:p-6">
      <p className="text-xs font-bold uppercase tracking-[0.15em] text-[var(--tb-orange)]">Daily EOD screening</p>
      <h1 id="screener-heading" className="mt-1 text-2xl font-bold tracking-tight text-slate-950 sm:text-3xl">스크리닝</h1>
      <p className="mt-2 text-sm text-slate-600">확정된 공식 일봉 모델 순위와 기업분석 결과를 조건별로 비교합니다.</p>
      <form className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4" onSubmit={(event) => { event.preventDefault(); void run(); }}>
        <label className="text-xs font-semibold text-slate-600">모델<select value={filters.model} onChange={(event) => setFilters({ ...filters, model: event.target.value })} className={`${field} mt-1 w-full`}>{Object.entries(MODEL_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label className="text-xs font-semibold text-slate-600">최소 점수<input inputMode="decimal" value={filters.minScore} onChange={(event) => setFilters({ ...filters, minScore: event.target.value })} placeholder="예: 70" className={`${field} mt-1 w-full`} /></label>
        <label className="text-xs font-semibold text-slate-600">최대 점수<input inputMode="decimal" value={filters.maxScore} onChange={(event) => setFilters({ ...filters, maxScore: event.target.value })} placeholder="예: 100" className={`${field} mt-1 w-full`} /></label>
        <label className="text-xs font-semibold text-slate-600">TOP 순위<input inputMode="numeric" value={filters.maxRank} onChange={(event) => setFilters({ ...filters, maxRank: event.target.value })} placeholder="예: 50위 이내" className={`${field} mt-1 w-full`} /></label>
        <label className="text-xs font-semibold text-slate-600">기업분석 등급<select value={filters.companyGrade} onChange={(event) => setFilters({ ...filters, companyGrade: event.target.value })} className={`${field} mt-1 w-full`}><option value="">전체 (결측 포함)</option>{["관심 종목", "양호", "중립", "주의", "위험"].map((grade) => <option key={grade}>{grade}</option>)}</select></label>
        <label className="text-xs font-semibold text-slate-600">정렬<select value={`${filters.sort}:${filters.direction}`} onChange={(event) => { const [sort, direction] = event.target.value.split(":"); setFilters({ ...filters, sort, direction }); }} className={`${field} mt-1 w-full`}><option value="rank:asc">모델 순위 높은 순</option><option value="score:desc">모델 점수 높은 순</option><option value="companyScore:desc">기업점수 높은 순</option><option value="name:asc">종목명 순</option></select></label>
        <div className="flex items-end gap-2 sm:col-span-2"><button type="submit" disabled={loading} className="tb-focus min-h-10 rounded-lg bg-[var(--tb-orange)] px-5 text-sm font-bold text-white disabled:opacity-50">{loading ? "검색 중" : "조건 검색"}</button><button type="button" onClick={reset} className="tb-focus min-h-10 rounded-lg border border-slate-200 px-4 text-sm font-semibold text-slate-600">조건 초기화</button></div>
      </form>
    </div>
    {error && <p role="alert" className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">{error}</p>}
    {data && <div className="tb-card overflow-hidden">
      <div className="border-b border-slate-200 px-4 py-4 sm:px-6"><div className="flex flex-wrap items-end justify-between gap-2"><div><p className="text-sm font-bold text-slate-950">검색 결과 {data.resultCount.toLocaleString()}종목</p><p className="mt-1 text-xs text-slate-500">모델 기준일 {data.referenceDate} · {MODEL_LABELS[data.selectedModel]}</p></div><p className="text-xs text-slate-500">모델 데이터 {data.modelCoverage}/{data.totalUniverse} · 기업분석 {data.companyCoverage}/{data.totalUniverse}{data.companyReferenceDate ? ` (${data.companyReferenceDate})` : ""}</p></div>
        <p className="mt-2 text-[11px] text-slate-500">격리 종목 {data.quarantinedCount ?? "확인 불가"} · 선택 모델 결측 {data.exclusions.missingModel} · 기업등급 조건 결측 {data.exclusions.missingCompany}</p></div>
      <div className="overflow-x-auto"><table className="min-w-[720px] w-full text-left text-sm"><thead className="bg-slate-50 text-xs text-slate-500"><tr><th className="px-4 py-3">순위</th><th className="px-4 py-3">종목</th><th className="px-4 py-3 text-right">모델 점수</th><th className="px-4 py-3">기업분석</th><th className="px-4 py-3">기준일</th><th className="px-4 py-3"><span className="sr-only">종목 분석</span></th></tr></thead><tbody className="divide-y divide-slate-100">{data.results.map((row) => <tr key={row.code} className="hover:bg-slate-50"><td className="px-4 py-3 font-semibold text-slate-700">{row.rank}</td><td className="px-4 py-3"><p className="font-bold text-slate-950">{row.name}</p><p className="text-xs text-slate-500">{row.code} · {row.market}</p></td><td className="px-4 py-3 text-right font-bold tabular-nums">{row.score.toFixed(2)}</td><td className="px-4 py-3">{row.company.available ? <><span className="font-semibold">{row.company.grade}</span><span className="ml-2 text-xs text-slate-500">{row.company.score}</span></> : <span className="text-xs text-slate-400">분석 불가</span>}</td><td className="px-4 py-3 text-xs text-slate-500">{row.referenceDate}</td><td className="px-4 py-3 text-right"><button type="button" onClick={() => void onSelectStock({ code: row.code, name: row.name })} className="tb-focus rounded-lg border border-slate-200 px-3 py-2 text-xs font-bold text-[var(--tb-orange)]">종목 분석</button></td></tr>)}</tbody></table></div>
      {data.results.length === 0 && <p className="px-4 py-10 text-center text-sm text-slate-500">조건에 해당하는 계산 가능 종목이 없습니다.</p>}
    </div>}
    </>}
  </section>;
}
