export const MARKET_ANALYSIS_CALCULATOR_VERSION = "market-analysis-v1";

function ema(values, period) {
  const result = Array(values.length).fill(null);
  if (values.length < period) return result;
  const multiplier = 2 / (period + 1);
  let value = values.slice(0, period).reduce((sum, item) => sum + item, 0) / period;
  result[period - 1] = value;
  for (let index = period; index < values.length; index += 1) {
    value = values[index] * multiplier + value * (1 - multiplier);
    result[index] = value;
  }
  return result;
}

function average(values) { return values.reduce((sum, value) => sum + value, 0) / values.length; }
function movingAverage(values, period, offset = 0) { return values.length >= period + offset ? average(values.slice(offset, offset + period)) : null; }
function momentumScore(value) {
  if (value == null) return 0;
  if (value >= 30) return 100;
  if (value >= 20) return 85;
  if (value >= 10) return 65;
  if (value >= 0) return 40;
  if (value >= -10) return 20;
  return 0;
}

function assertOfficialRows(rows) {
  if (!Array.isArray(rows) || rows.length < 260) throw new Error("시장분석에는 260 거래일의 공식 OHLCV가 필요합니다.");
  let previousDate = null;
  for (const row of rows) {
    if (!/^\d{8}$/.test(String(row.basDt))) throw new Error("유효하지 않은 공식 일봉 기준일입니다.");
    if (previousDate && String(row.basDt) >= previousDate) throw new Error("공식 일봉은 최신순·중복 없는 배열이어야 합니다.");
    previousDate = String(row.basDt);
    const values = [row.mkp, row.hipr, row.lopr, row.clpr, row.trqu].map(Number);
    if (!values.every(Number.isFinite) || values.slice(0, 4).some((value) => value <= 0) || values[4] < 0) throw new Error("유효하지 않은 공식 OHLCV입니다.");
  }
}

export function calculateMarketAnalysis(rows) {
  assertOfficialRows(rows);
  const prices = rows.map((row) => Number(row.clpr));
  const currentPrice = prices[0];
  const currentVolume = Number(rows[0].trqu);
  const ma5 = movingAverage(prices, 5); const ma20 = movingAverage(prices, 20); const ma60 = movingAverage(prices, 60);
  const ma120 = movingAverage(prices, 120); const ma200 = movingAverage(prices, 200);
  const ma20Prev = movingAverage(prices, 20, 1); const ma60Prev = movingAverage(prices, 60, 1);
  const ma20Slope = ((ma20 - ma20Prev) / ma20Prev) * 100; const ma60Slope = ((ma60 - ma60Prev) / ma60Prev) * 100;
  const recent = rows.slice(0, 10); const previous = rows.slice(10, 20);
  const recentHigh = Math.max(...recent.map((row) => Number(row.hipr))); const previousHigh = Math.max(...previous.map((row) => Number(row.hipr)));
  const recentLow = Math.min(...recent.map((row) => Number(row.lopr))); const previousLow = Math.min(...previous.map((row) => Number(row.lopr)));
  const highLowDirection = `고점 ${recentHigh > previousHigh ? "↑" : recentHigh < previousHigh ? "↓" : "→"} · 저점 ${recentLow > previousLow ? "↑" : recentLow < previousLow ? "↓" : "→"}`;

  let gains = 0; let losses = 0;
  for (let index = 0; index < 14; index += 1) { const change = prices[index] - prices[index + 1]; if (change > 0) gains += change; else losses += Math.abs(change); }
  const rsi14 = losses === 0 ? 100 : 100 - 100 / (1 + (gains / 14) / (losses / 14));
  const chronologicalCloses = [...prices].reverse(); const ema12Series = ema(chronologicalCloses, 12); const ema26Series = ema(chronologicalCloses, 26);
  const macdSeries = chronologicalCloses.map((_, index) => ema12Series[index] != null && ema26Series[index] != null ? ema12Series[index] - ema26Series[index] : null).filter((value) => value != null);
  const signalSeries = ema(macdSeries, 9); const macd = macdSeries.at(-1); const signal = signalSeries.at(-1); const histogram = macd - signal;
  const prevHistogram = macdSeries.at(-2) - signalSeries.at(-2);
  const momentum = (days) => ((currentPrice - prices[days - 1]) / prices[days - 1]) * 100;
  const momentum5 = momentum(5); const momentum20 = momentum(20); const momentum60 = momentum(60);
  const dailyReturn = ((currentPrice - prices[1]) / prices[1]) * 100;
  const recent3DailyReturns = [0, 1, 2].map((index) => ((prices[index] - prices[index + 1]) / prices[index + 1]) * 100);
  const hadRecentSurge = recent3DailyReturns.some((value) => value > 15);
  const avgVolume20 = average(rows.slice(0, 20).map((row) => Number(row.trqu))); const volumeRatio = (currentVolume / avgVolume20) * 100;
  let obv = 0; const chronological = [...rows].reverse();
  for (let index = 1; index < chronological.length; index += 1) { const delta = Number(chronological[index].clpr) - Number(chronological[index - 1].clpr); if (delta > 0) obv += Number(chronological[index].trqu); else if (delta < 0) obv -= Number(chronological[index].trqu); }
  const trueRanges = [];
  for (let index = 1; index < chronological.length; index += 1) { const row = chronological[index]; const prevClose = Number(chronological[index - 1].clpr); trueRanges.push(Math.max(Number(row.hipr) - Number(row.lopr), Math.abs(Number(row.hipr) - prevClose), Math.abs(Number(row.lopr) - prevClose))); }
  const atr14 = average(trueRanges.slice(-14)); const atrPercent = (atr14 / currentPrice) * 100;
  const returns20 = Array.from({ length: 20 }, (_, index) => (prices[index] - prices[index + 1]) / prices[index + 1]); const meanReturn = average(returns20);
  const volatility20 = Math.sqrt(average(returns20.map((value) => (value - meanReturn) ** 2))) * 100;
  const ma20Distance = ((currentPrice - ma20) / ma20) * 100;
  const high52w = Math.max(...rows.map((row) => Number(row.hipr))); const low52w = Math.min(...rows.map((row) => Number(row.lopr)));
  const position52w = ((currentPrice - low52w) / (high52w - low52w)) * 100; const drawdown52w = ((currentPrice - high52w) / high52w) * 100;
  const rawMomentumScore = momentumScore(momentum20) * 0.4 + momentumScore(momentum60) * 0.6;
  const volumeScore = Math.min(100, Math.max(0, volumeRatio >= 100 ? 60 + (volumeRatio - 100) * 0.2 : volumeRatio * 0.6));
  const adjustedVolumeScore = Math.min(100, Math.max(0, volumeScore * (momentum20 > 3 ? 1 : momentum20 > -3 ? 0.7 : 0.3)));
  let macdScore = Math.min(100, Math.max(0, 50 + (histogram / atr14) * 250)); macdScore += Math.min(15, Math.max(-15, ((histogram - prevHistogram) / atr14) * 200)); macdScore = Math.min(100, Math.max(0, macdScore));
  const rsiScore = Math.max(0, Math.min(100, 100 - Math.abs(rsi14 - 65) * 3));
  const high52Score = position52w >= 90 ? 100 : position52w >= 80 ? 70 : position52w >= 70 ? 50 : position52w >= 50 ? 30 : 10;
  let trendScore = Math.min(25, Math.max(0, ma20Distance * 1.5)) + Math.min(25, Math.max(0, ((ma20 - ma60) / ma60) * 400)) + Math.min(25, Math.max(0, ((ma60 - ma120) / ma120) * 400)) + Math.min(15, Math.max(0, ma20Slope * 15)) + Math.min(10, Math.max(0, ma60Slope * 15)); trendScore = Math.min(100, Math.max(0, trendScore));
  let penalty = 0; const penaltyReasons = [];
  if (dailyReturn > 15) { penalty += 10; penaltyReasons.push("당일 급등 -10점"); } else if (hadRecentSurge) { penalty += 7; penaltyReasons.push("최근 3일 내 급등 -7점"); } else if (momentum5 > 30) { penalty += 5; penaltyReasons.push("최근 5일 급등 -5점"); }
  if (rsi14 > 80) { penalty += 5; penaltyReasons.push("RSI 과열 -5점"); } if (atrPercent > 15) { penalty += 5; penaltyReasons.push("ATR 과열 -5점"); } if (ma20Distance > 30) { penalty += 5; penaltyReasons.push("20일선 이격도 과열 -5점"); } if (volatility20 > 15) { penalty += 5; penaltyReasons.push("20일 변동성 과열 -5점"); }
  const reversalBonus = rsi14 >= 50 && histogram > 0 && currentPrice > ma20 && !hadRecentSurge && momentum5 <= 30 ? 10 : 0;
  const componentScores = { momentumScore: rawMomentumScore, trendScore, volumeScore: adjustedVolumeScore, macdScore, rsiScore, position52wScore: high52Score };
  const baseScore = rawMomentumScore * 0.25 + trendScore * 0.20 + adjustedVolumeScore * 0.20 + macdScore * 0.15 + rsiScore * 0.10 + high52Score * 0.10;
  const finalTechnicalScore = Number((baseScore + reversalBonus - penalty).toFixed(2));
  const chartSource = rows.slice(0, 120).reverse(); const chartData = chartSource.map((row, index, array) => ({ date: String(row.basDt).slice(4, 8), close: Number(row.clpr), ma5: index >= 4 ? average(array.slice(index - 4, index + 1).map((item) => Number(item.clpr))) : null, ma20: index >= 19 ? average(array.slice(index - 19, index + 1).map((item) => Number(item.clpr))) : null, ma60: index >= 59 ? average(array.slice(index - 59, index + 1).map((item) => Number(item.clpr))) : null, volume: Number(row.trqu), up: Number(row.clpr) >= Number(row.mkp) })).slice(-60);
  return {
    indicators: { ma5, ma20, ma60, ma120, ma200, ma20Slope, ma60Slope, recentHigh, previousHigh, recentLow, previousLow, highLowDirection, ema12: ema12Series.at(-1), ema26: ema26Series.at(-1), rsi14, macd, signal, histogram, momentum5, momentum20, momentum60, dailyReturn, avgVolume20, volumeRatio, obv, atr14, atrPercent, volatility20, ma20Distance, high52w, low52w, position52w, drawdown52w, crossSignal: ma5 > ma20 ? "골든크로스" : "데드크로스", rsiSignal: rsi14 >= 70 ? "과매수" : rsi14 <= 30 ? "과매도" : "중립", macdSignal: macd > signal ? "상승" : "하락", momentumSignal: momentum20 > 10 ? "강세" : momentum20 > 0 ? "약강세" : "약세", signalScore: (rsi14 > 50 ? 1 : 0) + (macd > signal ? 1 : 0) + (momentum20 > 0 ? 1 : 0) + (ma20Slope > 0 ? 1 : 0), chartData },
    componentScores, riskFlags: { overbought: rsi14 > 80, highVolatility: volatility20 > 15, extendedFromMA20: ma20Distance > 30, recentSurge: dailyReturn > 15 || hadRecentSurge || momentum5 > 30 },
    reversalBonus, penalty, penaltyReasons, finalTechnicalScore,
    technicalStatus: finalTechnicalScore >= 85 ? "매우 강함" : finalTechnicalScore >= 70 ? "강세" : finalTechnicalScore >= 50 ? "양호" : finalTechnicalScore >= 30 ? "반등 시도" : "약세",
  };
}
