import { calculateTechnicalStrength } from "./technical-strength.mjs";
import { calculateTechnicalStrengthV2FromSource } from "./technical-strength-v2.mjs";
import { calculateTechnicalModelFeatures } from "./technical-model-features.mjs";
import { calculateTrendStrength } from "./trend-strength.mjs";
import { calculateEntryStrength } from "./entry-strength.mjs";
import { calculateCombinedTechnicalScore } from "./combined-technical-score.mjs";

export const SNAPSHOT_MODEL_KEYS = ["modelA", "modelB", "modelC", "modelD", "modelE"];
export const CONFIGURED_MODEL_KEYS = ["modelA", "modelB", "modelC", "modelD"];

/**
 * 기존 A/B/C/D 계산 함수를 변경 없이 호출하는 스냅샷용 어댑터입니다.
 * Model E는 공식이 등록될 때까지 의도적으로 null을 반환합니다.
 */
export function calculateSnapshotModels(priceHistory) {
  const modelAResult = calculateTechnicalStrength(priceHistory, null);
  const modelAV2Result = calculateTechnicalStrengthV2FromSource(modelAResult);
  const features = calculateTechnicalModelFeatures(priceHistory, null);
  const modelBResult = calculateTrendStrength(features);
  const modelCResult = calculateEntryStrength(features);
  const modelDScore = calculateCombinedTechnicalScore(
    modelBResult.trendStrength,
    modelCResult.entryStrength,
  );

  return {
    modelA: modelAResult,
    modelAV2: modelAV2Result,
    modelB: modelBResult,
    modelC: modelCResult,
    modelD: modelDScore,
    modelE: null,
  };
}

export function calculateEligibleSnapshotModels(priceHistory, eligibility) {
  const modelA = eligibility["A-v1"] ? calculateTechnicalStrength(priceHistory, null) : null;
  const modelAV2 = eligibility["A-v2"] && modelA ? calculateTechnicalStrengthV2FromSource(modelA) : null;
  const needsFeatures = eligibility["B-v1"] || eligibility["C-v1"] || eligibility["D-v1"];
  const features = needsFeatures ? calculateTechnicalModelFeatures(priceHistory, null) : null;
  const modelB = eligibility["B-v1"] && features ? calculateTrendStrength(features) : null;
  const modelC = eligibility["C-v1"] && features ? calculateEntryStrength(features) : null;
  const modelD = eligibility["D-v1"] && modelB && modelC
    ? calculateCombinedTechnicalScore(modelB.trendStrength, modelC.entryStrength)
    : null;
  return { modelA, modelAV2, modelB, modelC, modelD, modelE: null };
}
