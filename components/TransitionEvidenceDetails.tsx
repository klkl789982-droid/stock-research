import { evidenceLabels } from "../lib/transition-evidence-policy.mjs";

type EvidenceStatus = "MET" | "PARTIAL" | "NOT_MET" | "DATA_MISSING";
export type UpwardEvidence = {
  version: string; configHash: string; fulfilledCount: number; evaluableCount: number;
  categories: Record<"gap" | "trend" | "momentum" | "volume", { status: EvidenceStatus; reason: string; metrics: Record<string, number | string | null> }>;
  breakout: { status: EvidenceStatus; lookback: number; priorHigh: number | null };
};
const titles = { gap: "이평선 간격 개선", trend: "단기 추세 개선", momentum: "모멘텀 개선", volume: "상승 거래량 동반" };
const metricLabels: Record<string, string> = { gapPercent: "현재 간격 (%)", previousGapPercent: "직전 간격 (%)", shrinkPercentPoints: "간격 축소 (%p)", shrinkingTransitions: "연속 검토 구간 내 축소 횟수", requiredTransitions: "검토 구간 (거래일)", phase: "상태", shortSlopePercent: "단기 기울기 (%)", previousShortSlopePercent: "직전 단기 기울기 (%)", slopeChangePercentPoints: "기울기 변화 (%p)", longSlopePercent: "장기 기울기 (%)", rsi: "RSI14", rsiChange: "RSI 변화 (점)", macd: "MACD", signal: "Signal", histogram: "히스토그램", previousHistogram: "직전 히스토그램", histogramChange: "히스토그램 변화", volumeMultiple: "평균 거래량 대비 배율", volumeGrowthPercent: "전일 대비 거래량 (%)", priceChangePercent: "전일 대비 종가 (%)" };
const phases: Record<string, string> = { ALREADY_AT_OR_ABOVE: "장기선 이상 · 접근 아님", BELOW: "장기선 아래", UNKNOWN: "확인 불가", TURNED_UP: "상승 기울기로 전환", RISING: "상승 기울기", DECLINE_SLOWING: "하락 속도 둔화", DECLINING: "하락 지속", FLAT: "보합 기울기" };
const valueText = (value: number | string | null) => value === null ? "데이터 부족" : typeof value === "number" ? Number.isFinite(value) ? value.toFixed(2) : "데이터 부족" : phases[value] ?? value;
export const evidenceCountText = (evidence?: UpwardEvidence | null) => evidence ? `${evidence.fulfilledCount}/4 충족 · ${evidence.evaluableCount}/4 평가 가능` : "상승 근거 확인 불가";

export default function TransitionEvidenceDetails({ evidence }: { evidence?: UpwardEvidence | null }) {
  if (!evidence) return <p className="text-xs text-slate-600">상승 근거 확인 불가</p>;
  return <details className="relative mt-2 text-xs text-slate-700">
    <summary className="tb-focus w-fit cursor-pointer rounded">상승 근거 상세 · {evidenceCountText(evidence)}</summary>
    <p className="mt-2">골든·데드 접근 강도와 독립적인 상승 근거입니다. 부분 충족은 충족 수에 포함하지 않으며, 데이터 부족은 미충족으로 간주하지 않습니다.</p>
    <div className="mt-2 space-y-3">{(Object.keys(titles) as (keyof typeof titles)[]).map((key) => {
      const category = evidence.categories[key];
      return <section key={key} className="rounded border border-slate-200/80 bg-amber-50/30 p-2"><h4 className="font-medium">{titles[key]} · {evidenceLabels[category.status]}</h4><p className="mt-1 leading-relaxed">{category.reason}</p><dl className="mt-2 grid grid-cols-1 gap-1 sm:grid-cols-2">{Object.entries(category.metrics).map(([metric, value]) => <div key={metric}><dt className="text-slate-600">{metricLabels[metric] ?? metric}</dt><dd className="tabular-nums">{valueText(value)}</dd></div>)}</dl></section>;
    })}</div>
    <p className="mt-2">보조 정보: 직전 {evidence.breakout.lookback}거래일 고가 돌파 {evidenceLabels[evidence.breakout.status]} · 네 가지 근거 수 및 프리셋 필수 조건에 포함하지 않습니다.</p>
    <p className="mt-2 break-all text-[10px] text-slate-600">{evidence.version} · 설정 SHA256 {evidence.configHash}</p>
  </details>;
}
