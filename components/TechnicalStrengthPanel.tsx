import { analysisAvailabilityMessage } from "../lib/analysis-availability.mjs";

type TechnicalStrengthView = {
  status: string;
  modelVersion: string;
  reason?: string;
  score?: number;
  validationStatus?: string;
  historicalAsOfDate?: string | null;
  realtimeStatus?: string;
  realtimeApplied?: boolean;
  realtimeAsOfDate?: string | null;
  realtimeAsOfTime?: string | null;
  realtimeSource?: string | null;
  outsideDisplayRange?: boolean;
};

const formatDate = (value?: string | null) => value && /^\d{8}$/u.test(value)
  ? `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`
  : value;

export default function TechnicalStrengthPanel({ view }: { view: TechnicalStrengthView }) {
  return (
    <div className="mt-5 rounded-xl border border-gray-200 bg-white p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm text-gray-500">기술적 강도</p>
          {view.status === "available" ? (
            <p className="mt-1"><span className="text-3xl font-bold text-gray-900">{view.score}</span><span className="text-sm text-gray-500"> / 100</span></p>
          ) : (
            <p className="mt-1 text-sm font-semibold text-gray-700">
              {view.status === "loading" ? "계산 준비 중" : analysisAvailabilityMessage(view.reason)}
            </p>
          )}
        </div>
        <span className="rounded-full bg-amber-50 px-2.5 py-1 text-xs font-semibold text-amber-700">{view.modelVersion} · 검증 진행 중</span>
      </div>
      {view.status === "available" && (
        <div className="mt-3 space-y-1 text-xs text-gray-500">
          <p>공식 일봉 기준일 {formatDate(view.historicalAsOfDate)}</p>
          <p>{view.realtimeApplied
            ? `현재가 적용 · ${view.realtimeSource ?? "출처 미제공"} · ${view.realtimeAsOfDate ?? "기준일 미제공"}${view.realtimeAsOfTime ? ` ${view.realtimeAsOfTime}` : ""}`
            : view.realtimeStatus === "staleIgnored"
              ? "오래된 현재가는 제외하고 공식 일봉으로 계산"
              : view.realtimeStatus === "invalidMetadata"
                ? "기준시점이 불완전한 현재가는 제외하고 공식 일봉으로 계산"
                : "현재가 미적용 · 공식 일봉으로 계산"}</p>
          {view.outsideDisplayRange && <p className="text-amber-700">A-v1 기준선의 원점수이며 0~100 clamp를 적용하지 않았습니다.</p>}
        </div>
      )}
    </div>
  );
}
