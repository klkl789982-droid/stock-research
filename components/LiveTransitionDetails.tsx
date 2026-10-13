"use client";

export type TransitionMode = "LIVE" | "EOD";
export type LiveTransitionStatus = "CROSS_OCCURRED" | "APPROACHING" | "ALREADY_ABOVE" | "NONE";
export type LiveTransitionRow = {
  code: string;
  name: string;
  market: string;
  referenceDate: string;
  modelReferenceDate: string;
  qualityStatus: "PROVISIONAL";
  missingReasons: string[];
  models: Record<string, { score: number | null; rank?: number | null }>;
  observedPrice: number;
  quoteAsOfDate: string;
  quoteAsOfTime: string;
  receivedAt: string;
  pair: string;
  status: LiveTransitionStatus;
  gapPercent: number | null;
  previousGapPercent: number | null;
  shortSlopePercent: number | null;
  currentShort: number | null;
  currentLong: number | null;
  previousShort: number | null;
  previousLong: number | null;
  crossRequiredPrice: number | null;
  requiredAdditionalRisePercent: number | null;
};
export type LiveTransitionResponse = {
  mode: "LIVE";
  referenceDate: string;
  previousOfficialDate: string;
  modelReferenceDate: string;
  snapshotTime: string;
  collectionStartedAt: string | null;
  collectionCompletedAt: string | null;
  ruleVersion: string;
  nearPercent: number;
  totalUniverse: number;
  indicatorCoverage: number;
  quarantinedCount: number | null;
  sourceQualityGrade: string;
  isPartialRanking: boolean;
  resultCount: number;
  results: LiveTransitionRow[];
  exclusions: { dataMissing: number; conditionNotMet: number };
  reasonCounts: Record<string, number>;
  source: unknown;
};

export const liveStatusLabel = (status: LiveTransitionStatus) => ({
  CROSS_OCCURRED: "골든크로스 진입 · 잠정",
  APPROACHING: "근접 후보 · 잠정",
  ALREADY_ABOVE: "기존 상단 유지",
  NONE: "조건 미충족",
})[status];
export const liveNumber = (value: number | null | undefined, suffix = "") => typeof value === "number" && Number.isFinite(value) ? `${value.toFixed(2)}${suffix}` : "미확인";
export const livePrice = (value: number | null | undefined, fractionDigits = 0) => typeof value === "number" && Number.isFinite(value) ? `${value.toLocaleString("ko-KR", { maximumFractionDigits: fractionDigits })}원` : "미확인";
export const liveDate = (value: string) => value.replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3");
export const liveTime = (value: string) => value.replace(/^(\d{2})(\d{2})(\d{2})$/, "$1:$2:$3");
export const liveQuoteStamp = (row: LiveTransitionRow) => `${liveDate(row.quoteAsOfDate)} ${liveTime(row.quoteAsOfTime)} KST`;
const collectionStamp = (value: string | null) => {
  if (!value) return "미확인";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : `${new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(date)} KST`;
};

export function TransitionModeSelector({ mode, onChange, label = "전환 신호 데이터 기준" }: { mode: TransitionMode; onChange: (mode: TransitionMode) => void; label?: string }) {
  return <div role="group" aria-label={label} className="flex flex-wrap gap-2">
    {([ ["LIVE", "LIVE · 14:30 저장 관측"], ["EOD", "EOD · 확정 일봉 비교"] ] as const).map(([value, title]) => <button key={value} type="button" aria-pressed={mode === value} onClick={() => onChange(value)} className={`tb-focus min-h-10 rounded-lg border px-3 py-2 text-xs font-semibold sm:text-sm ${mode === value ? "border-slate-900 bg-slate-900 text-white" : "border-slate-200 bg-white text-slate-700 hover:bg-slate-100"}`}>{title}</button>)}
  </div>;
}

export function LiveTransitionRules({ nearPercent }: { nearPercent: number }) {
  return <details className="mt-3 text-xs leading-relaxed text-slate-600">
    <summary className="tb-focus w-fit cursor-pointer rounded">잠정 판정 · 근접 조건 · 가격 경계 해석</summary>
    <p className="mt-2">직전 확정 일봉까지의 종가에 관측가를 당일 값으로 한 번 추가해 단순이동평균을 계산합니다. 골든크로스 진입은 직전 단기선 ≤ 장기선, 현재 단기선 &gt; 장기선인 경우입니다. 직전부터 위에 있던 종목은 기존 상단 유지로 구분합니다.</p>
    <p className="mt-2">근접 후보는 직전 단기선 ≤ 장기선, 현재 단기선 &lt; 장기선, 간격 축소, 양의 단기선 기울기를 모두 만족하고 교차 경계까지 필요한 추가 상승률이 {nearPercent}% 이하인 경우입니다. 0~5% 범위의 탐색 조건이며 통계 검증된 교차·상승 확률이 아닙니다. 경계와 정확히 같은 값은 교차로 판정하지 않습니다.</p>
    <p className="mt-2">교차 경계가는 두 이동평균이 같아지는 가격입니다. 엄격 교차는 관측가 &gt; 원래 계산된 경계가여야 합니다. 표시 경계가는 참고용 반올림 값이며 주문 가능한 최소 가격이 아닙니다. 필요 추가 상승률은 max(0, (경계가/관측가−1)×100)입니다.</p>
    <p className="mt-2">LIVE는 TOP LIVE의 저장된 14:30 관측 스냅샷이며 실시간 스트리밍이 아닙니다. 종목별 실제 시세 시각을 확인하세요. 장중 신호는 이후 또는 종가에서 되돌아갈 수 있습니다. 매수 추천·수익 예측이 아닙니다.</p>
  </details>;
}

export function LiveTransitionMetadata({ data }: { data: LiveTransitionResponse }) {
  return <div className="mt-2 space-y-1 text-xs text-slate-600">
    <p>관측 기준일 {liveDate(data.referenceDate)} · TOP LIVE {liveTime(data.snapshotTime)} KST 저장 스냅샷</p>
    <p>직전 확정 일봉 {liveDate(data.previousOfficialDate)} · 저장 모델 A~D 기준일 {liveDate(data.modelReferenceDate)}</p>
    <p>계산 가능 {data.indicatorCoverage}/{data.totalUniverse} · 격리 {data.quarantinedCount ?? "미확인"} · 원천 품질 {data.sourceQualityGrade} · {data.isPartialRanking ? "부분 집계" : "저장 집계"}</p>
    <details><summary className="tb-focus w-fit cursor-pointer rounded">수집 시각 · 규칙</summary><p className="mt-1">수집 시작 {collectionStamp(data.collectionStartedAt)}<br />수집 완료 {collectionStamp(data.collectionCompletedAt)}<br />규칙 {data.ruleVersion}</p></details>
  </div>;
}

export function LiveTransitionMetrics({ row }: { row: LiveTransitionRow }) {
  return <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
    <div><dt className="text-slate-500">관측가</dt><dd className="mt-0.5 font-semibold tabular-nums text-slate-900">{livePrice(row.observedPrice)}</dd></div>
    <div><dt className="text-slate-500">필요 추가 상승률</dt><dd className="mt-0.5 font-semibold tabular-nums text-slate-900">{liveNumber(row.requiredAdditionalRisePercent, "%")}</dd></div>
    <div className="col-span-2"><dt className="text-slate-500">교차 경계가 초과</dt><dd className="mt-0.5 tabular-nums text-slate-900">{row.crossRequiredPrice === null ? "미확인" : `약 ${livePrice(row.crossRequiredPrice, 4)} 초과 (참고 경계)`}</dd></div>
    <div><dt className="text-slate-500">현재 이평선 간격</dt><dd className="mt-0.5 tabular-nums text-slate-800">{liveNumber(row.gapPercent, "%")}</dd></div>
    <div><dt className="text-slate-500">직전 이평선 간격</dt><dd className="mt-0.5 tabular-nums text-slate-800">{liveNumber(row.previousGapPercent, "%")}</dd></div>
    <div className="col-span-2"><dt className="text-slate-500">단기선 기울기 · 직전 확정값 대비</dt><dd className="mt-0.5 tabular-nums text-slate-800">{liveNumber(row.shortSlopePercent, "%")}</dd></div>
  </dl>;
}
