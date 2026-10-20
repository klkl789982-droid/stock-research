import { homeDate, homeTime } from "../lib/home-presentation.mjs";

type Phase = "SUCCEEDED" | "FAILED" | "BLOCKED" | "RUNNING" | "PENDING" | "UNKNOWN";
type ExecutionRecord = { signalDate: string; runId: string; recordedAt: string; recordHash: string; status: string; event: string;
  error: { code: string; stage: string } | null;
  input: { initialReady: boolean; finalReady: boolean; seedReferenceDate: string | null; checkedAt: string | null; initialReadyAt: string | null; finalReadyAt: string | null };
  collection: { expected: number; eligible: number | null; available: number; excluded: number; failed: number; missing: number; requiredMissing: number | null; activeLeases: number; firstRequestedAt: string | null; lastReceivedAt: string | null };
  validation: { outboxFrozen: boolean; deliveryHash: string | null; frozenAt: string | null };
  delivery: { verified: boolean; deliveryHash: string | null };
  stages: { preparation: Phase; collection: Phase; validation: Phase; delivery: Phase };
};
export type CloudExecutionResponse = { status: string; targetDate: string; servedAt: string; record: ExecutionRecord | null };
type State = { data: CloudExecutionResponse | null; error: boolean };
const labels: Record<Phase, string> = { SUCCEEDED: "완료", FAILED: "실패", BLOCKED: "차단", RUNNING: "진행 확인", PENDING: "대기", UNKNOWN: "확인 불가" };
const reasons: Record<string, string> = { LIVE_CLOUD_SQL_BUDGET: "저장 처리 예산 초과", LIVE_CLOUD_INPUT_NOT_READY: "필수 EOD 입력 미준비",
  LIVE_CLOUD_INCOMPLETE: "관측 기록 부족", LIVE_CLOUD_REQUIRED_INPUT_MISSING: "필수 종목 입력 미충족", LIVE_CLOUD_OBSERVATION_WINDOW: "관측 시간 기준 미충족",
  PRIVATE_STORE_NETWORK_FAILED: "비공개 저장소 연결 실패", PRIVATE_STORE_AUTHORIZATION_FAILED: "비공개 저장소 권한 확인 필요", LIVE_CLOUD_WINDOW_EXPIRED: "관측 시간 종료" };
export function cloudExecutionLabel(state: State) {
  if (state.error) return "실행 기록 조회 실패 · 마지막 정상 결과와 별도";
  if (!state.data) return "실행 기록 조회 중";
  const record=state.data.record;
  if (!record) return `${homeDate(state.data.targetDate)} · 오늘 실행 기록 없음 · 실행 여부 미확인`;
  const prefix=homeDate(record.signalDate)+" · ";
  if (record.status === "SUCCEEDED") return prefix+"수집·검증·비공개 전달 완료";
  if (record.status === "STALE") return prefix+"관측창 종료 · 최종 결과 미확인";
  if (record.status === "BLOCKED") return prefix+"필수 입력 확인 미완료 · 수집 차단";
  if (record.status === "FAILED") return prefix+"실행 실패"+(record.error ? " · "+(reasons[record.error.code]??"실행 오류 · 운영 상세 확인") : "");
  if (!record.input.finalReady) return prefix+"최종 입력 확인 대기";
  return prefix+(record.validation.outboxFrozen ? "검증 완료 · 전달 확인 대기" : record.stages.collection === "RUNNING" ? "수집 진행 기록" : "준비 완료 · 수집 확인 대기");
}
export function cloudExecutionWarning(state: State) { return state.error || ["FAILED","BLOCKED","STALE"].includes(state.data?.record?.status ?? ""); }

export default function HomeCloudExecutionStatus({ state, lastDeliveryHash }: { state: State; lastDeliveryHash?: string }) {
  const response=state.data,record=response?.record;
  return <section aria-label="오늘 Cloud 자동 실행 기록" className="border-t border-slate-200 pt-4 mt-4">
    <h3 className="font-semibold">오늘 자동 수집 · {homeDate(response?.targetDate)}</h3>
    <p className="mt-2 text-sm">{cloudExecutionLabel(state)}</p>
    {!record ? <p className="mt-2 text-sm text-slate-600">{state.error ? "실행 기록 저장소를 읽지 못했습니다. 성공·실패를 추정하지 않습니다." : "오늘 Cloud 실행의 확인 가능한 기록이 아직 없습니다. 휴장·예약 누락·조회 지연을 임의로 구분하지 않습니다."} 이전 날짜의 정상 LIVE 순위는 별도로 보존합니다.</p> : <>
      <p className="mt-1 text-sm text-slate-600">Cloud 실행 상태 확인 {homeTime(record.recordedAt)} · 사이트 조회 {homeTime(response?.servedAt)} · 실시간 진행률 아님</p>
      <ol className="home-pipeline" aria-label="Cloud 실행 단계">
        <li><strong>1. 준비 · {labels[record.stages.preparation]}</strong><p>EOD {homeDate(record.input.seedReferenceDate)} · 최종 입력 확인 {homeTime(record.input.checkedAt)}</p><p>초기 준비 {record.input.initialReady ? homeTime(record.input.initialReadyAt) : "완료 기록 없음"} · 13:59 재확인 {record.input.finalReady ? "완료" : "미완료"}</p></li>
        <li><strong>2. 수집 · {labels[record.stages.collection]}</strong><p>영속 확인 {record.collection.available+record.collection.excluded+record.collection.failed}/{record.collection.expected}종목 · 유효 {record.collection.available} · 제외 {record.collection.excluded} · 실패 기록 {record.collection.failed} · 누락 {record.collection.missing}</p><p>필수 적격 {record.collection.eligible ?? "미확인"}종목 · 필수 미충족 {record.collection.requiredMissing ?? "미확인"}</p><p>보존된 요청·응답 시각 {homeTime(record.collection.firstRequestedAt)} ~ {homeTime(record.collection.lastReceivedAt)}</p></li>
        <li><strong>3. 검증·계산 · {labels[record.stages.validation]}</strong><p>{record.validation.outboxFrozen ? "전체 품질 기준 통과 · 순위와 전달 내용 고정" : "정상 순위·전달 파일 확정 기록 없음"}</p></li>
        <li><strong>4. 비공개 전달 · {labels[record.stages.delivery]}</strong><p>{record.delivery.verified ? record.delivery.deliveryHash===lastDeliveryHash ? "비공개 저장 확인 · 현재 홈의 저장 결과와 해시 일치" : "비공개 저장 확인 · 홈 저장 결과와 대조 대기" : "당일 정상 결과의 전달 완료 기록 없음"}</p></li>
      </ol>
      <details className="home-detail"><summary className="tb-focus rounded">실행 오류·출처·무결성</summary><p>출처: Cloud의 영속 실행 상태 · {record.runId}</p><p>오류: {record.error ? `${reasons[record.error.code]??"실행 오류"} · ${record.error.code} · 단계 ${record.error.stage}` : "이 기록에 오류 코드 없음 · 성공 판정과 별도"}</p><p className="break-all">실행 기록 SHA256 {record.recordHash}</p><p>해시는 서버에서 검증합니다. 관측 누락이 있으면 원래 시간 안에 수신됐다고 추정하거나 정상 결과로 대체하지 않습니다.</p></details>
    </>}
  </section>;
}
