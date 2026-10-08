"use client";

import { useEffect, useMemo, useState } from "react";

type Horizon = "1DAY" | "5DAY" | "20DAY" | "60DAY";
type ExtremeObservation = {
  ticker: string;
  companyName: string | null;
  signalDate: string;
  signalTime: string | null;
  entryDate: string | null;
  entryPriceBasis: string | null;
  evaluationEndDate: string | null;
  returnPercent: number;
};
type HorizonMetrics = {
  horizon: Horizon;
  status: "DATA_AVAILABLE" | "ACCUMULATING";
  evaluatedSignalDates: number;
  observationCount: number;
  meanReturn: number | null;
  medianReturn: number | null;
  positiveRate: number | null;
  minReturn: number | null;
  maxReturn: number | null;
  uniqueSignalDateCount: number;
  uniqueStockCount: number;
  minObservation: ExtremeObservation | null;
  maxObservation: ExtremeObservation | null;
  signalDateCount?: number;
  expectedObservationCount?: number;
  coverageRate?: number | null;
};
type Group = { topN: number; horizons: HorizonMetrics[] };
type ModelSummary = { modelVersion: string; groups: Group[] };
type Response = {
  matureSignalDates: string[];
  matureSignalDatesByHorizon: Record<Horizon, string[]>;
  signalDateRange: { from: string; to: string } | null;
  lastOutcomeDate: string | null;
  latestEodReferenceDate: string | null;
  totalOutcomeObservationCount: number;
  summary: ModelSummary[];
  live: {
    executionPolicyId: string;
    matureSignalDates: string[];
    signalDateRange: { from: string; to: string } | null;
    lastOutcomeDate: string | null;
    totalOutcomeObservationCount: number;
    summary: ModelSummary[];
  };
};

const MODELS = [
  { version: "A-v1", label: "A" },
  { version: "B-v1", label: "B" },
  { version: "C-v1", label: "C" },
  { version: "D-v1", label: "D" },
] as const;
const TOP_SIZES = [5, 10, 20] as const;
const DAILY_HORIZONS: Horizon[] = ["1DAY", "5DAY", "20DAY", "60DAY"];
const LIVE_HORIZONS: Horizon[] = ["1DAY", "5DAY", "20DAY", "60DAY"];

const formatReturn = (value: number | null) => value == null ? "—" : `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;
const returnTone = (value: number | null) => value == null ? "text-slate-400" : value > 0 ? "text-red-600" : value < 0 ? "text-blue-600" : "text-slate-700";

function ExtremeReturn({ label, value, observation, isDaily }: { label: string; value: number | null; observation: ExtremeObservation | null; isDaily: boolean }) {
  return <div className="min-w-0 rounded-lg border border-slate-200/70 bg-[rgba(247,243,236,0.9)] px-3 py-2 text-xs">
    <div className="flex items-center justify-between gap-2"><span className="text-slate-600">{label} · 개별 종목</span><strong className={`tabular-nums ${returnTone(value)}`}>{formatReturn(value)}</strong></div>
    {observation ? <>
      <p className="mt-1 break-words font-medium text-slate-900">{observation.companyName ?? "종목명 미확인"} <span className="font-normal text-slate-600">{observation.ticker}</span></p>
      <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-slate-600">
        <dt>신호일</dt><dd>{observation.signalDate}{observation.signalTime ? ` · ${observation.signalTime} KST` : ""}</dd>
        <dt>{isDaily ? "기준가격일" : "진입일"}</dt><dd>{observation.entryDate ?? "미확인"}</dd>
        <dt>평가 종료일</dt><dd>{observation.evaluationEndDate ?? "미확인"}</dd>
      </dl>
    </> : <p className="mt-1 text-slate-600">종목 정보 미확인</p>}
  </div>;
}

export default function ModelTopPerformancePanel() {
  const [data, setData] = useState<Response | null>(null);
  const [error, setError] = useState(false);
  const [modelVersion, setModelVersion] = useState("B-v1");
  const [topN, setTopN] = useState(10);
  const [performanceLayer, setPerformanceLayer] = useState<"DAILY_EOD" | "INTRADAY_1430_LIVE">("DAILY_EOD");

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

  const selectedHorizons = useMemo(() => {
    const summary = performanceLayer === "DAILY_EOD" ? data?.summary : data?.live?.summary;
    const group = summary?.find((model) => model.modelVersion === modelVersion)?.groups.find((item) => item.topN === topN);
    const horizons = performanceLayer === "DAILY_EOD" ? DAILY_HORIZONS : LIVE_HORIZONS;
    return horizons.map((horizon) => group?.horizons.find((item) => item.horizon === horizon) ?? {
      horizon,
      status: "ACCUMULATING" as const,
      evaluatedSignalDates: 0,
      observationCount: 0,
      meanReturn: null,
      medianReturn: null,
      positiveRate: null,
      minReturn: null,
      maxReturn: null,
      uniqueSignalDateCount: 0,
      uniqueStockCount: 0,
      minObservation: null,
      maxObservation: null,
    });
  }, [data, modelVersion, performanceLayer, topN]);

  const metadata = performanceLayer === "DAILY_EOD" ? data : data?.live;

  return (
    <section className="tb-card mt-6 p-4 sm:p-6" aria-labelledby="model-performance-heading">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.15em] text-[var(--tb-orange)]">Model performance</p>
          <h2 id="model-performance-heading" className="mt-1 text-xl font-bold tracking-tight text-slate-950 sm:text-2xl">모델 성과</h2>
          <p className="mt-1 text-sm text-slate-600">Daily EOD와 14:30 LIVE 성과를 서로 섞지 않고 별도로 집계합니다.</p>
        </div>
        <div className="grid grid-cols-2 gap-x-5 gap-y-1 text-xs text-slate-600 sm:grid-cols-4 lg:text-right">
          <span>분석 기간</span><strong className="font-semibold text-slate-800">{metadata?.signalDateRange ? `${metadata.signalDateRange.from} ~ ${metadata.signalDateRange.to}` : "축적 중"}</strong>
          <span>신호일</span><strong className="font-semibold tabular-nums text-slate-800">{metadata?.matureSignalDates.length ?? 0}일</strong>
          {performanceLayer === "DAILY_EOD" && <><span>최신 EOD</span><strong className="font-semibold text-slate-800">{data?.latestEodReferenceDate ?? "—"}</strong></>}
          <span>성과 결과 기준일</span><strong className="font-semibold text-slate-800">{metadata?.lastOutcomeDate ?? "—"}</strong>
          <span>상태</span><strong className="font-semibold text-amber-700">표본 축적 중 · 참고용</strong>
        </div>
      </div>

      <div className="mt-4 inline-flex rounded-lg bg-slate-100/90 p-1" role="tablist" aria-label="성과 계층 선택">
        <button type="button" role="tab" aria-selected={performanceLayer === "DAILY_EOD"} onClick={() => setPerformanceLayer("DAILY_EOD")} className={`rounded-md px-3 py-2 text-xs font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--tb-orange)] ${performanceLayer === "DAILY_EOD" ? "bg-white text-slate-900 shadow-sm" : "text-slate-500"}`}>Daily EOD</button>
        <button type="button" role="tab" aria-selected={performanceLayer === "INTRADAY_1430_LIVE"} onClick={() => setPerformanceLayer("INTRADAY_1430_LIVE")} className={`rounded-md px-3 py-2 text-xs font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--tb-orange)] ${performanceLayer === "INTRADAY_1430_LIVE" ? "bg-white text-slate-900 shadow-sm" : "text-slate-500"}`}>14:30 LIVE</button>
      </div>
      <p className="mt-2 text-xs text-slate-500">{performanceLayer === "DAILY_EOD" ? "동결된 EOD 순위와 공식 종가 결과" : "14:30 동결 신호 · 다음 거래일 공식 시가 진입 · 거래일 종가 성과"}</p>

      <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-b border-slate-200/80 pb-3">
        <div className="flex gap-1" role="tablist" aria-label="성과 모델 선택">
          {MODELS.map((model) => <button key={model.version} type="button" role="tab" aria-selected={modelVersion === model.version} onClick={() => setModelVersion(model.version)} className={`rounded-lg px-4 py-2 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--tb-orange)] ${modelVersion === model.version ? "bg-slate-900 text-white" : "text-slate-500 hover:bg-slate-100 hover:text-slate-900"}`}>모델 {model.label}</button>)}
        </div>
        <div className="flex gap-1 rounded-lg bg-slate-100/90 p-1" aria-label="TOP 범위 선택">
          {TOP_SIZES.map((size) => <button key={size} type="button" onClick={() => setTopN(size)} className={`rounded-md px-3 py-1.5 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--tb-orange)] ${topN === size ? "bg-white text-[var(--tb-orange)] shadow-sm" : "text-slate-500 hover:text-slate-900"}`}>TOP {size}</button>)}
        </div>
      </div>

      <div className="mt-4 overflow-hidden rounded-xl border border-[var(--tb-border)] bg-[rgba(255,252,247,0.84)]">
        <div className="grid grid-cols-[0.9fr_1fr_1fr_1fr_0.75fr] gap-2 border-b border-slate-200 bg-slate-50/90 px-3 py-2.5 text-xs font-medium text-slate-500 sm:px-4">
          <span>기간</span><span className="text-right">평균</span><span className="text-right">중앙값</span><span className="text-right">상승비율</span><span className="text-right">표본</span>
        </div>
        {selectedHorizons.map((metrics) => <div key={metrics.horizon} className="border-b border-slate-200/70 px-3 py-3 last:border-b-0 sm:px-4">
          <div className="grid min-h-10 grid-cols-[0.9fr_1fr_1fr_1fr_0.75fr] items-center gap-2 text-xs sm:text-sm">
          <span className="font-semibold text-slate-900">{metrics.horizon}</span>
          {metrics.status === "DATA_AVAILABLE" ? <>
            <span className={`text-right font-semibold tabular-nums ${returnTone(metrics.meanReturn)}`}>{formatReturn(metrics.meanReturn)}</span>
            <span className={`text-right tabular-nums ${returnTone(metrics.medianReturn)}`}>{formatReturn(metrics.medianReturn)}</span>
            <span className="text-right tabular-nums text-slate-700">{metrics.positiveRate?.toFixed(1)}%</span>
            <span className="text-right tabular-nums text-slate-700">N={metrics.observationCount}<small className="block text-[10px] text-slate-400">{metrics.evaluatedSignalDates}/{metrics.signalDateCount ?? metrics.evaluatedSignalDates}일{metrics.coverageRate == null ? "" : ` · ${metrics.coverageRate.toFixed(0)}%`}</small></span>
          </> : <span className="col-span-4 text-right text-sm text-slate-400">데이터 축적 중</span>}
          </div>
          {metrics.status === "DATA_AVAILABLE" && <>
            <p className="mt-1 text-xs leading-relaxed text-slate-600">확정 종목 관측 {metrics.observationCount}건 · 서로 다른 신호일 {metrics.uniqueSignalDateCount}일 · 서로 다른 종목 {metrics.uniqueStockCount}개</p>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              <ExtremeReturn label="최소 수익률" value={metrics.minReturn} observation={metrics.minObservation} isDaily={performanceLayer === "DAILY_EOD"} />
              <ExtremeReturn label="최대 수익률" value={metrics.maxReturn} observation={metrics.maxObservation} isDaily={performanceLayer === "DAILY_EOD"} />
            </div>
          </>}
        </div>)}
      </div>

      {error && <p className="mt-3 text-sm text-red-700" role="alert">성과 데이터를 불러오지 못했습니다.</p>}
      {!error && !data && <p className="mt-3 text-sm text-slate-500">성과 데이터를 불러오는 중입니다.</p>}
      <p className="mt-3 text-xs text-slate-500">수익률이 0%인 결과와 미확정 결과는 구분됩니다. 미확정 결과는 통계와 N에 포함하지 않습니다.</p>
      <p className="mt-1 text-xs text-slate-500">최소·최대는 확정된 개별 종목 관측의 극단값이며, TOP 포트폴리오 수익률이 아닙니다. 동률이면 신호일이 빠른 종목, 같은 날에는 종목코드 순으로 표시합니다.</p>
      <p className="mt-1 text-xs text-slate-500">평균·중앙값·상승비율은 개별 관측 기준입니다. 같은 종목의 반복 선정과 같은 날의 관측은 독립 표본이 아니며, N만으로 모델의 유효성을 판단할 수 없습니다.</p>
      <p className="mt-1 text-xs text-slate-500">{performanceLayer === "DAILY_EOD" ? "Daily 기준가격일은 신호일 공식 종가 기준이며 실제 매수 진입일을 뜻하지 않습니다." : "LIVE 진입일은 기존 계약의 다음 거래일 공식 시가 기준입니다. 실제 체결, 비용·슬리피지를 반영한 실현 수익률이 아닙니다."}</p>
      {performanceLayer === "DAILY_EOD" && <p className="mt-1 text-xs text-slate-500">최신 EOD는 모델 입력의 최신 기준일이며, 성과 결과 기준일은 미래 수익률이 실제로 확정된 마지막 청산일입니다.</p>}
    </section>
  );
}
