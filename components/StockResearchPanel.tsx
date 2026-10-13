"use client";

import { useEffect, useState } from "react";
import { useLiveTransitionRevalidation } from "./useLiveTransitionRevalidation";
import { transitionLabel } from "../lib/directional-transition.mjs";
import { LiveTransitionMetrics, LiveTransitionRules, TransitionModeSelector, liveDate, liveNumber, liveQuoteStamp, liveStatusLabel, liveTime, type LiveTransitionRow, type TransitionMode } from "./LiveTransitionDetails";

type Transition = { code: string; referenceDate: string; modelReferenceDate?: string; status: string; crossDirection: string; pair: string; approachStrength: number | null; gapPercent: number; models: Record<string, { score: number | null; rank?: number | null }> };
type Result = { pair: string; referenceDate: string | null; modelReferenceDate: string | null; snapshotTime: string | null; rows: (Transition | LiveTransitionRow)[]; error: string | null; excluded: boolean };

export default function StockResearchPanel({ code }: { code: string }) {
  const [mode, setMode] = useState<TransitionMode>("LIVE");
  const { rootRef, refreshVersion } = useLiveTransitionRevalidation(mode === "LIVE");
  const [nearDraft, setNearDraft] = useState("1");
  const [nearPercent, setNearPercent] = useState("1");
  return <section ref={rootRef} className="mt-3 space-y-3" aria-label="전환 신호와 저장 모델 점수">
    <TransitionModeSelector mode={mode} onChange={setMode} label="종목 전환 신호 데이터 기준" />
    {mode === "LIVE" && <form className="flex flex-wrap items-end gap-2 text-xs" onSubmit={(event) => { event.preventDefault(); setNearPercent(nearDraft); }}><label className="text-slate-600">근접 기준 · 필요 추가 상승률 (0~5%)<input type="number" min="0" max="5" step="any" required inputMode="decimal" value={nearDraft} onChange={(event) => setNearDraft(event.target.value)} className="tb-focus ml-2 min-h-9 w-20 rounded-lg border border-slate-200 bg-white px-2 text-slate-900" /></label><button type="submit" className="tb-focus min-h-9 rounded-lg border border-slate-300 bg-white px-3 text-slate-700">적용</button></form>}
    <StockResearchResults key={`${code}:${mode}:${nearPercent}:${mode === "LIVE" ? refreshVersion : 0}`} code={code} mode={mode} nearPercent={nearPercent} />
  </section>;
}

export function StockResearchResults({ code, mode, nearPercent }: { code: string; mode: TransitionMode; nearPercent: string }) {
  const [state, setState] = useState<{ code: string; mode: TransitionMode; results: Result[] } | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    void Promise.all(["5-20", "20-60"].map(async (pair): Promise<Result> => {
      try {
        const query = new URLSearchParams({ tab: "transition", mode, code, pair, state: "all" });
        if (mode === "LIVE") query.set("nearPercent", nearPercent);
        else query.set("rules", "directional-v2");
        const response = await fetch(`/api/screener?${query}`, { cache: "no-store", signal: abort.signal });
        const body = await response.json();
        if (!response.ok) throw new Error(body?.error?.message ?? "전환 신호를 불러오지 못했습니다.");
        if (!Array.isArray(body.results) || body.results.some((row: Transition | LiveTransitionRow) => row.code !== code || row.referenceDate !== body.referenceDate || row.pair !== pair)) throw new Error("종목·기준일·이평선 조합이 일치하지 않아 표시할 수 없습니다.");
        if (mode === "LIVE" && (body.mode !== "LIVE" || !body.modelReferenceDate || body.results.some((row: LiveTransitionRow) => row.modelReferenceDate !== body.modelReferenceDate || row.qualityStatus !== "PROVISIONAL"))) throw new Error("LIVE 관측값과 저장 모델 기준일을 검증할 수 없습니다.");
        return { pair, referenceDate: body.referenceDate, modelReferenceDate: mode === "LIVE" ? body.modelReferenceDate : body.referenceDate, snapshotTime: body.snapshotTime ?? null, rows: body.results, excluded: body.exclusions.dataMissing > 0, error: null };
      } catch (caught: unknown) { return { pair, referenceDate: null, modelReferenceDate: null, snapshotTime: null, rows: [], error: caught instanceof Error ? caught.message : "전환 신호를 불러오지 못했습니다.", excluded: false }; }
    })).then((results) => { if (!abort.signal.aborted) setState({ code, mode, results }); });
    return () => abort.abort();
  }, [code, mode, nearPercent]);
  const results = state?.code === code && state.mode === mode ? state.results : null;
  const sample = results?.flatMap((result) => result.rows)[0];
  const modelReferenceDate = mode === "LIVE" ? sample?.modelReferenceDate ?? results?.find((result) => result.modelReferenceDate)?.modelReferenceDate : sample?.referenceDate ?? results?.find((result) => result.referenceDate)?.referenceDate;
  return <div className="grid gap-3 md:grid-cols-2">
    <div className="rounded-xl border border-slate-200 bg-[#f7f3eb] p-3">
      <h3 className="text-sm font-semibold">전환 신호 · {mode === "LIVE" ? "LIVE 장중 잠정" : "EOD 확정 일봉"}</h3>
      {mode === "LIVE" && <p className="mt-2 text-xs leading-relaxed text-amber-800">저장된 TOP LIVE 14:30 관측이며 실시간 스트리밍이 아닙니다. 이후 장중 또는 종가에서 신호가 되돌아갈 수 있습니다.</p>}
      {results ? results.map((result) => <div key={result.pair} className="mt-3 border-t border-slate-200 pt-3 text-xs">
        <p className="font-semibold text-slate-900">{result.pair.replace("-", "/")}일 · {result.referenceDate ? liveDate(result.referenceDate) : "기준일 미확인"}{mode === "LIVE" && result.snapshotTime ? ` · ${liveTime(result.snapshotTime)} KST 저장` : ""}</p>
        {result.rows.map((row) => mode === "LIVE" ? <div key={row.pair}><p className="mt-2 font-semibold text-orange-800">{liveStatusLabel((row as LiveTransitionRow).status)}</p><p className="mt-1 text-[11px] text-slate-600">실제 시세 {liveQuoteStamp(row as LiveTransitionRow)}</p><LiveTransitionMetrics row={row as LiveTransitionRow} /></div> : <p key={(row as Transition).crossDirection} className="mt-1 text-slate-700">{transitionLabel((row as Transition).crossDirection, row.status)} · 간격 {liveNumber(row.gapPercent, "%")}{row.status === "APPROACHING" ? ` · 강도 ${liveNumber((row as Transition).approachStrength)}` : ""}</p>)}
        {!result.rows.length && <p role={result.error ? "alert" : undefined} className={`mt-2 leading-relaxed ${result.error ? "text-amber-800" : "text-slate-600"}`}>{result.error ?? (result.excluded ? "분석 대상 제외 · 이력/품질 입력 부족" : "신호 판정 자료 없음")}</p>}
      </div>) : <p role="status" className="mt-3 text-xs text-slate-600">{mode === "LIVE" ? "저장된 LIVE 관측값" : "확정 일봉 지표"} 조회 중</p>}
      {mode === "LIVE" ? <LiveTransitionRules nearPercent={Number(nearPercent)} /> : <p className="mt-3 text-[10px] text-slate-600">v2 방향 분리 · 접근 강도는 교차 확률이 아님 · 확정 일봉 기준</p>}
    </div>
    <div className="self-start rounded-xl border border-slate-200 bg-[#f7f3eb] p-3">
      <h3 className="text-sm font-semibold">저장 모델 A~D · Daily EOD</h3>
      <p className="mt-1 text-xs text-slate-600">모델 기준일 {modelReferenceDate ? liveDate(modelReferenceDate) : "미확인"} · 새 점수 계산 없음</p>
      {mode === "LIVE" && <p className="mt-2 text-xs leading-relaxed text-amber-800">LIVE 관측일 이전의 확정 EOD 저장 점수입니다. 장중 관측가로 다시 계산하지 않습니다.</p>}
      <dl className="mt-3 grid grid-cols-4 gap-2">{["A", "B", "C", "D"].map((model) => <div key={model}><dt className="text-xs text-slate-600">{model}-v1</dt><dd className="mt-1 text-sm font-semibold tabular-nums">{liveNumber(sample?.models[`${model}-v1`]?.score)}</dd></div>)}</dl>
      <p className="mt-3 text-[10px] leading-relaxed text-slate-600">분석 가능 입력이 부족하면 점수를 정상값으로 표시하지 않습니다.</p>
    </div>
  </div>;
}
