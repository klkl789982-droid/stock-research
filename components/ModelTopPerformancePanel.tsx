"use client";

import { useEffect, useState } from "react";

type Group = {
  topN: number;
  evaluatedSignalDates: number;
  observationCount: number;
  meanReturn: number | null;
  medianReturn: number | null;
  positiveRate: number | null;
  compoundReturn: number | null;
  bestSignalDate: string | null;
  worstSignalDate: string | null;
};
type Daily = {
  modelVersion: string;
  signalDate: string;
  targetTradingDate: string;
  topN: number;
  observationCount: number;
  meanReturn: number;
  medianReturn: number;
  positiveRate: number;
  universeMeanReturn: number | null;
  excessReturn: number | null;
};
type Response = { matureSignalDates: string[]; summary: { modelVersion: string; groups: Group[] }[]; daily: Daily[] };

const labels: Record<string, string> = {
  "A-v1": "A-v1 · 기술 강도",
  "A-v2": "A-v2 · 기술 강도",
  "B-v1": "B-v1 · 추세 지속",
  "C-v1": "C-v1 · 진입 강도",
  "D-v1": "D-v1 · 추세 + 진입",
};
const format = (value: number | null) => value == null ? "—" : `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;

export default function ModelTopPerformancePanel() {
  const [data, setData] = useState<Response | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/model-performance", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("unavailable");
        return response.json() as Promise<Response>;
      })
      .then((result) => setData(result))
      .catch((requestError: unknown) => {
        if (requestError instanceof Error && requestError.name === "AbortError") return;
        setError(true);
      });
    return () => controller.abort();
  }, []);

  if (error || !data || data.matureSignalDates.length === 0) return null;

  return (
    <section className="tb-card mt-6 p-4 sm:p-6" aria-labelledby="model-performance-heading">
      <p className="text-xs font-bold uppercase tracking-[0.15em] text-[var(--tb-orange)]">Historical model outcomes</p>
      <h2 id="model-performance-heading" className="mt-1 text-xl font-extrabold tracking-tight text-slate-950 sm:text-2xl">모델 과거 성과</h2>
      <p className="mt-2 text-sm text-slate-600">다음 거래일 공식 종가 기준 · 평가 완료 {data.matureSignalDates.length}거래일 · 초기 관찰 단계</p>
      <div className="mt-4 overflow-x-auto rounded-xl border border-[var(--tb-border)]">
        <table className="min-w-[720px] w-full border-collapse text-sm">
          <thead className="bg-slate-50 text-left text-xs text-slate-500"><tr><th className="px-4 py-3 font-medium">모델</th><th className="px-4 py-3 text-right font-medium">평가일수</th><th className="px-4 py-3 text-right font-medium">TOP5 평균</th><th className="px-4 py-3 text-right font-medium">TOP10 평균</th><th className="px-4 py-3 text-right font-medium">TOP20 평균</th><th className="px-4 py-3 text-right font-medium">TOP20 상승비율</th></tr></thead>
          <tbody className="divide-y divide-slate-200/80">
            {data.summary.map((model) => {
              const top5 = model.groups.find((group) => group.topN === 5);
              const top10 = model.groups.find((group) => group.topN === 10);
              const top20 = model.groups.find((group) => group.topN === 20);
              return <tr key={model.modelVersion}><td className="px-4 py-3 font-semibold text-slate-900">{labels[model.modelVersion] ?? model.modelVersion}</td><td className="px-4 py-3 text-right tabular-nums text-slate-700">{top20?.evaluatedSignalDates ?? 0}</td><td className="px-4 py-3 text-right tabular-nums text-slate-700">{format(top5?.meanReturn ?? null)}</td><td className="px-4 py-3 text-right tabular-nums text-slate-700">{format(top10?.meanReturn ?? null)}</td><td className="px-4 py-3 text-right tabular-nums text-slate-700">{format(top20?.meanReturn ?? null)}</td><td className="px-4 py-3 text-right tabular-nums text-slate-700">{top20?.positiveRate == null ? "—" : `${top20.positiveRate.toFixed(1)}%`}</td></tr>;
            })}
          </tbody>
        </table>
      </div>
      <details className="mt-4 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
        <summary className="cursor-pointer text-sm font-medium text-slate-700">날짜별 결과 보기</summary>
        <div className="mt-3 overflow-x-auto"><table className="min-w-[780px] w-full text-xs text-slate-700"><thead><tr className="border-b border-slate-200 text-left text-slate-500"><th className="pb-2">모델</th><th className="pb-2">신호일</th><th className="pb-2">결과일</th><th className="pb-2 text-right">TOP</th><th className="pb-2 text-right">평균</th><th className="pb-2 text-right">Universe 평균</th><th className="pb-2 text-right">초과성과</th><th className="pb-2 text-right">N</th></tr></thead><tbody>{data.daily.map((row) => <tr key={`${row.modelVersion}-${row.signalDate}-${row.topN}`} className="border-b border-slate-200/70"><td className="py-2">{row.modelVersion}</td><td>{row.signalDate}</td><td>{row.targetTradingDate}</td><td className="text-right">{row.topN}</td><td className="text-right">{format(row.meanReturn)}</td><td className="text-right">{format(row.universeMeanReturn)}</td><td className="text-right">{format(row.excessReturn)}</td><td className="text-right">{row.observationCount}</td></tr>)}</tbody></table></div>
      </details>
    </section>
  );
}
