"use client";

type RecordData = {
  code: string; name: string; market: string; asOfDate: string; officialClosePrice: number | null;
  qualityStatus: string; eligible: boolean; ineligibleReasons: string[]; finalTechnicalScore: number | null;
  technicalStatus: string; reversalBonus: number; penalty: number; penaltyReasons: string[];
  indicators: Record<string, number | string | null | Array<Record<string, unknown>>>;
  componentScores: Record<string, number>;
};
export type MarketAnalysisResponse = { requestedDate: string; generatedAt: string; calculatorVersion: string; record: RecordData };
export type IntradayAnalysisResponse = { status: string; quote: { asOfDate: string | null; asOfTime: string | null; receivedAt: string } | null; intradayAnalysis: { calculatorVersion: string; displayOnly: boolean; finalTechnicalScore: number | null; officialFinalTechnicalScore: number | null; scoreDifference: number | null; qualityStatus: string; blockingReasons: string[] } };

const number = (value: unknown, digits = 2) => typeof value === "number" && Number.isFinite(value) ? value.toFixed(digits) : "-";

export default function MarketAnalysisPanel({ data, intraday, investorData, loading, error }: { data: MarketAnalysisResponse | null; intraday: IntradayAnalysisResponse | null; investorData?: { foreignNetBuyQty?: number; institutionNetBuyQty?: number; totalNetBuyQty?: number } | null; loading: boolean; error: string | null }) {
  if (loading) return <div className="mt-6 rounded-2xl border border-gray-200 bg-white p-5 text-sm text-gray-500">저장된 시장분석 결과를 조회하고 있습니다.</div>;
  if (error || !data) return <div className="mt-6 rounded-2xl border border-red-200 bg-red-50 p-5"><h2 className="font-bold text-red-800">시장분석 결과 없음</h2><p className="mt-2 text-sm text-red-700">{error ?? "저장된 결과가 없습니다."}</p><p className="mt-2 text-xs text-red-600">브라우저에서 과거 공식을 대신 계산하거나 실시간 가격으로 대체하지 않습니다.</p></div>;
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
    <p className="text-sm text-gray-500">저장된 공식 일봉 시장분석</p><h2 className="mt-1 text-xl font-bold text-gray-900">시장 분석</h2>
    <div className="mt-2 flex flex-wrap gap-2 text-xs text-gray-500"><span>기준일 {record.asOfDate}</span><span>공식 종가 {record.officialClosePrice?.toLocaleString()}원</span><span>{data.calculatorVersion}</span><span>품질 {record.qualityStatus}</span></div>
    <div className="mt-5 rounded-xl border border-gray-200 p-4"><div className="flex justify-between"><div><p className="text-sm text-gray-500">기술적 강도</p><span className="text-3xl font-bold text-gray-900">{record.finalTechnicalScore}</span><span className="text-sm text-gray-500"> / 100</span></div><span className="font-semibold">{record.technicalStatus}</span></div>
      <div className="mt-4 space-y-2 text-sm">{Object.entries(record.componentScores).map(([key, value]) => <div className="flex justify-between" key={key}><span>{key}</span><span>{number(value)} / 100</span></div>)}<div className="border-t pt-2 flex justify-between"><span>reversal bonus / penalty</span><span>+{record.reversalBonus} / -{record.penalty}</span></div>{record.penaltyReasons.map((reason) => <p className="text-xs text-gray-500" key={reason}>• {reason}</p>)}</div>
    </div>
    <section className="mt-6 space-y-2 text-sm">{rows.map(([label, value]) => <div className="flex justify-between gap-4" key={String(label)}><span className="text-gray-600">{label}</span><span className="text-right">{String(value ?? "-")}</span></div>)}</section>
    <section className="mt-6 border-t border-gray-100 pt-4"><h3 className="font-semibold text-gray-900">투자자 수급 (별도 KIS 조회)</h3><div className="mt-3 space-y-2 text-sm">{[["외국인", investorData?.foreignNetBuyQty], ["기관", investorData?.institutionNetBuyQty], ["종합", investorData?.totalNetBuyQty]].map(([label, value]) => <div className="flex justify-between" key={String(label)}><span>{label}</span><span>{typeof value === "number" ? value.toLocaleString() : "조회 없음"}</span></div>)}</div><p className="mt-2 text-xs text-gray-400">수급 값은 시장분석 점수 입력에 포함되지 않습니다.</p></section>
    <p className="mt-5 text-xs leading-5 text-gray-400">공식 일봉과 공식 종가로 사전 계산된 결과입니다. KIS 현재가는 표시용 시세에만 사용되며 이 점수에 포함되지 않습니다.</p>
  </div><div className="mt-4 rounded-2xl border border-indigo-200 bg-indigo-50 p-5"><p className="text-sm text-indigo-700">장중 참고 분석 · displayOnly</p>{!intraday||intraday.intradayAnalysis.blockingReasons.length?<><h3 className="mt-1 font-bold text-indigo-900">장중 점수 계산 중단</h3><p className="mt-2 text-sm text-indigo-700">{intraday?.intradayAnalysis.blockingReasons.join(", ")??"장중 분석 결과 없음"}</p></>:<><div className="mt-2 text-3xl font-bold text-indigo-900">{intraday.intradayAnalysis.finalTechnicalScore} / 100</div><p className="mt-2 text-sm">공식 점수 대비 {intraday.intradayAnalysis.scoreDifference}</p><p className="mt-2 text-xs">KIS 마지막 조회 {intraday.quote?.asOfDate} {intraday.quote?.asOfTime} · 서버 수신 {intraday.quote?.receivedAt}</p></>}<p className="mt-3 text-xs text-indigo-700">TOP·모델 순위·백테스트·최적화 사용 금지</p></div></>;
}
