"use client";
import { useEffect, useState } from "react";
import { transitionLabel } from "../lib/directional-transition.mjs";
type Transition = { code: string; referenceDate: string; status: string; crossDirection: string; pair: string; approachStrength: number | null; gapPercent: number; models: Record<string, { score: number | null; rank?: number | null }> };
type Result = { pair: string; referenceDate: string | null; rows: Transition[]; error: boolean; excluded: boolean };
export default function StockResearchPanel({ code }: { code: string }) {
  const [state, setState] = useState<{ code: string; results: Result[] } | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    void Promise.all(["5-20", "20-60"].map(async (pair): Promise<Result> => {
      try {
        const query = new URLSearchParams({ tab: "transition", rules: "directional-v2", code, pair });
        const response = await fetch(`/api/screener?${query}`, { cache: "no-store", signal: abort.signal });
        if (!response.ok) throw new Error("UNAVAILABLE");
        const body = await response.json();
        if (!Array.isArray(body.results) || body.results.some((r: Transition) => r.code !== code || r.referenceDate !== body.referenceDate)) throw new Error("MISMATCH");
        return { pair, referenceDate: body.referenceDate, rows: body.results, excluded: body.exclusions.dataMissing > 0, error: false };
      } catch { return { pair, referenceDate: null, rows: [], error: true, excluded: false }; }
    })).then((results) => { if (!abort.signal.aborted) setState({ code, results }); });
    return () => abort.abort();
  }, [code]);
  const results = state?.code === code ? state.results : null, sample = results?.flatMap((r) => r.rows)[0];
  return <section className="mt-3 grid gap-3 md:grid-cols-2" aria-label="전환 신호와 저장 모델 점수">
    <div className="rounded-xl border border-slate-200 bg-[#f7f3eb] p-3"><h3 className="text-sm font-semibold">전환 신호 · 연구용</h3>{results ? results.map((r) => <div key={r.pair} className="mt-2 text-xs"><p className="font-medium">{r.pair.replace("-", "/")}일 · {r.referenceDate ?? "기준일 미확인"}</p>{r.rows.map((row) => <p key={row.crossDirection} className="mt-1 text-slate-700">{transitionLabel(row.crossDirection, row.status)} · 간격 {row.gapPercent.toFixed(2)}%{row.status === "APPROACHING" ? ` · 강도 ${row.approachStrength?.toFixed(2) ?? "미확인"}` : ""}</p>)}{!r.rows.length && <p className="mt-1 text-slate-600">{r.error ? "조회 실패 / 검증 불가" : r.excluded ? "분석 대상 제외 · 이력/품질 입력 부족" : "신호 판정 자료 없음"}</p>}</div>) : <p className="mt-2 text-xs text-slate-600">확정 일봉 지표 조회 중</p>}<p className="mt-2 text-[10px] text-slate-600">v2 방향 분리 · 강도는 교차 확률이 아님 · KIS 잠정/LIVE 미혼합</p></div>
    <div className="rounded-xl border border-slate-200 bg-[#f7f3eb] p-3"><h3 className="text-sm font-semibold">저장 모델 A~D · Daily EOD</h3><p className="mt-1 text-xs text-slate-600">{sample?.referenceDate ?? "기준일 미확인"} · 새 점수 계산 없음</p><dl className="mt-2 grid grid-cols-4 gap-2">{["A", "B", "C", "D"].map((m) => <div key={m}><dt className="text-xs text-slate-600">{m}-v1</dt><dd className="mt-1 text-sm font-semibold tabular-nums">{sample?.models[`${m}-v1`]?.score?.toFixed(2) ?? "미확인"}</dd></div>)}</dl><p className="mt-2 text-[10px] text-slate-600">분석 가능 입력이 부족하면 점수를 정상값으로 표시하지 않습니다.</p></div>
  </section>;
}
