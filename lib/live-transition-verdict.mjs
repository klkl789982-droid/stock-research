import { TRANSITION_PAIRS } from "./transition-rule-policy.mjs";

export const LIVE_NEAR_PERCENT_DEFAULT = 1;
export const LIVE_NEAR_THRESHOLDS = Object.freeze([0, 0.25, 0.5, 1, 2, 3, 4, 5]);

export function observeLiveGoldenTransition(closedRows, observedPrice, pair, nearPercent = LIVE_NEAR_PERCENT_DEFAULT) {
  if (!Object.hasOwn(TRANSITION_PAIRS, pair) || !Number.isFinite(nearPercent) || nearPercent < 0 || nearPercent > 5) throw new Error("LIVE_FILTER_INVALID");
  const [short, long] = pair.split("-").map(Number);
  const closes = closedRows.slice(0, long).map((row) => row[4]);
  if (closes.length !== long || ![...closes, observedPrice].every((value) => Number.isFinite(value) && value > 0)) throw new Error("LIVE_MA_INPUT_MISSING");
  const sum = (count) => closes.slice(0, count).reduce((total, value) => total + value, 0);
  const previousShortSum = sum(short), previousLongSum = sum(long);
  const shortHistory = sum(short - 1), longHistory = sum(long - 1);
  const previousShort = previousShortSum / short, previousLong = previousLongSum / long;
  const currentShort = (shortHistory + observedPrice) / short, currentLong = (longHistory + observedPrice) / long;
  // Compare unrounded sums so equal lines do not become false crossings.
  const previousDifference = long * previousShortSum - short * previousLongSum;
  const currentDifference = long * (shortHistory + observedPrice) - short * (longHistory + observedPrice);
  const gapPercent = (currentShort / currentLong - 1) * 100;
  const previousGapPercent = (previousShort / previousLong - 1) * 100;
  const shortSlopePercent = (currentShort / previousShort - 1) * 100;
  const boundaryNumerator = short * longHistory - long * shortHistory, boundaryDenominator = long - short;
  const crossRequiredPrice = boundaryNumerator / boundaryDenominator;
  const priceRiseNumerator = boundaryNumerator - observedPrice * boundaryDenominator;
  const requiredAdditionalRisePercent = Math.max(0, priceRiseNumerator * 100 / (observedPrice * boundaryDenominator));
  const crossed = previousDifference <= 0 && currentDifference > 0;
  const near = previousDifference <= 0 && currentDifference < 0 && Math.abs(gapPercent) < Math.abs(previousGapPercent)
    && shortSlopePercent > 0 && priceRiseNumerator * 100 <= observedPrice * boundaryDenominator * nearPercent;
  return { status: crossed ? "CROSS_OCCURRED" : near ? "APPROACHING" : previousDifference > 0 && currentDifference > 0 ? "ALREADY_ABOVE" : "NONE",
    gapPercent, previousGapPercent, shortSlopePercent, currentShort, currentLong, previousShort, previousLong,
    crossRequiredPrice, requiredAdditionalRisePercent };
}

// Preserve only the categorical verdict and the first supported threshold that qualified.
// Exact ratios, boundary prices and moving averages could reconstruct a raw quote with the public EOD seed.
export function freezeTransitionVerdicts(closedRows, observedPrice) {
  return Object.fromEntries(Object.keys(TRANSITION_PAIRS).map(pair => {
    const broad = observeLiveGoldenTransition(closedRows, observedPrice, pair, 5);
    if (broad.status !== "APPROACHING") return [pair, broad.status];
    const threshold = LIVE_NEAR_THRESHOLDS.find(value => observeLiveGoldenTransition(closedRows, observedPrice, pair, value).status === "APPROACHING");
    return [pair, threshold];
  }));
}

export function readTransitionVerdict(value, threshold) {
  if (!LIVE_NEAR_THRESHOLDS.includes(threshold)) throw new Error("LIVE_THRESHOLD_UNAVAILABLE");
  if (LIVE_NEAR_THRESHOLDS.includes(value)) return value <= threshold ? "APPROACHING" : "NONE";
  if (["CROSS_OCCURRED", "ALREADY_ABOVE", "NONE"].includes(value)) return value;
  return null;
}
