"use client";

import { analysisAvailabilityMessage } from "../../lib/analysis-availability.mjs";

type RecordData = {
  code: string; name: string; market: string; asOfDate: string; officialClosePrice: number | null;
  qualityStatus: string; eligible: boolean; ineligibleReasons: string[]; finalTechnicalScore: number | null;
  technicalStatus: string; reversalBonus: number; penalty: number; penaltyReasons: string[];
  indicators: Record<string, number | string | null | Array<Record<string, unknown>>>;
  componentScores: Record<string, number>;
};
export type MarketAnalysisResponse = { requestedDate: string; generatedAt: string | null; calculatorVersion: string; record: RecordData };
export type IntradayAnalysisResponse = { status: string; session?: { sessionStatus: string; displayLabel: string; quoteAgeSeconds: number | null }; quote: { asOfDate: string | null; asOfTime: string | null; receivedAt: string } | null; intradayAnalysis: { calculatorVersion: string; displayOnly: boolean; finalTechnicalScore: number | null; officialFinalTechnicalScore: number | null; scoreDifference: number | null; qualityStatus: string; blockingReasons: string[] } };

const number = (value: unknown, digits = 2) => typeof value === "number" && Number.isFinite(value) ? value.toFixed(digits) : "-";
const componentLabels: Record<string, string> = {
  momentumScore: "가격 상승 흐름", trendScore: "중장기 추세", volumeScore: "거래량 강도",
  macdScore: "추세 전환 흐름", rsiScore: "단기 과열 균형", position52wScore: "52주 가격 위치",
};
const scoreLabel = (value: number) => value >= 85 ? "매우 강함" : value >= 70 ? "강세" : value >= 50 ? "양호" : value >= 30 ? "반등 시도" : "약세";
const qualityLabel = (value: string) => value === "SEARCH_SESSION_PROVISIONAL" || value === "PROVISIONAL" ? "데이터 검증 중" : value;

export default function MarketAnalysisPanel({ data, intraday, investorData, loading, error, source, intradayError }: { data: MarketAnalysisResponse | null; intraday: IntradayAnalysisResponse | null; investorData?: { foreignNetBuyQty?: number; institutionNetBuyQty?: number; totalNetBuyQty?: number } | null; loading: boolean; error: string | null; source?: string | null; intradayError?: string | null }) {
  if (loading) return <div className="mt-6 rounded-2xl border border-gray-200 bg-white p-5 text-sm text-gray-500">저장된 시장분석 결과를 조회하고 있습니다.</div>;
  if (error || !data) return <div className="mt-6 rounded-2xl border border-amber-200 bg-amber-50 p-5"><h2 className="font-bold text-amber-900">시장분석을 이용할 수 없습니다</h2><p className="mt-2 text-sm text-amber-800">{error ?? "분석에 필요한 공식 일봉 데이터가 준비되지 않았습니다."}</p><p className="mt-2 text-xs text-amber-700">확인되지 않은 값으로 대신 계산하지 않습니다.</p></div>;
  const record = data.record; const i = record.indicators;
  if (!record.eligible) return <div className="mt-6 rounded-2xl border border-amber-200 bg-amber-50 p-5"><h2 className="font-bold text-amber-900">시장분석 제외</h2><p className="mt-2 text-sm text-amber-800">{record.ineligibleReasons.join(", ")}</p></div>;
  const rows: Array<[string, string | number | null]> = [
    ["MA5 / MA20", `${number(i.ma5, 0)} / ${number(i.ma20, 0)}`], ["MA60 / MA120 / MA200", `${number(i.ma60, 0)} / ${number(i.ma120, 0)} / ${number(i.ma200, 0)}`],
    ["MA20 · MA60 기울기", `${number(i.ma20Slope)}% / ${number(i.ma60Slope)}%`], ["고점 · 저점 방향", typeof i.highLowDirection === "string" ? i.highLowDirection : "-"], ["RSI(14)", number(i.rsi14, 1)],
    ["MACD / Signal / Histogram", `${number(i.macd)} / ${number(i.signal)} / ${number(i.histogram)}`], ["5 · 20 · 60일 모멘텀", `${number(i.momentum5)}% / ${number(i.momentum20)}% / ${number(i.momentum60)}%`],
    ["20일 평균 대비 거래량", `${number(i.volumeRatio, 1)}%`], ["ATR(14) / ATR 비율", `${number(i.atr14, 0)}원 / ${number(i.atrPercent)}%`],
    ["20일 변동성", `${number(i.volatility20)}%`], ["52주 고가 · 저가 · 위치", `${number(i.high52w, 0)} / ${number(i.low52w, 0)} / ${number(i.position52w, 1)}%`],
  ];
  return <><div className="mt-6 rounded-2xl border border-gray-200 bg-white p-5">
    <p className="text-sm text-gray-500">공식 일봉 기준 분석</p><h2 className="mt-1 text-xl font-bold text-gray-900">시장 분석</h2>
    <div className="mt-2 flex flex-wrap gap-2 text-xs text-gray-500"><span>데이터 기준일 {record.asOfDate}</span><span>공식 종가 {record.officialClosePrice?.toLocaleString()}원</span><span>공식 일봉 기준</span><span>{qualityLabel(record.qualityStatus)}</span></div>
    <div className="mt-5 rounded-xl border border-gray-200 p-4"><div className="flex justify-between"><div><p className="text-sm text-gray-500">종합 기술 흐름</p><span className="text-3xl font-bold text-gray-900">{record.finalTechnicalScore}</span><span className="text-sm text-gray-500"> / 100</span></div><span className="font-semibold">{record.technicalStatus}</span></div>
      <div className="mt-4 space-y-3 text-sm">{Object.entries(record.componentScores).map(([key, value]) => <div className="flex items-center justify-between gap-3" key={key}><span>{componentLabels[key] ?? key}</span><span className="text-right"><strong>{scoreLabel(value)}</strong><span className="ml-2 text-xs text-gray-400">{number(value)}점</span></span></div>)}<div className="border-t pt-3 flex justify-between"><span>반전 신호</span><span>{record.reversalBonus > 0 ? `가점 +${record.reversalBonus}` : record.penalty > 0 ? `주의 -${record.penalty}` : "특이 신호 없음"}</span></div>{record.penaltyReasons.map((reason) => <p className="text-xs text-gray-500" key={reason}>• {reason}</p>)}</div>
    </div>
    <details className="mt-5 rounded-xl border border-gray-200 bg-gray-50"><summary className="cursor-pointer px-4 py-3 text-sm font-medium text-gray-700">상세 기술지표 보기</summary><section className="space-y-2 border-t border-gray-200 p-4 text-sm">{rows.map(([label, value]) => <div className="flex justify-between gap-4" key={String(label)}><span className="text-gray-600">{label}</span><span className="text-right">{String(value ?? "-")}</span></div>)}</section></details>
    <section className="mt-6 border-t border-gray-100 pt-4"><h3 className="font-semibold text-gray-900">투자자 수급 (별도 KIS 조회)</h3><div className="mt-3 space-y-2 text-sm">{[["외국인", investorData?.foreignNetBuyQty], ["기관", investorData?.institutionNetBuyQty], ["종합", investorData?.totalNetBuyQty]].map(([label, value]) => <div className="flex justify-between" key={String(label)}><span>{label}</span><span>{typeof value === "number" ? value.toLocaleString() : "조회 없음"}</span></div>)}</div><p className="mt-2 text-xs text-gray-400">수급 값은 시장분석 점수 입력에 포함되지 않습니다.</p></section>
    <details className="mt-5 text-xs text-gray-500"><summary className="cursor-pointer font-medium">데이터 기준 자세히 보기</summary><div className="mt-2 space-y-1"><p>분석 버전 {data.calculatorVersion}</p><p>{source === "storedOfficialSnapshot" ? "저장된 공식 분석 결과" : "검색 시점 기준 임시 계산"}</p><p>실시간 시세는 공식 점수에 적용하지 않음</p></div></details>
  </div><div className="mt-4 rounded-2xl border border-indigo-200 bg-indigo-50 p-5"><p className="text-sm text-indigo-700">장중 참고 정보</p>{!intraday||intraday.intradayAnalysis.blockingReasons.length?<><h3 className="mt-1 font-bold text-indigo-900">장중 분석 준비 중</h3><p className="mt-2 text-sm text-indigo-700">{intradayError ?? analysisAvailabilityMessage(intraday?.intradayAnalysis.blockingReasons[0], "현재 장중 분석을 계산할 수 없습니다.")}</p></>:<><h3 className="mt-1 font-bold text-indigo-900">{intraday.session?.displayLabel}</h3><div className="mt-2 text-3xl font-bold text-indigo-900">{intraday.intradayAnalysis.finalTechnicalScore} / 100</div><p className="mt-2 text-sm">공식 점수 대비 {intraday.intradayAnalysis.scoreDifference}</p><details className="mt-2 text-xs"><summary className="cursor-pointer">데이터 기준 자세히 보기</summary><p className="mt-2">KIS 마지막 체결 {intraday.quote?.asOfDate} {intraday.quote?.asOfTime} · 서버 수신 {intraday.quote?.receivedAt}</p></details></>}<p className="mt-3 text-xs text-indigo-700">참고 정보이며 공식 순위와 과거 검증에는 사용하지 않습니다.</p></div></>;
}
