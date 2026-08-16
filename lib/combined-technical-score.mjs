import { clamp } from "./technical-model-features.mjs";

/** 초기 비교 가설입니다. 향후 검증 후 이 함수만 교체할 수 있습니다. */
export function calculateCombinedTechnicalScore(trendStrength, entryStrength) {
  return Number(clamp((trendStrength * entryStrength) / 100).toFixed(2));
}
