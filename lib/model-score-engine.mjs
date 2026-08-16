import { calculateTechnicalStrength } from "./technical-strength.mjs";
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
  const features = calculateTechnicalModelFeatures(priceHistory, null);
  const modelBResult = calculateTrendStrength(features);
  const modelCResult = calculateEntryStrength(features);
  const modelDScore = calculateCombinedTechnicalScore(
    modelBResult.trendStrength,
    modelCResult.entryStrength,
  );

  return {
    modelA: modelAResult,
    modelB: modelBResult,
    modelC: modelCResult,
    modelD: modelDScore,
    modelE: null,
  };
}
