"use client";
import { useEffect, useRef, useState } from "react";
import { dailyOperationState, latestOneDayPerformance } from "../lib/home-dashboard.mjs";
import { liveStatusLabel } from "../lib/intraday-model-top-time-policy.mjs";
import { transitionLabel } from "../lib/directional-transition.mjs";
type Stock = { code: string; name: string; market?: string };
type Ranked = Stock & { rank: number; score: number; previousRank?: number | null; rankChange?: number | null };
type Model = { modelVersion: string; rankingUniverseCount: number; top: Ranked[]; comparisonStatus?: string; previousDate?: string | null };
type TransitionState = { direction?: string; state: string; count: number | null; examples: Stock[] };
type LiveStatus = { status: string; signalDate: string | null; runStartedAt?: string | null; runnerFirstStepAt?: string | null; scheduledAt?: string | null; nextScheduledAt?: string | null; lastSuccessAt?: string | null; lastGoodDate?: string | null; storedAt?: string | null };
type Dashboard = { referenceDate: string | null; models: { referenceDate: string; models: Model[] } | null; transitions: { referenceDate: string; indicatorCoverage: number; totalUniverse: number; sourceQualityGrade: string; pairs: { pair: string; states: TransitionState[]; directionalStates?: TransitionState[] }[] } | null; calendar: { today: string; time: string; dayStatus: string; expectedTradingDate: string | null } | null; liveStatus: LiveStatus | null };
type PerformanceRow = { modelVersion: string; horizon: string; topN: number; signalDate: string; targetTradingDate: string | null; observationCount: number; meanReturn: number | null; positiveRate: number | null };
type Performance = { daily: PerformanceRow[]; live?: { daily: PerformanceRow[] } };
type Operations = { lastAutomaticRunAt?: string | null; lastAutomaticRunConclusion?: string | null; lastSuccessAt?: string | null; siteApiReferenceDate?: string | null; latestConfirmedTradingDate?: string | null; recentFailureReason?: string | null; freshnessStatus?: string; publicationStatus?: string; siteApiMatchesPublished?: boolean; runStatus?: string; lagTradingDays?: number | null };
function useResource<T>(url: string) {
  const [state, setState] = useState<{ url: string; data: T | null; error: boolean } | null>(null);
  const sequence = useRef(0);
  useEffect(() => {
    let controller: AbortController | null = null;
    const load = () => {
      controller?.abort(); controller = new AbortController();
      const signal = controller.signal, id = ++sequence.current;
      void fetch(url, { cache: "no-store", signal }).then(async (response) => {
        if (!response.ok) throw new Error("UNAVAILABLE"); return response.json() as Promise<T>;
      }).then((data) => { if (!signal.aborted && id === sequence.current) setState({ url, data, error: false }); })
        .catch(() => { if (!signal.aborted && id === sequence.current) setState({ url, data: null, error: true }); });
    };
    load(); const refresh = () => { if (!document.hidden) load(); };
    const timer = window.setInterval(refresh, 60_000); document.addEventListener("visibilitychange", refresh);
    return () => { controller?.abort(); window.clearInterval(timer); document.removeEventListener("visibilitychange", refresh); };
  }, [url]);
  return state?.url === url ? state : { url, data: null, error: false };
}
const labels: Record<string, string> = { NORMAL: "정상", SOURCE_WAITING: "추가 공식 EOD 제공 대기", WAITING: "지연 · 갱신 대기", DELAYED: "지연", FAILED: "실패", UNKNOWN: "확인 불가" };
const pct = (v: number | null) => Number.isFinite(v) ? (Number(v) > 0 ? "+" : "") + Number(v).toFixed(2) + "%" : "미확인";
const time = (v?: string | null) => v && Number.isFinite(Date.parse(v)) ? new Date(v).toLocaleString("ko-KR", { timeZone: "Asia/Seoul", hour12: false }) + " KST" : "확인 불가";
export default function HomeDashboard({ onSelectStock, onOpenModel, onOpenPerformance, onOpenTransition, onOpenSearch }: {
  onSelectStock: (stock: Stock) => void | Promise<void>; onOpenModel: (model: string) => void; onOpenPerformance: () => void;
  onOpenTransition: (pair: string, state: string, direction?: string) => void; onOpenSearch?: () => void;
}) {
  const dashboard = useResource<Dashboard>("/api/home-dashboard?topN=5");
  const performance = useResource<Performance>("/api/model-performance");
  const operations = useResource<Operations>("/api/daily-production-status");
  const live = useResource<{ signalDate: string; collectionCompletedAt: string }>("/api/intraday-model-top?model=B&limit=1");
  const data = dashboard.data, transitions = data?.transitions;
  const outcome = performance.data ? latestOneDayPerformance(performance.data, 5) : null;
  const operation = dailyOperationState(operations.data, data?.calendar);
  const liveStatus = liveStatusLabel(data?.liveStatus) ?? (live.data ? "최근 관측 " + live.data.signalDate : "관측 대기 / 확인 불가");
  const stockButton = (stock: Stock) => <button type="button" onClick={() => void onSelectStock(stock)} className="tb-focus pointer-events-auto min-w-0 rounded text-left hover:text-[var(--tb-orange)]"><span className="block truncate font-medium">{stock.name}</span><span className="text-[10px] text-slate-600">{stock.code}</span></button>;
  return <section className="space-y-3" aria-labelledby="home-dashboard-heading">
    <div className="flex flex-wrap items-center justify-between gap-2 text-slate-100"><div><p className="text-[10px] tracking-[0.14em] text-[#dbb296]">TIGHT BUDGET · DAILY RESEARCH</p><h1 id="home-dashboard-heading" className="text-xl font-medium">오늘의 분석 대시보드</h1></div><button type="button" onClick={onOpenSearch} className="tb-focus rounded-lg bg-[var(--tb-orange)] px-4 py-2 text-sm text-white">종목 검색 →</button></div>
    <div className="tb-market-status-panel grid gap-2 rounded-xl px-3 py-3 text-xs text-slate-200 sm:grid-cols-2 xl:grid-cols-5" aria-label="데이터 최신성 요약">
      <div><span className="text-slate-400">공식 EOD</span><p className="mt-1 font-medium">{data?.referenceDate ?? "확인 불가"}</p></div>
      <div><span className="text-slate-400">모델 TOP 갱신</span><p className="mt-1">{data?.models ? "저장 순위 · " + data.models.referenceDate : "검증 불가"}</p></div>
      <div><span className="text-slate-400">14:30 LIVE</span><p className="mt-1">{liveStatus}</p><p className="mt-1 text-[10px] text-slate-400">상태 기준일 {data?.liveStatus?.signalDate ?? "확인 불가"} · 마지막 정상 관측 {live.data?.signalDate ?? data?.liveStatus?.lastGoodDate ?? "없음 / 미확인"}</p></div>
      <div><span className="text-slate-400">마지막 정상 갱신 (API 기록)</span><p className="mt-1">{time(operations.data?.lastSuccessAt)}</p></div>
      <div><span className="text-slate-400">운영 상태</span><p className="mt-1">{labels[operation]}</p></div>
    </div>
    <div className="grid min-w-0 gap-3 xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
      <div className="min-w-0 space-y-3">
      <section className="tb-card min-w-0 p-4" aria-labelledby="home-model-heading"><h2 id="home-model-heading" className="text-base font-semibold">모델 TOP3 · Daily EOD</h2><p className="mt-1 text-xs text-slate-600">동결된 모델 점수·순위 · {data?.models?.referenceDate ?? "조회 중"}</p>
        {data?.models ? <div className="mt-3 grid gap-2 sm:grid-cols-2">{data.models.models.map((model) => <article key={model.modelVersion} className="relative min-w-0 rounded-lg bg-[#f7f3eb] p-3">
          <button type="button" aria-label={`모델 ${model.modelVersion} 상세 순위`} onClick={() => onOpenModel(model.modelVersion === "A-v1" ? "A-v1" : model.modelVersion[0])} className="tb-focus absolute inset-0 rounded-lg hover:bg-orange-100/15" />
          <h3 className="pointer-events-none relative text-xs font-semibold text-[var(--tb-orange)]">모델 {model.modelVersion[0]} · {model.modelVersion} →</h3>
          <ol className="pointer-events-none relative mt-2 space-y-2">{model.top.slice(0, 3).map((row) => <li key={row.code} className="grid grid-cols-[1rem_minmax(0,1fr)_auto] items-center gap-2 text-xs"><span className="text-slate-500">{row.rank}</span><span className="min-w-0">{stockButton(row)}</span><span className="text-right"><span className="font-semibold tabular-nums">{row.score.toFixed(2)}</span>{model.comparisonStatus === "AVAILABLE" && Number.isInteger(row.rankChange) && <span className={`mt-0.5 block text-[10px] ${Number(row.rankChange) > 0 ? "text-red-600" : Number(row.rankChange) < 0 ? "text-blue-600" : "text-slate-600"}`} title={`${model.previousDate} 순위 ${row.previousRank} → ${row.rank}`}>{Number(row.rankChange) > 0 ? `↑${row.rankChange}` : Number(row.rankChange) < 0 ? `↓${Math.abs(Number(row.rankChange))}` : "— 유지"}</span>}</span></li>)}</ol>
          <p className="pointer-events-none relative mt-2 text-[10px] text-slate-600">{model.comparisonStatus === "AVAILABLE" ? `${model.previousDate} 대비 · 동일 버전/공식/universe` : "전일 순위 비교 불가"}</p>
          {!model.top.length && <p className="pointer-events-none relative mt-2 text-xs text-slate-600">분석 가능한 종목 없음</p>}
        </article>)}</div> : <p className="py-4 text-xs text-slate-600">{dashboard.error ? "순위 조회 실패" : "검증 가능한 저장 순위 확인 중"}</p>}
      </section>
      <section className="tb-card min-w-0 p-4" aria-labelledby="home-performance-heading"><div className="flex justify-between gap-2"><h2 id="home-performance-heading" className="text-base font-semibold">최근 확정 1D 성과 · TOP5</h2><button type="button" onClick={onOpenPerformance} className="tb-focus rounded text-xs text-[var(--tb-orange)]">상세 →</button></div>
        {(["daily", "live"] as const).map((layer) => <div key={layer} className="mt-3"><p className="text-xs text-slate-600">{layer === "daily" ? "Daily EOD · 신호일 종가 → 다음 거래일 종가" : "14:30 LIVE · 별도 실행 계약"}</p><div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">{outcome?.[layer].map((row) => <div key={row.modelVersion} className="min-w-0 rounded-lg bg-[#f7f3eb] p-2 text-xs"><span className="font-medium">{row.modelVersion[0]}</span>{row.observationCount ? <><p className={"mt-1 font-semibold " + (Number(row.meanReturn) > 0 ? "text-red-600" : Number(row.meanReturn) < 0 ? "text-blue-600" : "text-slate-700")}>{pct(row.meanReturn)}</p><p className="mt-1 text-[10px] text-slate-600">관측 {row.observationCount}건 · 신호일 1개<br />신호 {row.signalDate}<br />종료 {row.resultDate ?? "미확인"}</p></> : <p className="mt-1 text-slate-600">데이터 축적 중</p>}</div>) ?? <p className="col-span-2 sm:col-span-4 text-xs text-slate-600">{performance.error ? "성과 조회 실패" : "확정 성과 확인 중"}</p>}</div></div>)}
        <p className="mt-2 text-[10px] text-slate-600">신호일별 최신 확정 단면 · 독립 표본 아님 · 모델 우열 판정 없음</p><button type="button" onClick={onOpenPerformance} className="tb-focus mt-2 rounded text-xs text-slate-600">5D / 20D 축적 상태는 성과 상세에서 확인 →</button>
      </section>
      </div>
      <div className="min-w-0 space-y-3">
      <section className="tb-card min-w-0 p-4" aria-labelledby="home-transition-heading"><h2 id="home-transition-heading" className="text-base font-semibold">전환 신호 · 연구용</h2><p className="mt-1 text-xs text-slate-600">{transitions ? transitions.referenceDate + " · 지표 " + transitions.indicatorCoverage + "/" + transitions.totalUniverse : "전환 지표 데이터 없음"}</p>
        {transitions?.pairs.map((pair) => <div key={pair.pair} className="mt-3"><h3 className="mb-1 text-xs font-medium">{pair.pair.replace("-", "/")}일 이동평균선</h3><div className="grid grid-cols-2 gap-1">{(pair.directionalStates ?? pair.states.map((s) => ({ ...s, direction: "golden" }))).map((state) => <div key={state.direction + ":" + state.state} className="min-w-0 rounded-lg bg-[#f7f3eb] px-2 py-2 text-xs"><button type="button" onClick={() => onOpenTransition(pair.pair, state.state, state.direction)} className="tb-focus w-full rounded text-left hover:text-[var(--tb-orange)]"><span className="block font-medium">{transitionLabel(state.direction, state.state)}</span><span className="mt-1 block text-[var(--tb-orange)]">{state.count === null ? "확인 불가" : state.count + "종목"} →</span></button>{state.examples[0] ? <div className="mt-1 truncate text-[10px] text-slate-600">{stockButton(state.examples[0])}</div> : <p className="mt-1 text-[10px] text-slate-600">{state.count === 0 ? "해당 조건 종목 없음" : "대표 종목 없음"}</p>}</div>)}</div></div>)}
        <p className="mt-2 text-[10px] text-slate-600">연구 규칙 · 매수 추천 아님{transitions ? " · 원천 품질 " + transitions.sourceQualityGrade : ""}</p>
      </section>
      <section className="tb-card min-w-0 p-4" aria-labelledby="home-operations-heading"><h2 id="home-operations-heading" className="text-base font-semibold">데이터 운영 상세</h2><details className="mt-3 text-xs text-slate-700"><summary className="tb-focus cursor-pointer rounded">상세 운영 정보</summary><dl className="mt-2 space-y-2"><div><dt>사이트 공식 EOD / 최신 확정 거래일</dt><dd>{operations.data?.siteApiReferenceDate ?? "확인 불가"} / {operations.data?.latestConfirmedTradingDate ?? "확인 불가"}</dd></div><div><dt>마지막 자동 실행 (게시 성공과 다름)</dt><dd>{time(operations.data?.lastAutomaticRunAt)} · {operations.data?.lastAutomaticRunConclusion ?? "미확인"}</dd></div><div><dt>게시 확인 / 지연 거래일</dt><dd>{operations.data?.siteApiMatchesPublished ? "저장 게시일 일치" : "확인 불가"} / {operations.data?.lagTradingDays ?? "미확인"}</dd></div><div><dt>최근 실패 사유</dt><dd className="break-words">{operations.data?.recentFailureReason ?? "기록 없음"}</dd></div></dl><p className="mt-2">API 성공은 최신성 증거가 아닙니다. 자동 게시 성공 계보는 별도 확인이 필요합니다.</p><p className="mt-2">KIS 잠정 EOD: 비공개 · 공개 연결 비활성. KOSPI/KOSDAQ/USD-KRW/거래대금: 미연결 · 숫자 미표시.</p></details></section>
      <details className="tb-card p-3 text-xs text-slate-700"><summary className="tb-focus cursor-pointer rounded">LIVE 실행 시각 · 상태 상세</summary>
        <dl className="mt-2 space-y-2">
          <div><dt>예약 / runner 첫 단계 시작</dt><dd>{time(data?.liveStatus?.scheduledAt)} / {time(data?.liveStatus?.runnerFirstStepAt)}</dd></div>
          <div><dt>수집 스크립트 시작</dt><dd>{time(data?.liveStatus?.runStartedAt)}</dd></div>
          <div><dt>다음 GitHub 예약 (휴장 판정·지연 가능)</dt><dd>{time(data?.liveStatus?.nextScheduledAt)}</dd></div>
          <div><dt>마지막 정상 관측 완료</dt><dd>{time(live.data?.collectionCompletedAt ?? data?.liveStatus?.lastSuccessAt)}</dd></div>
          <div><dt>최근 artifact 저장 (게시 성공과 다름)</dt><dd>{time(data?.liveStatus?.storedAt)}</dd></div>
        </dl><p className="mt-2">GitHub 게시 및 Vercel API 확인 결과는 해당 Actions 실행 로그에서 별도로 검증합니다.</p>
      </details>
      </div>
    </div>
  </section>;
}
