import { clamp } from "./technical-model-features.mjs";

function centeredScore(value, multiplier) {
  return value == null ? 0 : clamp(50 + value * multiplier);
}

export function calculateTrendStrength(features) {
  const priceVsMa20 = centeredScore(features.ma20Distance, 4);
  const ma20VsMa60 = features.ma20 != null && features.ma60 != null && features.ma60 > 0
    ? centeredScore(((features.ma20 - features.ma60) / features.ma60) * 100, 5)
    : 0;
  const ma60VsMa120 = features.ma60 != null && features.ma120 != null && features.ma120 > 0
    ? centeredScore(((features.ma60 - features.ma120) / features.ma120) * 100, 5)
    : 0;
  const slope20 = centeredScore(features.ma20Slope, 25);
  const slope60 = centeredScore(features.ma60Slope, 25);
  const structureRaw = priceVsMa20 * 0.25 + ma20VsMa60 * 0.25 + ma60VsMa120 * 0.20 + slope20 * 0.20 + slope60 * 0.10;
  const structure = structureRaw * 0.35;
  const persistence = (features.persistenceAboveMa20 ?? 0) * 0.25;
  const momentum = centeredScore(features.momentum20, 2) * 0.20;
  const normalizedHistogram = features.histogram != null && features.atr14 != null && features.atr14 > 0
    ? features.histogram / features.atr14
    : null;
  const macdConfirmation = centeredScore(normalizedHistogram, 250) * 0.10;
  const rangePosition = clamp(features.position52w ?? 0) * 0.10;
  const trendStrength = Number(clamp(structure + persistence + momentum + macdConfirmation + rangePosition).toFixed(2));

  return {
    trendStrength,
    components: {
      structure: Number(structure.toFixed(2)),
      persistence: Number(persistence.toFixed(2)),
      momentum: Number(momentum.toFixed(2)),
      macdConfirmation: Number(macdConfirmation.toFixed(2)),
      rangePosition: Number(rangePosition.toFixed(2)),
    },
  };
}
