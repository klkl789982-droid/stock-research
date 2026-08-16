export function clamp(value, min = 0, max = 100) {
  return Math.min(max, Math.max(min, value));
}

function average(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function sma(values, period, start = 0) {
  return values.length >= start + period
    ? average(values.slice(start, start + period))
    : null;
}

function rsi(values, start = 0) {
  if (values.length < start + 15) return null;
  let gains = 0;
  let losses = 0;
  for (let index = start; index < start + 14; index += 1) {
    const change = values[index] - values[index + 1];
    if (change > 0) gains += change;
    else losses += Math.abs(change);
  }
  const avgLoss = losses / 14;
  if (avgLoss === 0) return 100;
  const relativeStrength = gains / 14 / avgLoss;
  return 100 - 100 / (1 + relativeStrength);
}

function emaSeries(values, period) {
  const result = Array(values.length).fill(null);
  if (values.length < period) return result;
  const multiplier = 2 / (period + 1);
  let ema = average(values.slice(0, period));
  result[period - 1] = ema;
  for (let index = period; index < values.length; index += 1) {
    ema = values[index] * multiplier + ema * (1 - multiplier);
    result[index] = ema;
  }
  return result;
}

export function calculateTechnicalModelFeatures(priceHistory, realtimePrice = null) {
  const history = [...priceHistory].sort((a, b) => String(b.basDt).localeCompare(String(a.basDt)));
  const closes = history.map((row) => Number(row.clpr));
  const currentPrice = realtimePrice?.price ?? closes[0];
  if (realtimePrice?.price != null) closes[0] = realtimePrice.price;
  const currentOpen = Number(history[0]?.mkp);
  const currentHigh = realtimePrice?.high ?? Number(history[0]?.hipr);
  const currentLow = realtimePrice?.low ?? Number(history[0]?.lopr);
  const currentVolume = realtimePrice?.volume ?? Number(history[0]?.trqu);
  const dailyChangeRate = realtimePrice?.rate ?? Number(history[0]?.fltRt ?? 0);

  const ma5 = sma(closes, 5);
  const ma20 = sma(closes, 20);
  const ma20Prev = sma(closes, 20, 1);
  const ma60 = sma(closes, 60);
  const ma60Prev = sma(closes, 60, 1);
  const ma120 = sma(closes, 120);
  const ma20Slope = ma20 !== null && ma20Prev !== null ? ((ma20 - ma20Prev) / ma20Prev) * 100 : null;
  const ma60Slope = ma60 !== null && ma60Prev !== null ? ((ma60 - ma60Prev) / ma60Prev) * 100 : null;
  const ma20Distance = ma20 !== null && ma20 > 0 ? ((currentPrice - ma20) / ma20) * 100 : null;

  const momentum3 = closes.length >= 3 ? ((currentPrice - closes[2]) / closes[2]) * 100 : null;
  const momentum5 = closes.length >= 5 ? ((currentPrice - closes[4]) / closes[4]) * 100 : null;
  const momentum20 = closes.length >= 20 ? ((currentPrice - closes[19]) / closes[19]) * 100 : null;
  const rsiCurrent = rsi(closes);
  const rsiPrevious = rsi(closes, 1);

  const chronological = [...closes].reverse();
  const ema12 = emaSeries(chronological, 12);
  const ema26 = emaSeries(chronological, 26);
  const macdSeries = chronological.map((_, index) =>
    ema12[index] !== null && ema26[index] !== null ? ema12[index] - ema26[index] : null,
  ).filter((value) => value !== null);
  const signalSeries = emaSeries(macdSeries, 9);
  const macd = macdSeries.at(-1) ?? null;
  const signal = signalSeries.at(-1) ?? null;
  const histogram = macd !== null && signal !== null ? macd - signal : null;
  const previousMacd = macdSeries.at(-2) ?? null;
  const previousSignal = signalSeries.at(-2) ?? null;
  const previousHistogram = previousMacd !== null && previousSignal !== null ? previousMacd - previousSignal : null;

  const trueRanges = [];
  for (let index = history.length - 2; index >= 0; index -= 1) {
    const high = index === 0 ? currentHigh : Number(history[index].hipr);
    const low = index === 0 ? currentLow : Number(history[index].lopr);
    const previousClose = Number(history[index + 1].clpr);
    trueRanges.push(Math.max(high - low, Math.abs(high - previousClose), Math.abs(low - previousClose)));
  }
  const atr14 = trueRanges.length >= 14 ? average(trueRanges.slice(-14)) : null;
  const avgVolume20 = history.length >= 20 ? average(history.slice(0, 20).map((row) => Number(row.trqu))) : null;
  const volumeRatio = avgVolume20 && avgVolume20 > 0 ? (currentVolume / avgVolume20) * 100 : null;
  const high52w = history.length > 0 ? Math.max(...history.map((row) => Number(row.hipr)), currentHigh) : null;
  const low52w = history.length > 0 ? Math.min(...history.map((row) => Number(row.lopr)), currentLow) : null;
  const position52w = high52w !== null && low52w !== null && high52w > low52w ? ((currentPrice - low52w) / (high52w - low52w)) * 100 : null;
  const closeLocation = currentHigh > currentLow ? ((currentPrice - currentLow) / (currentHigh - currentLow)) * 100 : 50;
  const bullishCandle = currentPrice >= currentOpen;

  let closesAboveMa20 = 0;
  let persistenceObservations = 0;
  for (let index = 0; index < 20; index += 1) {
    const rollingMa20 = sma(closes, 20, index);
    if (rollingMa20 === null) break;
    persistenceObservations += 1;
    if (closes[index] >= rollingMa20) closesAboveMa20 += 1;
  }

  return {
    currentPrice,
    currentOpen,
    currentHigh,
    currentLow,
    dailyChangeRate,
    bullishCandle,
    closeLocation,
    ma5,
    ma20,
    ma60,
    ma120,
    ma20Slope,
    ma60Slope,
    ma20Distance,
    momentum3,
    momentum5,
    momentum20,
    rsi: rsiCurrent,
    rsiChange: rsiCurrent !== null && rsiPrevious !== null ? rsiCurrent - rsiPrevious : null,
    macd,
    signal,
    histogram,
    previousHistogram,
    atr14,
    volumeRatio,
    position52w,
    persistenceAboveMa20: persistenceObservations > 0 ? (closesAboveMa20 / persistenceObservations) * 100 : null,
  };
}
