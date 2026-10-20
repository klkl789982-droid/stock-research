"use client";
import { useEffect, useRef, useState } from "react";
import { dailyOperationState, latestOneDayPerformance, publicationReasonLabel, homeOperationStatus } from "../lib/home-dashboard.mjs";
import HomeTransitionCard, { type HomeEodTransitions, type HomeTransitionNavigation } from "./HomeTransitionCard";
import { PrivateLiveDeliveryView, usePrivateLiveDelivery } from "./PrivateLiveDeliveryPanel";
import HomeModelRankings from "./HomeModelRankings";
import HomeCloudExecutionStatus, { cloudExecutionLabel, cloudExecutionWarning, type CloudExecutionResponse } from "./HomeCloudExecutionStatus";
import { homeDate, homeTime, homeDeploymentLabel } from "../lib/home-presentation.mjs";
type Stock = { code: string; name: string; market?: string };
type Ranked = Stock & { rank: number; score: number; previousRank?: number | null; rankChange?: number | null };
type Model = { modelVersion: string; rankingUniverseCount: number; top: Ranked[]; comparisonStatus?: string; previousDate?: string | null };
type LiveStatus = { status: string; signalDate: string | null; runStartedAt?: string | null; runnerFirstStepAt?: string | null; scheduledAt?: string | null; nextScheduledAt?: string | null; lastSuccessAt?: string | null; lastGoodDate?: string | null; storedAt?: string | null };
type Dashboard = { referenceDate: string | null; models: { referenceDate: string; models: Model[] } | null; transitions: HomeEodTransitions | null; calendar: { today: string; time: string; dayStatus: string; expectedTradingDate: string | null } | null; liveStatus: LiveStatus | null };
type PerformanceRow = { modelVersion: string; horizon: string; topN: number; signalDate: string; targetTradingDate: string | null; observationCount: number; meanReturn: number | null; positiveRate: number | null };
type Performance = { daily: PerformanceRow[]; live?: { daily: PerformanceRow[] } };
type Verification = { referenceDate: string; verifiedAt: string | null; runUrl: string; commitSha: string; snapshotHash: string };
type Operations = { latestAttempt?: { status: string; conclusion: string | null; stage: string | null; startedAt: string; completedAt: string | null; runUrl: string } | null; lastAutomaticRunAt?: string | null; lastAutomaticRunConclusion?: string | null; lastSuccessAt?: string | null; lastGoodStoredReferenceDate?: string | null; siteApiReferenceDate?: string | null; publishedReferenceDate?: string | null; latestConfirmedTradingDate?: string | null; latestCollectedReferenceDate?: string | null; latestValidatedReferenceDate?: string | null; lastSourceCheckAt?: string | null; sourceStatus?: string; recentFailureReason?: string | null; freshnessStatus?: string; repositoryPublicationStatus?: string; repositoryStatusAvailable?: boolean; siteApiMatchesPublished?: boolean; runStatus?: string; lagTradingDays?: number | null; deployment?: { state: string; reason: string | null; lastVerified: Verification | null; verification?: Verification | null; checkedAt?: string | null; intendedIdentity?: { referenceDate: string; snapshotHash: string; commitSha: string } | null } };
type OperationEvidence = Operations & { lastFailureAt?: string | null; lastAttemptAt?: string | null };
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
const pct = (v: number | null) => Number.isFinite(v) ? (Number(v) > 0 ? "+" : "") + Number(v).toFixed(2) + "%" : "미확인";
const time = homeTime;
export default function HomeDashboard({ onSelectStock, onOpenModel, onOpenPerformance, onOpenTransition }: {
  onSelectStock: (stock: Stock) => void | Promise<void>; onOpenModel: (model: string) => void; onOpenPerformance: () => void;
  onOpenTransition: HomeTransitionNavigation;
}) {
  const dashboard = useResource<Dashboard>("/api/home-dashboard?topN=5");
  const performance = useResource<Performance>("/api/model-performance");
  const operations = useResource<OperationEvidence>("/api/daily-production-status");
  const privateRelay = usePrivateLiveDelivery();
  const live = useResource<{ signalDate: string; collectionCompletedAt: string }>("/api/intraday-model-top?model=B&limit=1");
  const execution = useResource<CloudExecutionResponse>("/api/private-live-execution");
  const [source, setSource] = useState<"LIVE" | "EOD">("LIVE");
  const [operationsOpen, setOperationsOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const operationsButton = useRef<HTMLButtonElement | null>(null);
  const data = dashboard.data, transitions = data?.transitions;
  const delivery = privateRelay.data?.delivery;
  const fixture = privateRelay.data?.source === "privateRelayFixture";
  const outcome = performance.data ? latestOneDayPerformance(performance.data, 5) : null;
  const currentOperations = homeOperationStatus(operations.data, data, performance.data, { homeError: dashboard.error, performanceError: performance.error });
  const operation = dailyOperationState(currentOperations, data?.calendar);
  const failureLabel = (state: string) => operations.data?.repositoryStatusAvailable === false && ["FAILED", "PUBLICATION_FAILED"].includes(state)
    ? "저장 당시 " + labels[state] + " · 현재 실행 조회 불가" : labels[state];
  // Keep collection/publication failures visible even when deployment evidence
  // has its own pending/error state. Reuse the existing failure rules unchanged.
  const collectionOperation = dailyOperationState(currentOperations ? { ...currentOperations, deployment: undefined } : null, data?.calendar);
  const additionalEodFailure = ["FAILED", "PUBLICATION_FAILED"].includes(collectionOperation) && operation !== collectionOperation ? failureLabel(collectionOperation) : null;
  const operationLabel = operations.error ? "운영 상태 조회 실패" : ["DEPLOYING", "UNVERIFIED"].includes(operation) ? homeDeploymentLabel(currentOperations?.deployment) : failureLabel(operation) ?? "확인 불가";
  const warning = operations.error || Boolean(additionalEodFailure) || cloudExecutionWarning(execution) || ["FAILED", "PUBLICATION_FAILED", "DEPLOYMENT_FAILED", "VERIFICATION_FAILED", "DELAYED"].includes(operation);
  const liveReadLabel = privateRelay.failed ? "LIVE 조회 실패" : privateRelay.disabled ? "LIVE 전달 연결 비활성" : !privateRelay.data ? "LIVE 조회 중" : !delivery ? "LIVE 관측 대기 · 전달된 결과 없음" : fixture ? "합성 연결 검증 · 실제 관측 아님" : privateRelay.data.freshnessStatus === "HISTORICAL" ? "이전 날짜 저장 관측" : "조회 확인";
  const liveModels = delivery?.models.map(model => ({ modelVersion: model.modelVersion,
    top: model.records.map(row => ({ code: row.ticker, name: row.companyName, rank: row.rank, score: row.score })) })) ?? [];
  const renderPerformance = (layer: "daily" | "live") => <div className="home-performance-grid" aria-label={layer === "daily" ? "Daily 1D 모델 성과" : "과거 14:30 모델 성과"}>
    {outcome?.[layer].map(row => <div key={row.modelVersion} className="home-performance-cell"><span className="font-semibold">모델 {row.modelVersion[0]}</span>
      {row.observationCount ? <><strong className={"home-return " + (Number(row.meanReturn) > 0 ? "text-red-700" : Number(row.meanReturn) < 0 ? "text-blue-700" : "text-slate-700")}>{pct(row.meanReturn)}</strong><p>관측 {row.observationCount}건 · 신호일 1개</p><p>신호 {homeDate(row.signalDate)}<br />종료 {homeDate(row.resultDate)}</p></> : <p className="mt-2">집계 대기 · 표본 없음</p>}</div>)
      ?? <p className="col-span-full text-sm text-slate-600">{performance.error ? "성과 조회 실패" : "확정 성과 확인 중"}</p>}
  </div>;
  return <section className="home-dashboard space-y-5" aria-labelledby="home-dashboard-heading">
    <header className="home-intro"><h1 id="home-dashboard-heading" className="text-2xl font-semibold tracking-tight text-[var(--tb-navy)]">시장 요약</h1>
      <button ref={operationsButton} type="button" className="tb-focus home-secondary-button" aria-expanded={operationsOpen} aria-controls="home-operations-details" onClick={() => setOperationsOpen(!operationsOpen)}>운영 상세 <span aria-hidden="true">{operationsOpen ? "−" : "+"}</span></button>
      <p className="home-intro-description">저장된 분석에서 관심 종목의 근거를 확인하세요.</p>
    </header>
    <div className={"home-status-line " + (warning || privateRelay.failed ? "home-status-warning" : "")} aria-label="데이터 최신성 요약" role="status">
      <div className="home-status-results"><span><strong>저장된 LIVE 결과</strong> {fixture ? "합성 검증" : delivery ? homeDate(delivery.signalDate) + " · 14:00 KST" : privateRelay.data ? "없음" : "기준일 확인 불가"} · {liveReadLabel}</span>
        <span><strong>공식 EOD</strong> {homeDate(data?.referenceDate)} · {operationLabel}{additionalEodFailure ? " · " + additionalEodFailure : ""}</span></div>
      <p className="home-collection-status"><strong>현재 자동 수집 상태</strong> {cloudExecutionLabel(execution)}</p>
    </div>
    <section hidden={!operationsOpen} id="home-operations-details" className="home-surface home-operations" aria-labelledby="home-operations-heading" onKeyDown={event => { if (event.key === "Escape") { setOperationsOpen(false); operationsButton.current?.focus(); } }}>
      <h2 id="home-operations-heading" className="text-lg font-semibold">운영 상세</h2>
      <p className="mt-1 text-sm text-slate-600">저장된 LIVE 결과는 마지막 정상 전달 기록이며, 아래 오늘 Cloud 실행 상태와 별도입니다. 실행 기록의 확인 시각과 실제 관측 시각을 구분하며, 저장 결과가 있다고 오늘 수집이 정상이라고 판단하지 않습니다.</p>
      <HomeCloudExecutionStatus state={execution} lastDeliveryHash={delivery?.deliveryHash} />
      <div className="home-operation-columns">
        <section><h3 className="font-semibold">14:00 LIVE · 비공개 전달</h3><dl className="home-facts">
          <div><dt>현재 조회 상태</dt><dd>{liveReadLabel}</dd></div>
          <div><dt>분석 기준일·시각</dt><dd>{fixture ? "합성 자료 · 실제 관측 아님" : homeDate(delivery?.signalDate) + " 14:00 KST"}</dd></div>
          <div><dt>실제 관측 구간</dt><dd>{fixture ? "해당 없음" : time(delivery?.models[0]?.collectionStartedAt) + " ~ " + time(delivery?.models[0]?.collectionCompletedAt)}</dd></div>
          <div><dt>전달 파일 생성</dt><dd>{fixture ? "합성 검증" : time(delivery?.exportedAt)}</dd></div>
          <div><dt>마지막 사이트 조회</dt><dd>{time(privateRelay.data?.servedAt)}</dd></div>
        </dl><PrivateLiveDeliveryView {...privateRelay} integrityOnly /></section>
        <section><h3 className="font-semibold">공식 EOD 운영 상태 · {operationLabel}</h3>
          <ol className="home-pipeline" aria-label="데이터 게시 단계">
            <li><strong>1. 원본 확인</strong><p>{operations.data?.sourceStatus === "NO_NEW_DATA" ? "추가 원본 대기" : operations.data?.sourceStatus === "AVAILABLE" ? "원본 확인" : "확인 불가"} · 마지막 원본 조회 {time(operations.data?.lastSourceCheckAt)}</p></li>
            <li><strong>2. 수집·검증</strong><p>수집 {homeDate(operations.data?.latestCollectedReferenceDate)} · 수집·검증 완료 {homeDate(operations.data?.latestValidatedReferenceDate)}</p></li>
            <li><strong>3. 저장소 게시</strong><p>{operations.data?.repositoryStatusAvailable ? homeDate(operations.data.publishedReferenceDate) : "확인 불가"}</p></li>
            <li><strong>4. 실제 사이트</strong><p>{homeDeploymentLabel(currentOperations?.deployment)} · 기록 조회 {time(operations.data?.deployment?.checkedAt)}</p></li>
          </ol>
        </section>
      </div>
      <details className="home-detail"><summary className="tb-focus rounded">공식 EOD 검증 기록·실패 이유·출처</summary><dl className="home-facts">
        <div><dt>실행 상태 정보 출처</dt><dd>{!operations.data ? "조회 실패 또는 확인 중" : operations.data.repositoryStatusAvailable ? "저장소의 최신 실행 기록" : "현재 화면 배포에 포함된 과거 기록 · 최신 실행 조회 불가"} · 기록 시각 {time(operations.data?.lastAttemptAt)}</dd></div>
        <div><dt>마지막 정상 저장 데이터 / 현재 사이트 기준일</dt><dd>{homeDate(operations.data?.lastGoodStoredReferenceDate)} / {homeDate(operations.data?.siteApiReferenceDate)}</dd></div>
        <div><dt>마지막 실제 사이트 확인</dt><dd>{operations.data?.deployment?.lastVerified ? <><a className="tb-focus rounded underline" href={operations.data.deployment.lastVerified.runUrl} target="_blank" rel="noreferrer">{homeDate(operations.data.deployment.lastVerified.referenceDate)} 확인 기록</a> · {time(operations.data.deployment.lastVerified.verifiedAt)}</> : "확인 기록 없음"}</dd></div>
        <div><dt>현재 배포·검증 사유</dt><dd>{publicationReasonLabel(currentOperations?.deployment?.reason)}{currentOperations?.deployment?.state === "DEPLOYING" && currentOperations.deployment.reason !== "VERCEL_DEPLOYMENT_PENDING" ? " · 버전·내용 불일치만으로 실제 배포 진행 중이라고 판단하지 않습니다." : null}</dd></div>
        {operations.data?.latestAttempt && <div><dt>최근 실행 시도 (수동 포함)</dt><dd><a className="tb-focus rounded underline" href={operations.data.latestAttempt.runUrl} target="_blank" rel="noreferrer">{operations.data.latestAttempt.conclusion ?? operations.data.latestAttempt.status}</a> · {({ COLLECTION: "수집", VALIDATION: "검증", REPOSITORY: "저장소 게시", VERIFICATION: "사이트 확인", WORKFLOW: "실행 환경" } as Record<string, string>)[operations.data.latestAttempt.stage ?? ""] ?? "단계 확인 불가"} · {time(operations.data.latestAttempt.completedAt ?? operations.data.latestAttempt.startedAt)}</dd></div>}
        <div><dt>최근 수집 실패 사유</dt><dd>{operations.data?.recentFailureReason ?? "기록 없음"}{operations.data?.lastFailureAt ? " · 발생 " + time(operations.data.lastFailureAt) : ""}</dd></div>
        <div><dt>최신 원본 기준일 / 미반영 거래일</dt><dd>{homeDate(operations.data?.latestConfirmedTradingDate)} / {operations.data?.lagTradingDays ?? "미확인"}</dd></div>
        <div><dt>마지막 자동 실행</dt><dd>{time(operations.data?.lastAutomaticRunAt)} · {operations.data?.lastAutomaticRunConclusion ?? "미확인"}</dd></div>
        <div><dt>마지막 수집·저장 기록</dt><dd>{time(operations.data?.lastSuccessAt)}</dd></div>
        <div><dt>게시 증거 조회</dt><dd>{time(operations.data?.deployment?.checkedAt)} · GitHub 기록은 최대 10분 지연될 수 있음</dd></div>
        <div><dt>마지막 확인 데이터 해시 / 배포 버전</dt><dd>{operations.data?.deployment?.lastVerified?.snapshotHash ?? "확인 기록 없음"}<br />{operations.data?.deployment?.lastVerified?.commitSha ?? "확인 기록 없음"}</dd></div>
      </dl><p className="mt-3">실제 사이트 확인은 홈·TOP·성과·운영 API의 기준일·내용 해시와 배포 버전을 대조합니다. 저장 성공이나 날짜 일치만으로 확인 완료가 되지 않습니다.</p>
      <p className="mt-2">공공 원본은 다음 영업일 13시 이후 제공 안내가 있으며 도착 시각은 보장되지 않습니다. 휴장·미확정 거래일을 날짜 경과만으로 실패 처리하지 않습니다.</p>
      <p className="mt-2">KIS 잠정 EOD: 비공개 · 공개 연결 비활성. KOSPI/KOSDAQ/USD-KRW/거래대금: 미연결 · 숫자 미표시.</p></details>
    </section>

    <section className="home-surface" aria-label="모델 순위 비교">
      <div role="tablist" aria-label="분석 데이터 선택" className="home-source-tabs" onKeyDown={event => {
        if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) { event.preventDefault(); const next = event.key === "Home" ? "LIVE" : event.key === "End" ? "EOD" : source === "LIVE" ? "EOD" : "LIVE"; setSource(next); document.getElementById("home-source-" + next)?.focus(); }
      }}>
        {(["LIVE", "EOD"] as const).map(value => <button type="button" role="tab" key={value} id={"home-source-" + value} aria-selected={source === value} aria-controls={"home-panel-" + value} tabIndex={source === value ? 0 : -1} onClick={() => setSource(value)} className="tb-focus">{value === "LIVE" ? "14:00 LIVE" : "Daily EOD"}</button>)}
      </div>
      <div role="tabpanel" id="home-panel-LIVE" aria-labelledby="home-source-LIVE" hidden={source !== "LIVE"} className="home-source-panel">
        <div className="home-section-caption"><h2>모델별 TOP5 · {fixture ? "합성 연결 검증" : homeDate(delivery?.signalDate)}</h2><span>점수 단위: 점 / 100 · 수익률 아님</span></div>
        {fixture && <p className="home-inline-notice">합성 자료 · 실제 시세·정식 관측이 아닙니다. 성과 계산에 사용하지 않습니다.</p>}
        {privateRelay.data?.freshnessStatus === "HISTORICAL" && <p className="home-inline-notice">이전 날짜 저장 기록입니다. 현재 거래일의 정상 관측으로 표시하지 않습니다.</p>}
        {delivery ? <HomeModelRankings source="LIVE" models={liveModels} limit={5} onOpenModel={onOpenModel} onSelectStock={onSelectStock} /> : <div className="home-empty" role="status"><h3>{privateRelay.failed ? "LIVE 결과 조회 실패" : privateRelay.disabled ? "LIVE 전달 연결 비활성" : !privateRelay.data ? "LIVE 저장 결과 확인 중" : "14:00 관측 대기"}</h3><p>{privateRelay.failed ? "인증된 결과를 읽지 못했습니다. 운영 상세에서 확인하세요." : privateRelay.disabled ? "이 환경에는 비공개 조회 연결이 설정되지 않았습니다." : privateRelay.data ? "전달된 유효한 14:00 결과가 없습니다." : "조회가 끝나기 전에는 결과를 추정하지 않습니다."} Daily EOD로 자동 대체하지 않습니다.</p></div>}
      </div>
      <div role="tabpanel" id="home-panel-EOD" aria-labelledby="home-source-EOD" hidden={source !== "EOD"} className="home-source-panel">
        <div className="home-section-caption"><h2>모델 TOP3 · Daily EOD · {homeDate(data?.models?.referenceDate)}</h2><span>점수 단위: 점 / 100</span></div>
        {data?.models ? <HomeModelRankings source="EOD" models={data.models.models} limit={3} onOpenModel={onOpenModel} onSelectStock={onSelectStock} /> : <div className="home-empty" role="status"><h3>{dashboard.error ? "순위 조회 실패" : "검증 가능한 저장 순위 확인 중"}</h3><p>수치가 없는 종목에 임의 점수를 표시하지 않습니다.</p></div>}
      </div>
      <details className="home-ranking-note"><summary className="tb-focus rounded">모델 점수 해석과 주의사항</summary><p>장세별 설명은 산식의 특성에 따른 구분이며, 수익률 우위가 검증된 것은 아닙니다.</p><p>하락장에서는 네 모델 모두 신규 매수 판단에 주의가 필요합니다. 모델 점수는 상승 확률이나 매수 추천이 아닙니다.</p></details>
    </section>

    <section className="home-surface home-performance" aria-labelledby="home-performance-heading"><div className="home-section-caption"><h2 id="home-performance-heading">성과 요약 · TOP5</h2><button type="button" onClick={onOpenPerformance} className="tb-focus home-text-action">성과 상세 →</button></div>
      <h3 className="mt-4 font-medium">Daily 1D · 최신 확정 단면</h3>
      {renderPerformance("daily")}
      <details className="home-detail"><summary className="tb-focus rounded">평가 기간·진입/종료 기준</summary><p>Daily EOD · 신호일 공식 종가 → 다음 거래일 공식 종가. 실제 매수 체결 수익률이 아닙니다.</p><p>14:00 스윙 · 기록 생성 후 다음 확정 거래일 시가 → 진입일 포함 5번째 거래일 종가. 당일 진입 전략의 성과와 구분하며, 비용·체결 가정은 기존 미확정 상태를 유지합니다.</p><p>신호일별 최신 확정 단면 · 독립 표본 아님 · 모델 우열 판정 없음</p><button type="button" onClick={onOpenPerformance} className="tb-focus home-text-action mt-2">5D / 20D 성과 →</button></details>
      <div className="home-swing-pending"><h3 className="font-medium">14:00 스윙 · 5거래일</h3><p>A / B / C / D 모두 집계 대기 · 이 화면에 연결된 확정 성과가 없습니다. 예측 수치·기대수익률은 제공하지 않습니다.</p></div>
    </section>

    <section className="home-surface home-archive" aria-labelledby="home-archive-heading"><h2 id="home-archive-heading" className="text-lg font-semibold">과거 기록</h2>
      <details onToggle={event => setArchiveOpen(event.currentTarget.open)}><summary className="tb-focus rounded">과거 14:30 전환 분석</summary><p className="my-3 text-sm text-slate-600">기존 저장 관측의 과거 분석입니다. 새 14:00 결과가 아니며, 부분 수집·REJECTED 집계는 정상 최신 결과가 아닙니다.</p>{archiveOpen && <HomeTransitionCard transitions={transitions ?? null} eodError={dashboard.error} onSelectStock={onSelectStock} onOpenTransition={onOpenTransition} />}</details>
      <details><summary className="tb-focus rounded">과거 14:30 LIVE 성과 · 기존 별도 기준</summary><p className="mt-3 text-sm text-slate-600">14:30 동결 신호 → 다음 거래일 공식 시가 진입 → 해당 평가 거래일 종가. 1D는 진입일 종가 기준이며, 실제 체결·비용·슬리피지를 반영한 실현 성과가 아닙니다.</p>{renderPerformance("live")}<button type="button" onClick={onOpenPerformance} className="tb-focus home-text-action mt-3">성과 상세 (Daily·14:30) →</button></details>
      <details><summary className="tb-focus rounded">과거 14:30 실행 기록 · 운영 종료</summary><dl className="home-facts">
        <div><dt>예약 / runner 첫 단계 시작</dt><dd>{time(data?.liveStatus?.scheduledAt)} / {time(data?.liveStatus?.runnerFirstStepAt)}</dd></div>
        <div><dt>수집 스크립트 시작</dt><dd>{time(data?.liveStatus?.runStartedAt)}</dd></div>
        <div><dt>이전 GitHub 예약 정보 (현재 비활성)</dt><dd>{time(data?.liveStatus?.nextScheduledAt)}</dd></div>
        <div><dt>마지막 정상 관측 완료</dt><dd>{time(live.data?.collectionCompletedAt ?? data?.liveStatus?.lastSuccessAt)}</dd></div>
        <div><dt>최근 artifact 저장 (게시 성공과 다름)</dt><dd>{time(data?.liveStatus?.storedAt)}</dd></div>
      </dl><p className="mt-3 text-sm text-slate-600">저장·게시와 사이트 반영은 해당 실행 로그에서 별도로 확인합니다.</p></details>
    </section>
  </section>;
}
