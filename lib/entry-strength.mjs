import { clamp } from "./technical-model-features.mjs";

function interpolate(value, points) {
  if (value <= points[0][0]) return points[0][1];
  for (let index = 1; index < points.length; index += 1) {
    const [x1, y1] = points[index - 1];
    const [x2, y2] = points[index];
    if (value <= x2) return y1 + ((value - x1) / (x2 - x1)) * (y2 - y1);
  }
  return points.at(-1)[1];
}

const returnFit = (value) => interpolate(value ?? 0, [[-10, 0], [-5, 20], [0, 60], [3, 90], [6, 75], [10, 40], [15, 10]]);
const momentumFit = (value) => interpolate(value ?? 0, [[-12, 0], [-5, 25], [0, 60], [4, 90], [8, 80], [15, 40], [25, 10]]);
const rsiFit = (value) => interpolate(value ?? 50, [[20, 10], [35, 45], [50, 80], [60, 100], [70, 70], [80, 25], [90, 0]]);

export function calculateEntryStrength(features) {
  const priceActionRaw = clamp(features.closeLocation) * 0.60 + returnFit(features.dailyChangeRate) * 0.40;
  const priceAction = priceActionRaw * 0.25;
  const volumeRaw = features.volumeRatio == null
    ? 40
    : features.bullishCandle
      ? clamp(40 + (features.volumeRatio - 70) * 0.5)
      : clamp(60 - (features.volumeRatio - 70) * 0.5);
  const volumeConfirmation = volumeRaw * 0.20;
  const shortMomentum = ((momentumFit(features.momentum3) + momentumFit(features.momentum5)) / 2) * 0.20;
  const rsiDirection = clamp(50 + (features.rsiChange ?? 0) * 5);
  const histogramDirection = features.histogram != null && features.previousHistogram != null && features.atr14 != null && features.atr14 > 0
    ? clamp(50 + ((features.histogram - features.previousHistogram) / features.atr14) * 300)
    : 50;
  const turning = (rsiFit(features.rsi) * 0.40 + rsiDirection * 0.20 + histogramDirection * 0.40) * 0.20;
  const priceVsMa5 = features.ma5 != null && features.ma5 > 0 ? clamp(50 + ((features.currentPrice - features.ma5) / features.ma5) * 100 * 8) : 0;
  const priceVsMa20 = features.ma20 != null && features.ma20 > 0 ? clamp(50 + ((features.currentPrice - features.ma20) / features.ma20) * 100 * 5) : 0;
  const shortTermIntegrity = ((priceVsMa5 + priceVsMa20) / 2) * 0.15;

  const riskFlags = {
    overbought: (features.rsi ?? 0) >= 75,
    sharpDailyDrop: features.dailyChangeRate <= -5,
    highVolumeSelloff: !features.bullishCandle && features.dailyChangeRate < 0 && (features.volumeRatio ?? 0) >= 150,
    shortTermTrendBreak: features.ma5 != null && features.currentPrice < features.ma5 && features.dailyChangeRate <= -2,
    extendedFromMA20: (features.ma20Distance ?? 0) >= 15,
  };
  const rawRiskPenalty =
    (riskFlags.overbought ? 10 : 0) +
    (riskFlags.sharpDailyDrop ? 15 : 0) +
    (riskFlags.highVolumeSelloff ? 15 : 0) +
    (riskFlags.shortTermTrendBreak ? 10 : 0) +
    (riskFlags.extendedFromMA20 ? 10 : 0);
  const riskPenalty = Math.min(35, rawRiskPenalty);
  const entryStrength = Number(clamp(priceAction + volumeConfirmation + shortMomentum + turning + shortTermIntegrity - riskPenalty).toFixed(2));

  return {
    entryStrength,
    riskFlags,
    riskPenalty,
    components: {
      priceAction: Number(priceAction.toFixed(2)),
      volumeConfirmation: Number(volumeConfirmation.toFixed(2)),
      shortMomentum: Number(shortMomentum.toFixed(2)),
      turning: Number(turning.toFixed(2)),
      shortTermIntegrity: Number(shortTermIntegrity.toFixed(2)),
    },
  };
}
