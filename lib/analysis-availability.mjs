const MESSAGES = Object.freeze({
  INSUFFICIENT_HISTORY: "분석에 필요한 거래 데이터가 부족합니다.",
  INVALID_HISTORY: "가격 데이터 정합성을 확인할 수 없습니다.",
  PRICE_REQUEST_FAILED: "공식 가격 데이터를 이용할 수 없습니다.",
  CALCULATION_FAILED: "분석 계산 중 오류가 발생했습니다.",
  NON_FINITE_SCORE: "분석 결과를 확인할 수 없습니다.",
  MARKET_RECORD_MISSING: "이 종목의 저장된 시장분석 결과가 없습니다.",
  MARKET_SNAPSHOT_UNAVAILABLE: "저장된 시장분석 결과를 이용할 수 없습니다.",
  INTRADAY_UNAVAILABLE: "장중 시장상태를 이용할 수 없습니다.",
  officialSnapshotMissing: "공식 시장분석 기준 데이터가 없습니다.",
  seedMissing: "장중 분석 기준 데이터가 부족합니다.",
  marketSessionUnverified: "현재 장중 거래 상태를 확인할 수 없습니다.",
  kisQuoteMissing: "현재 시세를 이용할 수 없습니다.",
  quoteDateMissing: "현재 시세 기준일을 확인할 수 없습니다.",
  quoteTimeMissing: "현재 시세 기준시각을 확인할 수 없습니다.",
  invalidQuoteOhlcv: "현재 시세 데이터 정합성을 확인할 수 없습니다.",
  staleQuote: "현재 시세가 오래되어 장중 분석에서 제외했습니다.",
});

export function analysisAvailabilityMessage(reason, fallback = "분석 결과를 이용할 수 없습니다.") {
  return MESSAGES[reason] ?? fallback;
}
