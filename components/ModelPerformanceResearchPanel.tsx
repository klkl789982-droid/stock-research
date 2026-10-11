"use client";

import { useEffect, useState } from "react";

type Metrics = { observationCount: number; meanReturn: number | null; medianReturn: number | null; positiveRate: number | null; standardDeviation: number | null; minReturn: number | null; maxReturn: number | null; distribution: { negative: number; zero: number; positive: number } | null };
type Observation = { ticker: string; companyName: string | null; signalDate: string; signalGeneratedAt: string | null; signalAvailableAt: string | null; sourceSnapshotHash: string; rank: number; score: number; entryDate: string | null; exitDate: string | null; grossReturn: number | null; netScenarioReturn: number | null; status: string; reason: string | null };
type Portfolio = { signalDate: string; entryDate: string; exitDate: string; memberCount: number; grossReturn: number; netScenarioReturn: number | null; benchmarkReturn: number | null; excessReturn: number | null };
type Cohort = { id: string; modelVersion: string; formulaHash: string | null; universeHash: string; universeCount: number; classification: string; signalDates: string[]; signalDateCount: number; observedSignalDateCount: number; matureSignalDateCount: number; uniqueStockCount: number; repeatedObservationCount: number; pendingCount: number; missingCount: number; exclusionReasons: Record<string, number>; stockMetrics: Metrics; portfolioMetrics: Metrics; netScenarioMetrics: Metrics; excessMetrics: Metrics; portfolios: Portfolio[]; rows: Observation[]; warnings: string[] };
type Research = { researchVersion: string; asOf: string; costStatus: string; benchmarkStatus: string; filter: { topN: number; horizon: string; market: string; classification: string; cost: { mode: string; basis?: string; basisDate?: string } }; contract: Record<string, string>; coverage: { storedSignalCount: number; selectedSignalCount: number; latestStoredSignalDate: string | null; officialPriceDateRange: { from: string; to: string } | null; rejectedSignals: { signalDate: string; reason: string }[] }; cohorts: Cohort[]; comparison: { status: string; commonMatureSignalDates: string[]; winner: null; metrics: Array<Metrics & { modelVersion: string }> }; horizonComparison: Record<string, { cohortId: string; stockMetrics: Metrics; portfolioMetrics: Metrics; matureSignalDateCount: number; pendingCount: number; missingCount: number }[]>; provenance: { inputHash: string; inputFiles: { path: string; contentHash: string }[] } };

const versions = ["A-v1", "A-v2", "B-v1", "C-v1", "D-v1"];
const reasons: Record<string, string> = { DATA_QUALITY_BLOCKED: "기존 백테스트 품질 인증 부적격", POINT_IN_TIME_UNIVERSE_UNVERIFIED: "당시 universe 미검증", FORMULA_HASH_CONFLICT: "공식 hash 근거 불일치", FORMULA_HASH_MISSING: "공식 hash 누락", SIGNAL_PUBLICATION_TIME_UNVERIFIED: "실제 발행 완료시각 미검증", PUBLICATION_UNVERIFIED: "발행·동결 순위 근거 미확인", DIFFERENT_RESEARCH_LAYER: "다른 연구 계층", SOURCE_LAYER_NOT_ALLOWED: "Daily 공식 입력 아님", INCOMPLETE_OR_DUPLICATE_RANKING: "순위 누락·중복", SIGNAL_TIMING_CONFLICT: "신호 생성·발행 시각 불일치", timingInvalid: "신호 발행이 진입시각 이후", missingTradingDaySnapshot: "해당 거래일 가격 원장 없음", missingEntryOpenPrice: "진입 시가 없음", missingExitClosePrice: "청산 종가 없음", pendingFutureTradingDay: "미래 거래일 미성숙", unchecked: "거래일 달력 미검증", missingTradingCalendarStatus: "거래일 판정 근거 없음" };
const pct = (value: number | null) => value == null ? "—" : `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;
const tone = (value: number | null) => value == null ? "text-slate-500" : value > 0 ? "text-red-700" : value < 0 ? "text-blue-700" : "text-slate-800";
const fieldClass = "min-w-0 w-full rounded-lg border border-slate-300 bg-[rgba(255,252,247,0.95)] px-2 py-2 text-sm text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--tb-orange)]";
function Metric({ label, value }: { label: string; value: number | null }) {
  return <div className="min-w-0"><dt className="text-xs text-slate-600">{label}</dt><dd className={`mt-1 text-base font-semibold tabular-nums ${tone(value)}`}>{pct(value)}</dd></div>;
}

export default function ModelPerformanceResearchPanel() {
  const [query, setQuery] = useState(""), [revision, setRevision] = useState(0);
  const [data, setData] = useState<Research | null>(null), [error, setError] = useState<string | null>(null), [loading, setLoading] = useState(true);
  const [costMode, setCostMode] = useState("GROSS_ONLY");
  useEffect(() => {
    const controller = new AbortController();
    void fetch(`/api/model-performance/research?${query}`, { cache: "no-store", signal: controller.signal }).then(async (response) => {
      const result = await response.json();
      if (!response.ok) throw new Error(result.message ?? "연구 데이터를 읽지 못했습니다.");
      return result as Research;
    }).then((result) => { if (!controller.signal.aborted) { setData(result); setError(null); setLoading(false); } }).catch((e: unknown) => {
      if (!controller.signal.aborted) { setError(e instanceof Error ? e.message : "연구 데이터 확인 불가"); setLoading(false); }
    });
    return () => controller.abort();
  }, [query, revision]);
  useEffect(() => { const timer = setInterval(() => setRevision((value) => value + 1), 120000); return () => clearInterval(timer); }, []);

  return <div className="mt-4 min-w-0" aria-labelledby="execution-research-heading">
    <h3 id="execution-research-heading" className="text-lg font-semibold text-slate-950">실행 수익률 연구 · 기존 성과와 별도 계약</h3>
    <p className="mt-1 text-sm leading-relaxed text-slate-600">동결된 Daily 순위를 사용합니다. 신호 종가 수익률이나 14:30 LIVE·KIS 잠정 성과와 합산하지 않습니다. 연구 조건을 바꿔도 원본 신호는 수정하지 않습니다.</p>
    <form className="mt-4 space-y-3" onSubmit={(event) => {
      event.preventDefault(); const form = new FormData(event.currentTarget), parameters = new URLSearchParams();
      parameters.set("models", form.getAll("models").join(","));
      for (const [key, value] of form.entries()) if (key !== "models" && typeof value === "string" && value !== "") parameters.set(key, value);
      setLoading(true); setData(null); setError(null); setQuery(parameters.toString()); setRevision((v) => v + 1);
    }}>
      <fieldset className="flex flex-wrap gap-x-4 gap-y-2 text-sm text-slate-800"><legend className="mb-1 text-xs text-slate-600">모델·버전 선택 (서로 다른 공식 hash는 별도 코호트)</legend>{versions.map((version) => <label key={version} className="flex items-center gap-1.5"><input type="checkbox" name="models" value={version} defaultChecked className="accent-[var(--tb-orange)]" />{version}</label>)}</fieldset>
      <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <label className="text-xs text-slate-600">TOP 범위<select name="topN" defaultValue="10" className={fieldClass}>{[5, 10, 20].map((n) => <option key={n} value={n}>TOP{n}</option>)}</select></label>
        <label className="text-xs text-slate-600">거래일 보유기간<select name="horizon" className={fieldClass}><option value="H1">1D</option><option value="H5">5D</option><option value="H20">20D</option></select></label>
        <label className="text-xs text-slate-600">시장<select name="market" className={fieldClass}><option value="ALL">전체</option><option>KOSPI</option><option>KOSDAQ</option></select></label>
        <label className="text-xs text-slate-600">신호 분류<select name="classification" className={fieldClass}><option value="AS_PUBLISHED">AS_PUBLISHED · 저장 신호</option><option value="RETROSPECTIVE">RETROSPECTIVE · 사후 연구</option></select></label>
        <label className="text-xs text-slate-600">신호 시작일<input type="date" name="from" className={fieldClass} /></label>
        <label className="text-xs text-slate-600">신호 종료일<input type="date" name="to" className={fieldClass} /></label>
      </div>
      <details className="rounded-lg border border-slate-200/70 px-3 py-2 text-sm text-slate-700"><summary className="cursor-pointer font-medium">비용 시나리오 · 벤치마크</summary>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <label className="text-xs">거래비용<select name="costMode" value={costMode} onChange={(e) => setCostMode(e.target.value)} className={fieldClass}><option value="GROSS_ONLY">비용 미적용 · gross만</option><option value="ZERO_COST_RESEARCH">연구용 0비용 가정 (실제 세율 아님)</option><option value="USER_INPUT">사용자 입력 연구 시나리오</option></select></label>
          <label className="text-xs">벤치마크<select name="benchmark" className={fieldClass}><option value="MATCHED_MARKET">동일 기간 KOSPI/KOSDAQ (공식 데이터 필요)</option><option value="NONE">비교하지 않음</option></select></label>
        </div>
        {costMode === "USER_INPUT" && <div className="mt-3 grid gap-2 sm:grid-cols-3">
          {[["buyFeeBps", "매수 수수료"], ["sellFeeBps", "매도 수수료"], ["sellTaxBps", "매도 세금"], ["buySlippageBps", "매수 슬리피지"], ["sellSlippageBps", "매도 슬리피지"]].map(([name, label]) => <label key={name} className="text-xs">{label} (bps)<input name={name} type="number" min="0" max="1000" step="any" required className={fieldClass} /></label>)}
          <label className="text-xs">적용 기준일<input type="date" name="basisDate" required className={fieldClass} /></label>
          <label className="text-xs sm:col-span-3">비용 근거·시장/상품 범위<input name="basis" maxLength={200} required placeholder="확인한 근거 또는 가정임을 기재" className={fieldClass} /></label>
        </div>}
        <p className="mt-2 text-xs">1bps=0.01%. 세율·수수료를 자동 추정하지 않습니다. 입력 시나리오의 순수익은 미검증 가정이며 확정 실현 수익이 아닙니다. 시장 필터는 당시 전체 TOP에서 해당 시장만 선택하며 다시 순위를 계산하지 않습니다.</p>
      </details>
      <button type="submit" className="tb-primary-button px-4 py-2 text-sm">연구 조건 적용</button>
    </form>
    {loading && <p className="mt-3 text-sm text-slate-600" role="status">연구 입력 검증 중…</p>}
    {error && <p className="mt-3 text-sm text-red-700" role="alert">{error}</p>}
    {data && <>
      <div className="mt-4 rounded-lg border border-slate-200/70 bg-[rgba(247,243,236,0.92)] p-3 text-xs leading-relaxed text-slate-700">
        <p>저장 신호 {data.coverage.storedSignalCount}일 · 발행 근거 확인 {data.coverage.selectedSignalCount}일 · 최신 신호 {data.coverage.latestStoredSignalDate ?? "없음"} · 공식 가격 원장 {data.coverage.officialPriceDateRange ? `${data.coverage.officialPriceDateRange.from} ~ ${data.coverage.officialPriceDateRange.to}` : "없음"}</p>
        <p>비용: {data.costStatus === "NOT_APPLIED" ? "미적용" : "미검증 연구 시나리오"} · 벤치마크: {data.benchmarkStatus === "UNAVAILABLE" ? "공식 지수 데이터 미연결 / 일치 자료 없음" : "일치 자료가 있는 표본만 별도 비교"}</p>
        <p>모델 우열 판단 보류 · 비교 가능한 공통 성숙 신호일 {data.comparison.commonMatureSignalDates.length}일. 같은 날짜라도 universe가 다르면 같은 조건으로 합산하지 않습니다.</p>
        {data.coverage.rejectedSignals.length > 0 && <p>발행 근거 또는 계층 제외: {data.coverage.rejectedSignals.map((s) => `${s.signalDate} (${reasons[s.reason] ?? s.reason})`).join(" · ")}</p>}
      </div>
      {data.comparison.metrics.length > 0 && <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-5">{data.comparison.metrics.map((m) => <div key={m.modelVersion} className="rounded-lg bg-[rgba(247,243,236,0.92)] p-3 text-sm"><strong>{m.modelVersion}</strong><p>공통 신호일 포트폴리오 평균 {pct(m.meanReturn)}</p><p className="text-xs">{m.observationCount}일 · 기술통계만 / 우열 미판정</p></div>)}</div>}
      {!data.cohorts.length && <p className="mt-4 text-sm text-slate-600">선택 계층·기간·버전의 신호가 없습니다. 사후 신호나 미래 성과를 생성하지 않습니다.</p>}
      <div className="mt-3 space-y-3">{data.cohorts.map((cohort) => <section key={cohort.id} className="min-w-0 rounded-xl border border-slate-200/80 bg-[rgba(247,243,236,0.96)] p-3 sm:p-4" aria-label={`${cohort.modelVersion} 연구 코호트`}>
        <div className="flex flex-wrap items-baseline justify-between gap-2"><h4 className="font-semibold text-slate-950">{cohort.modelVersion} · TOP{data.filter.topN} · {data.filter.horizon.replace("H", "")}D</h4><span className="text-xs text-slate-600">{cohort.classification} · {cohort.signalDates[0]} ~ {cohort.signalDates.at(-1)}</span></div>
        <p className="mt-1 text-xs text-slate-600">관측 신호일 {cohort.signalDateCount} · 일부 성숙 {cohort.observedSignalDateCount}일 · 완전 성숙 포트폴리오 {cohort.matureSignalDateCount}일 · 미성숙 {cohort.pendingCount}건 · 결측/검증 제외 {cohort.missingCount}건</p>
        <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4"><Metric label="신호일 포트폴리오 평균 (gross)" value={cohort.portfolioMetrics.meanReturn} /><Metric label="비용 차감 (미검증 시나리오)" value={cohort.netScenarioMetrics.meanReturn} /><Metric label="벤치마크 대비 평균 초과" value={cohort.excessMetrics.meanReturn} /><Metric label="포트폴리오 중앙값" value={cohort.portfolioMetrics.medianReturn} /></dl>
        {cohort.stockMetrics.observationCount === 0 && <p className="mt-3 text-sm font-medium text-amber-800">통계 산출 보류 · 데이터 축적 또는 품질/발행 근거 확인 필요 (0%가 아님)</p>}
        {Object.entries(cohort.exclusionReasons).length > 0 && <p className="mt-2 text-xs text-amber-800">{Object.entries(cohort.exclusionReasons).map(([reason, count]) => `${reasons[reason] ?? reason}: ${count}건`).join(" · ")}</p>}
        <details className="mt-3 text-sm text-slate-700"><summary className="cursor-pointer font-medium">종목·신호일별 통계 / 제외 사유 / 출처</summary>
          <div className="mt-3 space-y-2" aria-label="보유기간별 비교">{Object.entries(data.horizonComparison).map(([horizon, values]) => { const period = values.find((value) => value.cohortId === cohort.id); return period ? <p key={horizon} className="rounded bg-slate-100/80 p-2 text-xs">{horizon.replace("H", "")}D · 완전 성숙 {period.matureSignalDateCount}일 · 포트폴리오 평균 {pct(period.portfolioMetrics.meanReturn)} · 종목 관측 {period.stockMetrics.observationCount}건 · 미성숙 {period.pendingCount} / 결측·제외 {period.missingCount}</p> : null; })}</div>
          <p className="mt-2 text-xs">확정 종목 관측 {cohort.stockMetrics.observationCount}건 · 서로 다른 종목 {cohort.uniqueStockCount}개 · 반복 관측 {cohort.repeatedObservationCount}건. 날짜와 종목 관측은 독립 표본으로 간주하지 않습니다.</p>
          <dl className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-3"><Metric label="개별 종목 평균" value={cohort.stockMetrics.meanReturn} /><Metric label="중앙값" value={cohort.stockMetrics.medianReturn} /><Metric label="상승 비율" value={cohort.stockMetrics.positiveRate} /><Metric label="표본 표준편차 (n-1)" value={cohort.stockMetrics.standardDeviation} /><Metric label="최소 · 개별 극단값" value={cohort.stockMetrics.minReturn} /><Metric label="최대 · 개별 극단값" value={cohort.stockMetrics.maxReturn} /></dl>
          <p className="mt-2 text-xs">초과수익 중앙값 {pct(cohort.excessMetrics.medianReturn)} · 벤치마크 초과 비율 {pct(cohort.excessMetrics.positiveRate)} · 비교 가능한 포트폴리오 {cohort.excessMetrics.observationCount}일</p>
          <p className="mt-2 text-xs">성과 분포: {cohort.stockMetrics.distribution ? `음수 ${cohort.stockMetrics.distribution.negative} · 0% ${cohort.stockMetrics.distribution.zero} · 양수 ${cohort.stockMetrics.distribution.positive}` : "확정 표본 없음"}</p>
          <div className="mt-3 space-y-2">{cohort.portfolios.map((p) => <p key={p.signalDate} className="rounded bg-slate-100/80 p-2 text-xs">{p.signalDate} 신호 · {p.entryDate} 진입 → {p.exitDate} 청산 · 동일가중 {p.memberCount}종목 · gross {pct(p.grossReturn)} · 비용 시나리오 {pct(p.netScenarioReturn)} · 벤치마크 {pct(p.benchmarkReturn)}</p>)}</div>
          <details className="mt-3"><summary className="cursor-pointer text-xs">종목 관측 {cohort.rows.length}건 (원천 가격 비노출)</summary><div className="mt-2 max-h-96 space-y-2 overflow-y-auto">{cohort.rows.map((r) => <div key={`${r.signalDate}-${r.ticker}`} className="rounded-lg border border-slate-200 bg-[rgba(255,252,247,0.95)] p-2 text-xs">
            <p className="font-medium">#{r.rank} {r.companyName ?? "종목명 미확인"} {r.ticker} · 점수 {r.score.toFixed(2)}</p><p>{r.signalDate} 신호 · {r.entryDate ?? "진입 미확정"} → {r.exitDate ?? "청산 미확정"} · {r.status === "MATURE" ? pct(r.grossReturn) : reasons[r.reason ?? ""] ?? r.reason ?? "미확정"}</p>
            <p className="mt-1 break-all text-slate-600">신호 생성 {r.signalGeneratedAt ?? "미확인"} · 발행 가용시각 {r.signalAvailableAt ?? "미확인"} · 원본 hash {r.sourceSnapshotHash}</p>
          </div>)}</div></details>
          <p className="mt-3 break-all text-xs">공식 hash {cohort.formulaHash ?? "미확인"} · ranking universe {cohort.universeCount}종목 · hash {cohort.universeHash}</p>
          <ul className="mt-2 list-disc space-y-1 pl-4 text-xs">{cohort.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
        </details>
      </section>)}</div>
      <details className="mt-4 rounded-lg border border-slate-200/70 p-3 text-xs text-slate-700"><summary className="cursor-pointer font-medium">연구 계약·재현 기준 자세히 보기</summary><dl className="mt-2 space-y-2">{Object.entries(data.contract).map(([key, value]) => <div key={key}><dt className="font-medium">{key}</dt><dd className="break-words">{value}</dd></div>)}</dl><p className="mt-2 break-all">입력 hash {data.provenance.inputHash} · 계산 버전 {data.researchVersion} · 평가시각 {data.asOf}</p><p className="mt-1">배포된 공식 파일을 읽기 전용으로 다시 참조하며 2분마다 갱신합니다. 신규 발행 근거·품질 인증이 없으면 자동으로 집계에서 제외됩니다. 기존 Daily/LIVE 수집과 outcome 정의는 바뀌지 않습니다.</p><p className="mt-1">비용 근거 {data.filter.cost.basis ?? "없음 / 연구 기본 시나리오"} · 기준일 {data.filter.cost.basisDate ?? "미지정"} · 연구 조건 변경 이력에 따른 데이터 스누핑 주의</p></details>
    </>}
  </div>;
}
