function calculateEMAArray(values, period) {
  const result = Array(values.length).fill(null);
  if (values.length < period) return result;

  const multiplier = 2 / (period + 1);
  let ema = values.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  result[period - 1] = ema;

  for (let index = period; index < values.length; index += 1) {
    ema = values[index] * multiplier + ema * (1 - multiplier);
    result[index] = ema;
  }

  return result;
}

function scoreMomentum(value) {
  if (value == null) return 0;
  if (value >= 30) return 100;
  if (value >= 20) return 85;
  if (value >= 10) return 65;
  if (value >= 0) return 40;
  if (value >= -10) return 20;
  return 0;
}

export function calculateTechnicalStrength(priceHistory, realtimePrice = null) {
  const liveCurrentPrice = realtimePrice?.price ?? (priceHistory.length > 0 ? Number(priceHistory[0].clpr) : null);
  const liveCurrentVolume = realtimePrice?.volume ?? (priceHistory.length > 0 ? Number(priceHistory[0].trqu) : null);
  const livePrices = priceHistory.length > 0
    ? [liveCurrentPrice ?? Number(priceHistory[0].clpr), ...priceHistory.slice(1).map((item) => Number(item.clpr))]
    : [];
  const liveCloses = priceHistory.length > 0
    ? [liveCurrentPrice ?? Number(priceHistory[0].clpr), ...priceHistory.map((item) => Number(item.clpr))]
    : [];

  const ma20 = livePrices.length >= 20 ? livePrices.slice(0, 20).reduce((sum, value) => sum + value, 0) / 20 : null;
  const ma20Prev = livePrices.length >= 21 ? livePrices.slice(1, 21).reduce((sum, value) => sum + value, 0) / 20 : null;
  const ma20Slope = ma20 !== null && ma20Prev !== null ? ((ma20 - ma20Prev) / ma20Prev) * 100 : null;
  const ma60 = livePrices.length >= 60 ? livePrices.slice(0, 60).reduce((sum, value) => sum + value, 0) / 60 : null;
  const ma60Prev = livePrices.length >= 61 ? livePrices.slice(1, 61).reduce((sum, value) => sum + value, 0) / 60 : null;
  const ma60Slope = ma60 !== null && ma60Prev !== null ? ((ma60 - ma60Prev) / ma60Prev) * 100 : null;
  const ma120 = livePrices.length >= 120 ? livePrices.slice(0, 120).reduce((sum, value) => sum + value, 0) / 120 : null;

  const rsi14 = liveCloses.length >= 15
    ? (() => {
        let gains = 0;
        let losses = 0;
        for (let index = 0; index < 14; index += 1) {
          const change = liveCloses[index] - liveCloses[index + 1];
          if (change > 0) gains += change;
          else losses += Math.abs(change);
        }
        const avgGain = gains / 14;
        const avgLoss = losses / 14;
        if (avgLoss === 0) return 100;
        return 100 - 100 / (1 + avgGain / avgLoss);
      })()
    : null;

  const historicalCloses = priceHistory.map((item) => Number(item.clpr)).reverse();
  const closes = realtimePrice?.price != null ? [...historicalCloses, realtimePrice.price] : historicalCloses;
  const ema12Series = calculateEMAArray(closes, 12);
  const ema26Series = calculateEMAArray(closes, 26);
  const macdSeries = [];

  for (let index = 0; index < closes.length; index += 1) {
    if (ema12Series[index] !== null && ema26Series[index] !== null) {
      macdSeries.push(ema12Series[index] - ema26Series[index]);
    }
  }

  const signalSeries = calculateEMAArray(macdSeries, 9);
  const macd = macdSeries.length > 0 ? macdSeries.at(-1) : null;
  const signal = signalSeries.length > 0 ? signalSeries.at(-1) : null;
  const histogram = macd !== null && signal !== null ? macd - signal : null;
  const prevMacd = macdSeries.length >= 2 ? macdSeries.at(-2) : null;
  const prevSignal = signalSeries.length >= 2 ? signalSeries.at(-2) : null;
  const prevHistogram = prevMacd !== null && prevSignal !== null ? prevMacd - prevSignal : null;

  const momentum20 = liveCurrentPrice !== null && priceHistory.length >= 19
    ? ((liveCurrentPrice - Number(priceHistory[18].clpr)) / Number(priceHistory[18].clpr)) * 100
    : null;
  const momentum5 = liveCurrentPrice !== null && priceHistory.length >= 4
    ? ((liveCurrentPrice - Number(priceHistory[3].clpr)) / Number(priceHistory[3].clpr)) * 100
    : null;
  const dailyReturn = liveCurrentPrice !== null && priceHistory.length >= 1
    ? ((liveCurrentPrice - Number(priceHistory[0].clpr)) / Number(priceHistory[0].clpr)) * 100
    : null;
  const recent3DailyReturns = liveCurrentPrice !== null && priceHistory.length >= 3
    ? [
        ((liveCurrentPrice - Number(priceHistory[0].clpr)) / Number(priceHistory[0].clpr)) * 100,
        ((Number(priceHistory[0].clpr) - Number(priceHistory[1].clpr)) / Number(priceHistory[1].clpr)) * 100,
        ((Number(priceHistory[1].clpr) - Number(priceHistory[2].clpr)) / Number(priceHistory[2].clpr)) * 100,
      ]
    : [];
  const hadRecentSurge = recent3DailyReturns.some((value) => value > 15);
  const momentum60 = liveCurrentPrice !== null && priceHistory.length >= 59
    ? ((liveCurrentPrice - Number(priceHistory[58].clpr)) / Number(priceHistory[58].clpr)) * 100
    : null;
  const avgVolume20 = priceHistory.length >= 20
    ? priceHistory.slice(0, 20).reduce((sum, item) => sum + Number(item.trqu), 0) / 20
    : null;
  const volumeRatio = avgVolume20 !== null && liveCurrentVolume !== null ? (liveCurrentVolume / avgVolume20) * 100 : null;

  const atr14 = priceHistory.length >= 14
    ? (() => {
        const ordered = [...priceHistory].reverse();
        const trueRanges = [];
        for (let index = 1; index < ordered.length; index += 1) {
          const high = Number(ordered[index].hipr);
          const low = Number(ordered[index].lopr);
          const prevClose = Number(ordered[index - 1].clpr);
          trueRanges.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
        }
        if (realtimePrice?.high != null && realtimePrice?.low != null && priceHistory.length > 0) {
          const prevClose = Number(priceHistory[0].clpr);
          trueRanges.push(Math.max(realtimePrice.high - realtimePrice.low, Math.abs(realtimePrice.high - prevClose), Math.abs(realtimePrice.low - prevClose)));
        }
        const recent14 = trueRanges.slice(-14);
        return recent14.length === 14 ? recent14.reduce((sum, value) => sum + value, 0) / 14 : null;
      })()
    : null;
  const atrPercent = atr14 !== null && liveCurrentPrice !== null && liveCurrentPrice > 0 ? (atr14 / liveCurrentPrice) * 100 : null;
  const volatility20 = priceHistory.length >= 21
    ? (() => {
        const returns = [];
        for (let index = 0; index < 20; index += 1) {
          const current = Number(priceHistory[index].clpr);
          const previous = Number(priceHistory[index + 1].clpr);
          returns.push((current - previous) / previous);
        }
        const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
        const variance = returns.reduce((sum, value) => sum + Math.pow(value - mean, 2), 0) / returns.length;
        return Math.sqrt(variance) * 100;
      })()
    : null;
  const ma20Distance = liveCurrentPrice !== null && ma20 != null && ma20 > 0 ? ((liveCurrentPrice - ma20) / ma20) * 100 : null;
  const high52w = priceHistory.length > 0 ? Math.max(...priceHistory.map((item) => Number(item.hipr)), realtimePrice?.high ?? 0) : null;
  const low52w = priceHistory.length > 0 ? Math.min(...priceHistory.map((item) => Number(item.lopr)), realtimePrice?.low ?? Number.MAX_SAFE_INTEGER) : null;
  const position52w = liveCurrentPrice !== null && high52w != null && low52w != null && high52w > low52w
    ? ((liveCurrentPrice - low52w) / (high52w - low52w)) * 100
    : null;

  const momentumScore = momentum20 != null && momentum60 != null
    ? scoreMomentum(momentum20) * 0.4 + scoreMomentum(momentum60) * 0.6
    : scoreMomentum(momentum20);
  const volumeScore = volumeRatio === null ? 0 : Math.min(100, Math.max(0, volumeRatio >= 100 ? 60 + (volumeRatio - 100) * 0.2 : volumeRatio * 0.6));
  const volumeDirectionFactor = momentum20 == null ? 1 : momentum20 > 3 ? 1 : momentum20 > -3 ? 0.7 : 0.3;
  const adjustedVolumeScore = Math.min(100, Math.max(0, volumeScore * volumeDirectionFactor));
  const normalizedMacd = histogram != null && atr14 != null && atr14 > 0 ? histogram / atr14 : null;
  let macdScore = normalizedMacd === null ? 0 : Math.min(100, Math.max(0, 50 + normalizedMacd * 250));
  if (histogram !== null && prevHistogram !== null && atr14 !== null && atr14 > 0) {
    const histogramChange = (histogram - prevHistogram) / atr14;
    macdScore += Math.min(15, Math.max(-15, histogramChange * 200));
  }
  macdScore = Math.max(0, Math.min(100, macdScore));
  const rsiScore = rsi14 == null ? 0 : Math.max(0, Math.min(100, 100 - Math.abs(rsi14 - 65) * 3));
  const high52Score = position52w == null ? 0 : position52w >= 90 ? 100 : position52w >= 80 ? 70 : position52w >= 70 ? 50 : position52w >= 50 ? 30 : 10;

  const currentPrice = priceHistory[0]?.clpr != null ? Number(priceHistory[0].clpr) : null;
  let trendScore = 0;
  if (currentPrice !== null && ma20 !== null && ma20 > 0) trendScore += Math.min(25, Math.max(0, ((currentPrice - ma20) / ma20) * 100 * 1.5));
  if (ma20 !== null && ma60 !== null && ma60 > 0) trendScore += Math.min(25, Math.max(0, ((ma20 - ma60) / ma60) * 100 * 4));
  if (ma60 !== null && ma120 !== null && ma120 > 0) trendScore += Math.min(25, Math.max(0, ((ma60 - ma120) / ma120) * 100 * 4));
  if (ma20Slope !== null) trendScore += Math.min(15, Math.max(0, ma20Slope * 15));
  if (ma60Slope !== null) trendScore += Math.min(10, Math.max(0, ma60Slope * 15));
  trendScore = Math.min(100, Math.max(0, trendScore));

  let penalty = 0;
  const penaltyReasons = [];
  if (dailyReturn !== null && dailyReturn > 15) { penalty += 10; penaltyReasons.push("당일 급등 -10점"); }
  else if (hadRecentSurge) { penalty += 7; penaltyReasons.push("최근 3일 내 급등 -7점"); }
  else if (momentum5 !== null && momentum5 > 30) { penalty += 5; penaltyReasons.push("최근 5일 급등 -5점"); }
  if (rsi14 !== null && rsi14 > 80) { penalty += 5; penaltyReasons.push("RSI 과열 -5점"); }
  if (atrPercent !== null && atrPercent > 15) { penalty += 5; penaltyReasons.push("ATR 과열 -5점"); }
  if (ma20Distance !== null && ma20Distance > 30) { penalty += 5; penaltyReasons.push("20일선 이격도 과열 -5점"); }
  if (volatility20 !== null && volatility20 > 15) { penalty += 5; penaltyReasons.push("20일 변동성 과열 -5점"); }

  let reversalBonus = 0;
  if (rsi14 != null && rsi14 >= 50 && histogram != null && histogram > 0 && currentPrice != null && ma20 != null && currentPrice > ma20 && !hadRecentSurge && (momentum5 == null || momentum5 <= 30)) reversalBonus = 10;

  const components = { momentumScore, trendScore, adjustedVolumeScore, macdScore, rsiScore, high52Score };
  const weightedContributions = {
    momentum: momentumScore * 0.25,
    trend: trendScore * 0.20,
    volume: adjustedVolumeScore * 0.20,
    macd: macdScore * 0.15,
    rsi: rsiScore * 0.10,
    high52: high52Score * 0.10,
  };
  const technicalScore = Object.values(weightedContributions).reduce((sum, value) => sum + value, 0);
  const finalTechnicalScore = Number((technicalScore + reversalBonus - penalty).toFixed(2));

  return {
    finalTechnicalScore,
    rsi: rsi14,
    macd,
    signal,
    histogram,
    volumeRatio,
    priceMomentum: momentum20,
    position52w,
    atrPercent,
    volatility20,
    penalty,
    penaltyReasons,
    reversalBonus,
    components,
    weightedContributions,
  };
}
