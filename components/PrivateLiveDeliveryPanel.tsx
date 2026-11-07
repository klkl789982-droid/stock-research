"use client";
import { useEffect, useState } from "react";
import { homeTime } from "../lib/home-presentation.mjs";

type Model = { model: string; modelVersion: string; collectionStartedAt?: string; collectionCompletedAt?: string; records: { ticker: string; companyName: string; rank: number; score: number }[] };
export type LiveCoverage = { status: "COMPLETE" | "PARTIAL" | "WITHHELD"; targetCount: number; validCount: number;
  missing: { ticker: string; reason: string }[]; universeHash: string };
type Publication = LiveCoverage & { revision: number; previousDeliveryHash: string | null; firstIssuedAt: string };
export type Relay = { status: string; source: string; servedAt: string; freshnessStatus?: string; deliveryHash?: string;
  publicationTimes?: { firstPublishedAt: string; publishedAt: string } | null;
  delivery: { signalDate?: string; exportedAt?: string; deliveryHash?: string; sourceHash?: string; publication?: Publication; models: Model[] } | null };
export type PrivateRelayState = { data: Relay | null; failed: boolean; disabled: boolean };
export function privateRelaySummary(state: PrivateRelayState) {
  if (state.failed) return "조회 실패 · 최신 상태 미확인";
  if (state.disabled) return "전달 연결 비활성";
  if (state.data?.source === "privateRelayFixture") return "합성 연결 검증 · 실제 관측 아님";
  if (state.data?.delivery) return `저장 관측 · ${state.data.delivery.signalDate}${state.data.freshnessStatus === "HISTORICAL" ? " · 이전 날짜" : " · 최신성 별도 확인"}`;
  return state.data ? "관측 대기 · 전달된 결과 없음" : "인증된 전달 결과 확인 중";
}
const time = (value?: string) => homeTime(value);

const reasonLabels: Record<string,string> = {
  LIVE_CLOUD_RATE_EVIDENCE_INVALID: "요청·응답 시각 검증 실패", LIVE_CLOUD_OBSERVATION_MISSING: "관측 기록 없음",
  LIVE_CLOUD_OBSERVATION_INVALID: "관측값 검증 실패", DIAG_UNKNOWN_TRANSPORT_FAILURE: "통신 실패 · 세부 원인 미확인",
  DIAG_TRANSPORT_TIMEOUT: "응답 시간 초과", LIVE_CLOUD_CHILD_RESULT_MISSING: "수집 결과 없음",
  LIVE_CLOUD_ATTEMPT_ALREADY_RESERVED: "해당 종목 요청이 이미 예약됨", LIVE_CLOUD_CHILD_ERRORED: "종목 수집 작업 오류",
  LIVE_CLOUD_CHILD_TERMINATED: "종목 수집 작업 중단", LIVE_CLOUD_CHILD_NOT_COMPLETE: "종목 수집 완료 미확인",
  LIVE_CLOUD_QUOTE_DATE: "시세 기준일 불일치", LIVE_CLOUD_OBSERVATION_WINDOW: "허용 관측 시간 기준 미충족",
  DIAG_RATE_SLOT_MISSED: "배정된 요청 시각 경과", DIAG_COLLECTION_DEADLINE: "수집 마감 시각 경과", DIAG_RETRY_EXHAUSTED: "재시도 횟수 소진",
  DIAG_TRANSPORT_CONNECTION_RESET: "통신 연결 끊김", DIAG_TRANSPORT_DNS: "서버 주소 조회 실패",
  DIAG_TRANSPORT_SOCKET: "통신 연결 오류", DIAG_TRANSPORT_CONNECTION_REFUSED: "서버 연결 거부",
  KIS_BUSINESS_NETWORK_ERROR: "한국투자증권 통신 오류", KIS_INVALID_QUOTE: "시세 검증 실패", KIS_INVALID_OHLC: "시가·고가·저가·종가 검증 실패",
  KIS_RESPONSE_INVALID: "한국투자증권 응답 검증 실패", KIS_RATE_LIMITED: "한국투자증권 요청 한도 도달", KIS_SYMBOL_MISMATCH: "응답 종목 불일치",
  KIS_MINUTE_OBSERVATION_INVALID: "분봉 관측 검증 실패", KIS_MINUTE_OBSERVATION_TIMESTAMP_INVALID: "분봉 관측 시각 검증 실패",
  KIS_MINUTE_OBSERVATION_TIMESTAMP_MISSING: "분봉 관측 시각 누락",
};
function reasonLabel(reason: string) {
  return reasonLabels[reason] ?? (reason.startsWith("KIS_HTTP_") ? "한국투자증권 HTTP 오류 " + reason.slice(9) : "종목 수집 오류");
}
export function LiveCoverageSummary({ coverage, compact = false }: { coverage: LiveCoverage; compact?: boolean }) {
  const label = coverage.status === "COMPLETE" ? "확정 순위" : coverage.status === "PARTIAL" ? "잠정 순위" : "오늘 순위 게시 보류";
  const explanation = "정상 관측 종목으로 계산했습니다. 미반영 종목이 복구되면 순위가 달라질 수 있습니다.";
  return <div className={compact ? "flex flex-wrap items-baseline gap-x-2 gap-y-1" : "home-inline-notice"} role="status">
    <strong className={compact ? (coverage.status === "COMPLETE" ? "text-[var(--tb-blue-dark)]" : "text-amber-800") : undefined}>{label}</strong>
    <span className={compact ? undefined : "block"}>정상 {coverage.validCount} · 대상 {coverage.targetCount} · 미반영 {coverage.missing.length}</span>
    {!compact && coverage.status === "PARTIAL" && <p>{explanation}</p>}
    {coverage.missing.length > 0 && <details><summary className={compact ? "tb-focus cursor-pointer rounded text-[var(--tb-blue-dark)]" : undefined}>{compact ? "미반영 사유" : `미반영 종목과 사유 (${coverage.missing.length})`}</summary>
      {compact && coverage.status === "PARTIAL" && <p>{explanation}</p>}
      <ul>{coverage.missing.map(row => <li key={row.ticker}>{row.ticker} · {reasonLabel(row.reason)}</li>)}</ul>
    </details>}
  </div>;
}

export function PrivateLiveDeliveryView({ data, failed = false, disabled = false, integrityOnly = false }: { data: Relay | null; failed?: boolean; disabled?: boolean; integrityOnly?: boolean }) {
  const [probe, setProbe] = useState("idle");
  if (disabled) return null;
  const fixture = data?.source === "privateRelayFixture", delivery = data?.delivery;
  async function verifyReader() {
    setProbe("checking");
    try {
      const response = await fetch("/api/private-live-delivery", { method: "POST", cache: "no-store", headers: { "Content-Type": "application/json" }, body: '{"action":"verify-read-only"}' });
      const result = await response.json();
      setProbe(response.ok && result.permissionStatus === "READ_OK_WRITE_DENIED" && result.writeDenied === true ? "verified" : "failed");
    } catch { setProbe("failed"); }
  }
  const publication = delivery?.publication;
  const integrity = <details open={integrityOnly || undefined} className="mt-3 text-sm text-slate-700"><summary className="tb-focus cursor-pointer rounded">전달 무결성 확인</summary><p className="mt-2 break-all">SHA256 {data?.deliveryHash ?? delivery?.deliveryHash ?? "확인 불가"}</p><p className="mt-2 break-all">원본 식별 해시 {delivery?.sourceHash ?? "확인 기록 없음"}</p>
    {publication && <><p>발행 버전 r{publication.revision} · 최초 게시 {time(data?.publicationTimes?.firstPublishedAt)}{publication.revision > 1 && " · 수정 게시 " + time(data?.publicationTimes?.publishedAt)}</p>
      <p>최초 파일 생성 {time(publication.firstIssuedAt)} · 이 버전 파일 생성 {time(delivery?.exportedAt)}</p>
      <p className="break-all">고정 대상 해시 {publication.universeHash}</p>{publication.previousDeliveryHash && <p className="break-all">직전 발행 해시 {publication.previousDeliveryHash}</p>}</>}
    <p>인증 API 조회 시각 {time(data?.servedAt)} · 관측 시각과 다름</p></details>;
  const readerProbe = fixture && <div className="mt-3 text-sm"><button type="button" disabled={probe === "checking" || probe === "verified"} onClick={() => void verifyReader()} className="tb-focus rounded border px-3 py-2 disabled:opacity-60">읽기 전용 권한 검증</button><p role="status" className="mt-1 text-slate-600">{probe === "verified" ? "원격 읽기·해시 일치 / 테스트 쓰기 403 차단 확인" : probe === "checking" ? "테스트 경로에서만 권한 확인 중" : probe === "failed" ? "읽기 전용 권한 미검증 · 설정 확인 필요" : "합성 테스트 경로에 1회 생성 요청을 보내 쓰기 거부를 확인합니다. 운영 경로는 변경하지 않습니다."}</p></div>;
  if (integrityOnly) return <div aria-label="비공개 전달 무결성">{integrity}{readerProbe}</div>;
  return <section className="tb-card min-w-0 p-4" aria-label="비공개 저장소 전달 결과">
    <h2 className="text-base font-semibold">{fixture ? "합성 자료 · 비공개 연결 검증" : "비공개 LIVE 저장 순위 · 14:00"}</h2>
    {!delivery ? <p role="status" className="mt-2 text-sm text-slate-600">{failed ? "비공개 결과 조회 실패 · 마지막 결과와 최신 상태를 확인할 수 없습니다." : data ? "아직 전달된 14:00 관측 결과가 없습니다. 운영 연결·관측 대기 중입니다." : "인증된 저장 결과 확인 중"}</p> : <>
      <p className="mt-1 text-xs text-slate-600">{fixture ? "실제 시세·모델 순위·14:00 관측이 아닙니다. 공식 EOD와 성과 계산에 사용하지 않습니다." : `관측 기준일 ${delivery.signalDate} · ${data?.freshnessStatus === "HISTORICAL" ? "이전 날짜 저장 기록 · 현재 거래일의 정상 관측으로 표시하지 않습니다." : "저장된 관측 결과 · 거래일 최신성은 별도 확인이 필요합니다."}`}</p>
      {!fixture && <dl className="mt-2 grid gap-1 text-xs text-slate-600 sm:grid-cols-2"><div><dt>분석 기준</dt><dd>{delivery.signalDate} 14:00 KST</dd></div><div><dt>실제 관측 구간</dt><dd>{time(delivery.models[0]?.collectionStartedAt)} ~ {time(delivery.models[0]?.collectionCompletedAt)}</dd></div><div><dt>전달 파일 생성</dt><dd>{time(delivery.exportedAt)}</dd></div><div><dt>사이트 조회</dt><dd>{time(data?.servedAt)}</dd></div></dl>}
      {publication && <LiveCoverageSummary coverage={publication}/>}
      <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">{delivery.models.map(model => <article key={model.model} className="min-w-0 rounded-xl bg-[var(--tb-page)] p-3"><h3 className="text-sm font-semibold">{model.model} · TOP5</h3><ol className="mt-2 space-y-2 text-xs">{model.records.map(row => <li key={row.ticker} className="flex justify-between gap-2"><span className="min-w-0 break-words">{row.rank}. {row.companyName}<span className="block text-slate-500">{row.ticker}</span></span><span className="tabular-nums">{row.score.toFixed(2)}</span></li>)}</ol></article>)}</div>
      {integrity}{readerProbe}
    </>}
  </section>;
}

export function usePrivateLiveDelivery(enabled = true) {
  const [state, setState] = useState<PrivateRelayState>({ data: null, failed: false, disabled: false });
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController(); let busy = false, lastStartedAt: number | null = null;
    async function load() {
      if (document.hidden || busy || (lastStartedAt !== null && Date.now() - lastStartedAt < 60_000)) return;
      busy = true; lastStartedAt = Date.now();
      try {
        const response = await fetch("/api/private-live-delivery", { cache: "no-store", signal: controller.signal });
        if (!response.ok) { if (!controller.signal.aborted) setState({ data: null, failed: response.status !== 404, disabled: response.status === 404 }); return; }
        const data = await response.json();
        if (!controller.signal.aborted) setState({ data, failed: false, disabled: false });
      } catch { if (!controller.signal.aborted) setState({ data: null, failed: true, disabled: false }); }
      finally { busy = false; }
    }
    void load(); const timer = setInterval(load, 60_000);
    document.addEventListener("visibilitychange", load);
    return () => { controller.abort(); clearInterval(timer); document.removeEventListener("visibilitychange", load); };
  }, [enabled]);
  return state;
}
export default function PrivateLiveDeliveryPanel({ state }: { state?: PrivateRelayState }) {
  const local = usePrivateLiveDelivery(!state);
  return <PrivateLiveDeliveryView {...state ?? local} />;
}
