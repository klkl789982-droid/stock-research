"use client";
import { useEffect, useRef, useState } from "react";
import { dailyOperationState, latestOneDayPerformance, publicationReasonLabel, homeOperationStatus } from "../lib/home-dashboard.mjs";
import { liveStatusLabel } from "../lib/intraday-model-top-time-policy.mjs";
import HomeTransitionCard, { type HomeEodTransitions, type HomeTransitionNavigation } from "./HomeTransitionCard";
import PrivateLiveDeliveryPanel from "./PrivateLiveDeliveryPanel";
type Stock = { code: string; name: string; market?: string };
type Ranked = Stock & { rank: number; score: number; previousRank?: number | null; rankChange?: number | null };
type Model = { modelVersion: string; rankingUniverseCount: number; top: Ranked[]; comparisonStatus?: string; previousDate?: string | null };
type LiveStatus = { status: string; officialSignalTime?: string; observationPolicyId?: string; signalDate: string | null; runStartedAt?: string | null; runnerFirstStepAt?: string | null; scheduledAt?: string | null; nextScheduledAt?: string | null; lastSuccessAt?: string | null; lastGoodDate?: string | null; storedAt?: string | null };
type Dashboard = { referenceDate: string | null; models: { referenceDate: string; models: Model[] } | null; transitions: HomeEodTransitions | null; calendar: { today: string; time: string; dayStatus: string; expectedTradingDate: string | null } | null; liveStatus: LiveStatus | null };
type PerformanceRow = { modelVersion: string; horizon: string; topN: number; signalDate: string; targetTradingDate: string | null; observationCount: number; meanReturn: number | null; positiveRate: number | null };
type Performance = { daily: PerformanceRow[]; live?: { layer: string; executionPolicyId: string; daily: PerformanceRow[] } };
type Verification = { referenceDate: string; verifiedAt: string | null; runUrl: string; commitSha: string; snapshotHash: string };
type Operations = { latestAttempt?: { status: string; conclusion: string | null; stage: string | null; startedAt: string; completedAt: string | null; runUrl: string } | null; lastAutomaticRunAt?: string | null; lastAutomaticRunConclusion?: string | null; lastSuccessAt?: string | null; lastGoodStoredReferenceDate?: string | null; siteApiReferenceDate?: string | null; publishedReferenceDate?: string | null; latestConfirmedTradingDate?: string | null; latestCollectedReferenceDate?: string | null; latestValidatedReferenceDate?: string | null; lastSourceCheckAt?: string | null; sourceStatus?: string; recentFailureReason?: string | null; freshnessStatus?: string; repositoryPublicationStatus?: string; repositoryStatusAvailable?: boolean; siteApiMatchesPublished?: boolean; runStatus?: string; lagTradingDays?: number | null; deployment?: { state: string; reason: string | null; lastVerified: Verification | null; verification?: Verification | null; checkedAt?: string | null; intendedIdentity?: { referenceDate: string; snapshotHash: string; commitSha: string } | null } };
type LocalLive = { mode: "live" | "shadow"; status: string; signalDate?: string | null; collectionStartedAt?: string | null; collectionCompletedAt?: string | null; storedAt?: string | null; lastSuccessAt?: string | null; heartbeatAt?: string | null; queryVerifiedAt?: string | null; reason?: string | null; models: { model: string; modelVersion: string; signalDate: string; collectionStartedAt: string; collectionCompletedAt: string; records: { ticker: string; companyName: string; rank: number; score: number }[] }[] };
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
const labels: Record<string, string> = { VERIFIED: "실제 사이트 확인 완료", SOURCE_WAITING: "원본 대기", COLLECTED_VALIDATED: "수집·검증 완료", DEPLOYING: "배포 중", PUBLICATION_FAILED: "저장소 게시 실패", DEPLOYMENT_FAILED: "배포 실패", VERIFICATION_FAILED: "사이트 확인 실패", UNVERIFIED: "사이트 미확인", DELAYED: "새 원본 반영 지연", FAILED: "수집·검증 실패", UNKNOWN: "확인 불가" };
const modelMarketUsage: Record<string, string> = {
  A: "상승장 · 주도주 탐색",
  B: "상승장 · 중기 추세 확인",
  C: "횡보장 · 단기 반등 신호가 나올 때",
  D: "상승장 · 추세와 진입 조건 함께 확인",
};
const pct = (v: number | null) => Number.isFinite(v) ? (Number(v) > 0 ? "+" : "") + Number(v).toFixed(2) + "%" : "미확인";
const time = (v?: string | null) => v && Number.isFinite(Date.parse(v)) ? new Date(v).toLocaleString("ko-KR", { timeZone: "Asia/Seoul", hour12: false }) + " KST" : "확인 불가";
export default function HomeDashboard({ onSelectStock, onOpenModel, onOpenPerformance, onOpenTransition, onOpenSearch }: {
  onSelectStock: (stock: Stock) => void | Promise<void>; onOpenModel: (model: string) => void; onOpenPerformance: () => void;
  onOpenTransition: HomeTransitionNavigation; onOpenSearch?: () => void;
}) {
  const dashboard = useResource<Dashboard>("/api/home-dashboard?topN=5");
  const performance = useResource<Performance>("/api/model-performance");
  const operations = useResource<Operations>("/api/daily-production-status");
  const live = useResource<{ signalDate: string; collectionCompletedAt: string }>("/api/intraday-model-top?model=B&limit=1");
  const localLive = useResource<LocalLive>("/api/private-live");
  const data = dashboard.data, transitions = data?.transitions;
  const outcome = performance.data ? latestOneDayPerformance(performance.data, 5) : null;
  const currentOperations = homeOperationStatus(operations.data, data, performance.data, { homeError: dashboard.error, performanceError: performance.error });
  const operation = dailyOperationState(currentOperations, data?.calendar);
  const liveStatus = liveStatusLabel(data?.liveStatus) ?? (live.data ? "최근 관측 " + live.data.signalDate : "관측 대기 / 확인 불가");
  const stockButton = (stock: Stock) => <button type="button" onClick={() => void onSelectStock(stock)} className="tb-focus pointer-events-auto min-w-0 rounded text-left hover:text-[var(--tb-orange)]"><span className="block truncate font-medium">{stock.name}</span><span className="text-[10px] text-slate-600">{stock.code}</span></button>;
  return <section className="space-y-3" aria-labelledby="home-dashboard-heading">
    <div className="flex flex-wrap items-center justify-between gap-2 text-slate-100"><h1 id="home-dashboard-heading" className="text-xl font-medium">홈</h1><button type="button" onClick={onOpenSearch} className="tb-focus rounded-lg bg-[var(--tb-orange)] px-4 py-2 text-sm text-white">종목 검색 →</button></div>
    <div className="tb-market-status-panel grid gap-2 rounded-xl px-3 py-3 text-xs text-slate-200 sm:grid-cols-2 xl:grid-cols-5" aria-label="데이터 최신성 요약">
      <div><span className="text-slate-400">공식 EOD</span><p className="mt-1 font-medium">{data?.referenceDate ?? "확인 불가"}</p></div>
      <div><span className="text-slate-400">모델 TOP 갱신</span><p className="mt-1">{data?.models ? "저장 순위 · " + data.models.referenceDate : "검증 불가"}</p></div>
      <div><span className="text-slate-400">14:00 LIVE</span><p className="mt-1">{liveStatus}</p><p className="mt-1 text-[10px] text-slate-400">상태 기준일 {data?.liveStatus?.signalDate ?? "확인 불가"} · 마지막 정상 관측 {live.data?.signalDate ?? data?.liveStatus?.lastGoodDate ?? "없음 / 미확인"}</p></div>
      <div><span className="text-slate-400">마지막 정상 저장 데이터</span><p className="mt-1">{operations.data?.lastGoodStoredReferenceDate ?? "확인 불가"}</p></div>
      <div><span className="text-slate-400">운영 상태</span><p className="mt-1">{labels[operation]}</p></div>
    </div>
    <PrivateLiveDeliveryPanel />
    <div className="grid min-w-0 gap-3 xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
      <div className="min-w-0 space-y-3">
      <section className="tb-card min-w-0 p-4" aria-labelledby="home-model-heading"><h2 id="home-model-heading" className="text-base font-semibold">모델 TOP3 · Daily EOD</h2><p className="mt-1 text-xs text-slate-600">동결된 모델 점수·순위 · {data?.models?.referenceDate ?? "조회 중"}</p>
        {data?.models ? <div className="mt-3 grid gap-2 sm:grid-cols-2">{data.models.models.map((model) => <article key={model.modelVersion} className="relative min-w-0 rounded-lg bg-[#f7f3eb] p-3">
          <button type="button" aria-label={`모델 ${model.modelVersion} 상세 순위`} onClick={() => onOpenModel(model.modelVersion === "A-v1" ? "A-v1" : model.modelVersion[0])} className="tb-focus absolute inset-0 rounded-lg hover:bg-orange-100/15" />
          <h3 className="pointer-events-none relative text-xs font-semibold text-[var(--tb-orange)]">모델 {model.modelVersion[0]} · {model.modelVersion} →</h3>
          {modelMarketUsage[model.modelVersion[0]] && <p className="pointer-events-none relative mt-1 text-xs leading-5 text-slate-700">{modelMarketUsage[model.modelVersion[0]]}</p>}
          <ol className="pointer-events-none relative mt-2 space-y-2">{model.top.slice(0, 3).map((row) => <li key={row.code} className="grid grid-cols-[1rem_minmax(0,1fr)_auto] items-center gap-2 text-xs"><span className="text-slate-500">{row.rank}</span><span className="min-w-0">{stockButton(row)}</span><span className="text-right"><span className="font-semibold tabular-nums">{row.score.toFixed(2)}</span>{model.comparisonStatus === "AVAILABLE" && Number.isInteger(row.rankChange) && <span className={`mt-0.5 block text-[10px] ${Number(row.rankChange) > 0 ? "text-red-600" : Number(row.rankChange) < 0 ? "text-blue-600" : "text-slate-600"}`} title={`${model.previousDate} 순위 ${row.previousRank} → ${row.rank}`}>{Number(row.rankChange) > 0 ? `↑${row.rankChange}` : Number(row.rankChange) < 0 ? `↓${Math.abs(Number(row.rankChange))}` : "— 유지"}</span>}</span></li>)}</ol>
          <p className="pointer-events-none relative mt-2 text-[10px] text-slate-600">{model.comparisonStatus === "AVAILABLE" ? `${model.previousDate} 대비 · 동일 버전/공식/universe` : "전일 순위 비교 불가"}</p>
          {!model.top.length && <p className="pointer-events-none relative mt-2 text-xs text-slate-600">분석 가능한 종목 없음</p>}
        </article>)}</div> : <p className="py-4 text-xs text-slate-600">{dashboard.error ? "순위 조회 실패" : "검증 가능한 저장 순위 확인 중"}</p>}
        <p className="mt-3 text-[11px] leading-5 text-slate-600">장세별 설명은 산식의 특성에 따른 구분이며, 수익률 우위가 검증된 것은 아닙니다.</p>
        <p className="mt-1 text-[11px] leading-5 text-slate-600">하락장에서는 네 모델 모두 신규 매수 판단에 주의가 필요합니다.</p>
      </section>
      <section className="tb-card min-w-0 p-4" aria-labelledby="home-performance-heading"><div className="flex justify-between gap-2"><h2 id="home-performance-heading" className="text-base font-semibold">최근 확정 1D 성과 · TOP5</h2><button type="button" onClick={onOpenPerformance} className="tb-focus rounded text-xs text-[var(--tb-orange)]">상세 →</button></div>
        {(["daily", "live"] as const).map((layer) => <div key={layer} className="mt-3"><p className="text-xs text-slate-600">{layer === "daily" ? "Daily EOD · 신호일 종가 → 다음 거래일 종가" : "14:00 LIVE · 별도 실행 계약"}</p><div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">{outcome?.[layer].map((row) => <div key={row.modelVersion} className="min-w-0 rounded-lg bg-[#f7f3eb] p-2 text-xs"><span className="font-medium">{row.modelVersion[0]}</span>{row.observationCount ? <><p className={"mt-1 font-semibold " + (Number(row.meanReturn) > 0 ? "text-red-600" : Number(row.meanReturn) < 0 ? "text-blue-600" : "text-slate-700")}>{pct(row.meanReturn)}</p><p className="mt-1 text-[10px] text-slate-600">관측 {row.observationCount}건 · 신호일 1개<br />신호 {row.signalDate}<br />종료 {row.resultDate ?? "미확인"}</p></> : <p className="mt-1 text-slate-600">데이터 축적 중</p>}</div>) ?? <p className="col-span-2 sm:col-span-4 text-xs text-slate-600">{performance.error ? "성과 조회 실패" : "확정 성과 확인 중"}</p>}</div></div>)}
        <p className="mt-2 text-[10px] text-slate-600">신호일별 최신 확정 단면 · 독립 표본 아님 · 모델 우열 판정 없음</p><button type="button" onClick={onOpenPerformance} className="tb-focus mt-2 rounded text-xs text-slate-600">5D / 20D 성과 →</button>
      </section>
      </div>
      <div className="min-w-0 space-y-3">
      <HomeTransitionCard transitions={transitions ?? null} eodError={dashboard.error} onSelectStock={onSelectStock} onOpenTransition={onOpenTransition} />
      <section className="tb-card min-w-0 p-4" aria-labelledby="home-operations-heading">
        <h2 id="home-operations-heading" className="text-base font-semibold">데이터 갱신 상태</h2>
        <p role="status" className="mt-2 text-sm font-semibold">{operations.error ? "운영 상태 조회 실패" : labels[operation]}</p>
        <ol className="mt-3 space-y-2 text-xs text-slate-700" aria-label="데이터 게시 단계">
          <li>1. 원본 확인 · {operations.data?.sourceStatus === "NO_NEW_DATA" ? "추가 원본 대기" : operations.data?.sourceStatus === "AVAILABLE" ? "원본 확인" : "확인 불가"}<br /><span className="text-slate-500">마지막 원본 조회 {time(operations.data?.lastSourceCheckAt)}</span></li>
          <li>2. 수집·검증 완료 · {operations.data?.latestValidatedReferenceDate ?? "미확인"}</li>
          <li>3. 저장소 게시 · {operations.data?.repositoryStatusAvailable ? operations.data.publishedReferenceDate ?? "미확인" : "확인 불가"}</li>
          <li>4. 실제 사이트 · {labels[currentOperations?.deployment?.state ?? "UNVERIFIED"] ?? "미확인"}</li>
        </ol>
        <dl className="mt-3 space-y-2 text-xs text-slate-700">
          <div><dt>마지막 정상 저장 데이터 / 현재 사이트 기준일</dt><dd>{operations.data?.lastGoodStoredReferenceDate ?? "확인 불가"} / {operations.data?.siteApiReferenceDate ?? "확인 불가"}</dd></div>
          <div><dt>마지막 실제 사이트 확인</dt><dd>{operations.data?.deployment?.lastVerified ? <><a className="tb-focus rounded underline" href={operations.data.deployment.lastVerified.runUrl} target="_blank" rel="noreferrer">{operations.data.deployment.lastVerified.referenceDate} 확인 기록</a><br />{time(operations.data.deployment.lastVerified.verifiedAt)}</> : "확인 기록 없음"}</dd></div>
          <div><dt>현재 배포·검증 사유</dt><dd className="break-words">{publicationReasonLabel(currentOperations?.deployment?.reason)}</dd></div>
          {operations.data?.latestAttempt && <div><dt>최근 실행 시도 (수동 포함)</dt><dd><a className="tb-focus rounded underline" href={operations.data.latestAttempt.runUrl} target="_blank" rel="noreferrer">{operations.data.latestAttempt.conclusion ?? operations.data.latestAttempt.status}</a> · {({ COLLECTION: "수집", VALIDATION: "검증", REPOSITORY: "저장소 게시", VERIFICATION: "사이트 확인", WORKFLOW: "실행 환경" } as Record<string, string>)[operations.data.latestAttempt.stage ?? ""] ?? "단계 확인 불가"}<br />{time(operations.data.latestAttempt.completedAt ?? operations.data.latestAttempt.startedAt)}</dd></div>}
          <div><dt>최근 수집 실패 사유</dt><dd className="break-words">{operations.data?.recentFailureReason ?? "기록 없음"}</dd></div>
        </dl>
        <p className="mt-3 text-[11px] text-slate-500">공공 원본은 다음 영업일 13시 이후 제공 안내가 있으며 도착 시각은 보장되지 않습니다. 휴장·미확정 거래일을 날짜 경과만으로 실패 처리하지 않습니다.</p>
        <details className="mt-3 text-xs text-slate-700"><summary className="tb-focus cursor-pointer rounded">상세 운영 정보</summary><dl className="mt-2 space-y-2">
          <div><dt>최신 원본 기준일 / 미반영 거래일</dt><dd>{operations.data?.latestConfirmedTradingDate ?? "확인 불가"} / {operations.data?.lagTradingDays ?? "미확인"}</dd></div>
          <div><dt>마지막 자동 실행</dt><dd>{time(operations.data?.lastAutomaticRunAt)} · {operations.data?.lastAutomaticRunConclusion ?? "미확인"}</dd></div>
          <div><dt>마지막 수집·저장 기록</dt><dd>{time(operations.data?.lastSuccessAt)}</dd></div>
          <div><dt>게시 증거 조회</dt><dd>{time(operations.data?.deployment?.checkedAt)} · GitHub 기록은 최대 10분 지연될 수 있음</dd></div>
        </dl><p className="mt-2">실제 사이트 확인은 홈·TOP·성과·운영 API의 최신 EOD 기준일·내용 해시와 배포 커밋을 함께 대조합니다. 저장 성공이나 날짜 일치만으로 확인 완료가 되지 않습니다.</p><p className="mt-2">KIS 잠정 EOD: 비공개 · 공개 연결 비활성. KOSPI/KOSDAQ/USD-KRW/거래대금: 미연결 · 숫자 미표시.</p></details>
      </section>
      <details className="tb-card p-3 text-xs text-slate-700"><summary className="tb-focus cursor-pointer rounded">LIVE 실행 시각 · 상태 상세</summary>
        <dl className="mt-2 space-y-2">
          <div><dt>예약 / runner 첫 단계 시작</dt><dd>{time(data?.liveStatus?.scheduledAt)} / {time(data?.liveStatus?.runnerFirstStepAt)}</dd></div>
          <div><dt>수집 스크립트 시작</dt><dd>{time(data?.liveStatus?.runStartedAt)}</dd></div>
          <div><dt>다음 GitHub 예약 (휴장 판정·지연 가능)</dt><dd>{time(data?.liveStatus?.nextScheduledAt)}</dd></div>
          <div><dt>마지막 정상 관측 완료</dt><dd>{time(live.data?.collectionCompletedAt ?? data?.liveStatus?.lastSuccessAt)}</dd></div>
          <div><dt>최근 artifact 저장 (게시 성공과 다름)</dt><dd>{time(data?.liveStatus?.storedAt)}</dd></div>
        </dl><p className="mt-2">GitHub 게시 및 Vercel API 확인 결과는 해당 Actions 실행 로그에서 별도로 검증합니다.</p>
        {localLive.data && <div className="mt-3 border-t border-slate-300/50 pt-3" aria-label="독립 실행기 로컬 비공개 조회">
          <p className="font-medium">독립 실행기 · 로컬 비공개</p>
          <p className="mt-1">{localLive.data.mode === "shadow" ? "현재시각 검증 · 14:00 LIVE 아님" : "14:00 LIVE · 독립 실행기 저장 관측"}</p>
          <p className="mt-1">{({ READY: "저장 결과 조회 가능", STORED: "저장 결과 조회 가능", PREPARED: "관측 준비 완료", COLLECTING: "수집 중", PARTIAL: "부분 수집 · 재시도 대기", FAILED: "실행 실패", MISSED: "관측창 놓침", MARKET_CLOSED: "휴장", NEW: "대기", WAITING: "대기", NO_OBSERVATION: "관측 기록 없음", UNAVAILABLE: "연결 또는 검증 불가" } as Record<string, string>)[localLive.data.status] ?? "상태 확인 불가"}</p>
          <dl className="mt-2 space-y-1">
            <div><dt>실제 수집 시작 / 완료</dt><dd>{time(localLive.data.collectionStartedAt)} / {time(localLive.data.collectionCompletedAt)}</dd></div>
            <div><dt>마지막 정상 저장 / 조회 검증</dt><dd>{time(localLive.data.lastSuccessAt ?? localLive.data.storedAt)} / {time(localLive.data.queryVerifiedAt)}</dd></div>
            {localLive.data.reason && <div><dt>실행 상태 코드</dt><dd className="break-words">{localLive.data.reason}</dd></div>}
          </dl>
          {localLive.data.models.length ? <div className="mt-2 grid min-w-0 gap-2 sm:grid-cols-2">{localLive.data.models.map((model) => <div key={model.model} className="min-w-0 rounded-lg bg-[#f7f3eb] p-2">
            <p className="font-medium">모델 {model.model} · {model.signalDate}</p>
            <ol className="mt-1 space-y-1">{model.records.map((row) => <li key={row.ticker} className="grid grid-cols-[1rem_minmax(0,1fr)_auto] items-center gap-1"><span>{row.rank}</span><span className="min-w-0">{stockButton({ code: row.ticker, name: row.companyName })}</span><span className="tabular-nums">{row.score.toFixed(2)}</span></li>)}</ol>
          </div>)}</div> : <p className="mt-2">조회 가능한 로컬 순위 없음</p>}
        </div>}
      </details>
      </div>
    </div>
  </section>;
}
