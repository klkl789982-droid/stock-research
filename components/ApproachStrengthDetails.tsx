import { approachPolicy } from "../lib/directional-transition.mjs";

export type StrengthObservation = { status: string; crossDirection: string; approachStrength: number | null; scoreVersion?: string; gapPercent: number; previousGapPercent?: number; shortSlopePercent?: number | null; longSlopePercent?: number | null; components?: Record<string, number> | null };
const number = (v?: number | null, suffix = "") => Number.isFinite(v) ? Number(v).toFixed(2) + suffix : "미확인";
const labels: Record<string, string> = { proximity: "이평선 간격", contraction: "간격 축소 속도", shortSlope: "단기선 기울기", longSlope: "장기선 기울기", persistence: "간격 축소 지속성", priceAlignment: "가격 위치" };
export default function ApproachStrengthDetails({ row }: { row: StrengthObservation }) {
  if (row.status !== "APPROACHING") return <p className="mt-2 text-xs text-slate-600">접근 강도는 접근 상태에서만 계산합니다.</p>;
  const verified = row.scoreVersion === approachPolicy.version && row.components && Object.keys(approachPolicy.weights).every((key) => Number.isFinite(row.components?.[key]) && row.components![key] >= 0 && row.components![key] <= 1) && Number.isFinite(row.approachStrength);
  return <details className="mt-2 text-xs text-slate-700"><summary className="tb-focus cursor-pointer rounded">{row.crossDirection === "dead" ? "데드" : "골든"} 접근 점수 상세</summary>
    <p className="mt-2">연구용 상대 강도 · 교차 발생/매수 성공 확률이 아닙니다.</p>
    <p className="mt-1">버전 {row.scoreVersion ?? "미확인"}</p>
    {verified ? <dl className="mt-2 space-y-1">{Object.entries(approachPolicy.weights).map(([key, weight]) => <div key={key} className="flex justify-between gap-2"><dt>{labels[key]}{key === "proximity" ? ` (${number(row.gapPercent, "%")})` : key === "contraction" ? ` (${number(Math.abs(row.previousGapPercent ?? NaN) - Math.abs(row.gapPercent), "%p/거래일")})` : key === "shortSlope" ? ` (${number(row.shortSlopePercent, "%")})` : key === "longSlope" ? ` (${number(row.longSlopePercent, "%")})` : key === "persistence" ? ` (${number(row.components!.persistence * 100, "%")}, 최근 5회)` : " (종가/단기선 위치 정규화)"}</dt><dd className="shrink-0 tabular-nums">{number(row.components![key] * weight)} / {weight}점</dd></div>)}</dl> : <p className="mt-2">계산 기여 자료 미확인 · 임의 기여값을 표시하지 않습니다.</p>}
  </details>;
}
