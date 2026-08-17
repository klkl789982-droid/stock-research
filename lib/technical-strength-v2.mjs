import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { calculateTechnicalStrength } from "./technical-strength.mjs";
import { clamp } from "./technical-model-features.mjs";

export const MODEL_A_V2_VERSION = "A-v2";
export const MODEL_A_V2_ROLE = "challenger";

const FORMULA_DEFINITION = Object.freeze({
  version: MODEL_A_V2_VERSION,
  sourceModel: "A-v1",
  technicalScoreWeights: {
    momentum: 0.25,
    trend: 0.2,
    volume: 0.2,
    macd: 0.15,
    rsi: 0.1,
    high52: 0.1,
  },
  rawScore: "technicalScore + reversalBonus - penalty",
  finalScore: "clamp(rawScore, 0, 100)",
  precision: 2,
  tieBreak: ["finalScore:desc", "rawScore:desc", "code:asc"],
});

const sourceModelHash = createHash("sha256")
  .update(readFileSync(new URL("./technical-strength.mjs", import.meta.url)))
  .digest("hex");

export const MODEL_A_V2_FORMULA_HASH = createHash("sha256")
  .update(JSON.stringify({ ...FORMULA_DEFINITION, sourceModelHash }))
  .digest("hex");

const roundScore = (value) => Number(value.toFixed(2));

export function finalizeTechnicalStrengthV2({ technicalScore, reversalBonus, penalty }) {
  const rawScoreUnrounded = technicalScore + reversalBonus - penalty;
  return {
    rawScore: roundScore(rawScoreUnrounded),
    finalScore: roundScore(clamp(rawScoreUnrounded, 0, 100)),
    rawScoreUnrounded,
  };
}

export function calculateTechnicalStrengthV2(priceHistory, realtimePrice = null) {
  const source = calculateTechnicalStrength(priceHistory, realtimePrice);
  return calculateTechnicalStrengthV2FromSource(source);
}

export function calculateTechnicalStrengthV2FromSource(source) {
  const technicalScore = Object.values(source.weightedContributions)
    .reduce((sum, contribution) => sum + contribution, 0);
  const finalized = finalizeTechnicalStrengthV2({
    technicalScore,
    reversalBonus: source.reversalBonus,
    penalty: source.penalty,
  });

  return {
    version: MODEL_A_V2_VERSION,
    role: MODEL_A_V2_ROLE,
    status: "evaluation",
    scoreRange: { min: 0, max: 100 },
    technicalScore: roundScore(technicalScore),
    preBonusScore: roundScore(technicalScore),
    reversalBonus: source.reversalBonus,
    penalty: source.penalty,
    penaltyReasons: [...source.penaltyReasons],
    rawScore: finalized.rawScore,
    finalScore: finalized.finalScore,
    formulaHash: MODEL_A_V2_FORMULA_HASH,
    rawIndicators: {
      rsi: source.rsi,
      macd: source.macd,
      signal: source.signal,
      histogram: source.histogram,
      volumeRatio: source.volumeRatio,
      priceMomentum: source.priceMomentum,
      position52w: source.position52w,
      atrPercent: source.atrPercent,
      volatility20: source.volatility20,
    },
    normalizedComponents: { ...source.components },
    weightedContributions: { ...source.weightedContributions },
  };
}

export function normalizeStockCode(code) {
  return String(code).trim().toUpperCase().padStart(6, "0");
}

export function compareModelAV2Records(left, right) {
  const finalDifference = right.scoresByVersion[MODEL_A_V2_VERSION] - left.scoresByVersion[MODEL_A_V2_VERSION];
  if (finalDifference !== 0) return finalDifference;
  const rawDifference = right.rawScoresByVersion[MODEL_A_V2_VERSION] - left.rawScoresByVersion[MODEL_A_V2_VERSION];
  if (rawDifference !== 0) return rawDifference;
  const leftCode = normalizeStockCode(left.code);
  const rightCode = normalizeStockCode(right.code);
  return leftCode < rightCode ? -1 : leftCode > rightCode ? 1 : 0;
}

export function assignModelAV2Ranks(records) {
  const ranked = records
    .filter((record) =>
      Number.isFinite(record.scoresByVersion?.[MODEL_A_V2_VERSION]) &&
      Number.isFinite(record.rawScoresByVersion?.[MODEL_A_V2_VERSION]),
    )
    .sort(compareModelAV2Records);

  ranked.forEach((record, index) => {
    record.ranksByVersion[MODEL_A_V2_VERSION] = index + 1;
  });
}
