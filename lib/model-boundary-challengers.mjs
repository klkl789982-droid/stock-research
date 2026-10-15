import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { calculateTechnicalStrengthV3Raw } from "./technical-strength-v3-raw.mjs";
import { calculateTechnicalModelFeaturesV2 } from "./technical-model-features-v2.mjs";
import { calculateTechnicalModelFeatures } from "./technical-model-features.mjs";
import { calculateTrendStrength } from "./trend-strength.mjs";
import { calculateEntryStrength } from "./entry-strength.mjs";
import { calculateCombinedTechnicalScore } from "./combined-technical-score.mjs";

// This module has no production callers. Invocation is an explicit offline evaluation.
// The caller must preserve the original quality gate; raw OHLCV alone is not certification.
const DEFINITIONS = {
  "A-v3": { parent: "A-v2", minimumHistory: 260, formula: "A-v1 weights and thresholds; flat RSI=50; clamp(rawScore,0,100)", featureVersion: "a-v3-raw", tieBreak: ["score:desc", "rawScore:desc", "code:asc"] },
  "C-v2": { parent: "C-v1", minimumHistory: 35, formula: "C-v1 weights and thresholds; flat RSI=50; all required indicators present", featureVersion: "technical-features-v2", tieBreak: ["score:desc", "code:asc"] },
  "D-v2": { parent: "D-v1", minimumHistory: 260, formula: "unchanged B-v1 * eligible C-v2 / 100", featureVersion: "B-v1 legacy features + C-v2 corrected features", tieBreak: ["score:desc", "code:asc"] },
};
export const BOUNDARY_CORRECTION_DEFINITIONS = Object.freeze(Object.fromEntries(
  Object.entries(DEFINITIONS).map(([version, definition]) => [version, Object.freeze({
    ...definition, tieBreak: Object.freeze(definition.tieBreak), version,
    role: "challenger", status: "evaluation", promotionStatus: "notApproved",
    evaluationOnly: true, precision: 2,
    momentumConvention: "N observations / N-1 close-to-close return intervals",
    rsiConvention: "14 simple-average changes; flat=50; gains-only=100; losses-only=0",
  })]),
));
const sourceHash = (file) => createHash("sha256")
  .update(readFileSync(new URL(file, import.meta.url), "utf8").replace(/\r\n?/g, "\n"))
  .digest("hex");
const lineage = {
  adapter: sourceHash("./model-boundary-challengers.mjs"),
  aV3Raw: sourceHash("./technical-strength-v3-raw.mjs"),
  correctedFeatures: sourceHash("./technical-model-features-v2.mjs"),
  legacyFeatures: sourceHash("./technical-model-features.mjs"),
  bV1: sourceHash("./trend-strength.mjs"),
  cV1Weights: sourceHash("./entry-strength.mjs"),
  dProduct: sourceHash("./combined-technical-score.mjs"),
};
export const BOUNDARY_CORRECTION_HASHES = Object.freeze(Object.fromEntries(
  Object.entries(BOUNDARY_CORRECTION_DEFINITIONS).map(([version, definition]) => [version,
    createHash("sha256").update(JSON.stringify({ definition, lineage })).digest("hex")]),
));
const finite = (value) => typeof value === "number" && Number.isFinite(value);
const numeric = (value) => (typeof value === "number" || typeof value === "string" && value.trim() !== "") && Number.isFinite(Number(value));
const round = (value) => Number(value.toFixed(2));
const C_FIELDS = ["currentPrice", "currentOpen", "currentHigh", "currentLow", "dailyChangeRate", "closeLocation", "volumeRatio", "momentum3", "momentum5", "rsi", "rsiChange", "histogram", "previousHistogram", "atr14", "ma5", "ma20", "ma20Distance"];
const B_FIELDS = ["currentPrice", "ma20", "ma60", "ma120", "ma20Slope", "ma60Slope", "ma20Distance", "persistenceAboveMa20", "momentum20", "histogram", "atr14", "position52w"];
const absentFeatures = (features, fields) => fields.filter((key) => !finite(features[key]) || key === "atr14" && features[key] <= 0);

function validDate(value) {
  if (!/^\d{8}$/.test(value)) return false;
  const iso = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
  const date = new Date(`${iso}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === iso;
}
function historyProblems(rows) {
  const reasons = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const date = String(row?.basDt ?? "");
    if (!validDate(date) || index > 0 && date >= String(rows[index - 1]?.basDt)) reasons.push("invalidHistoryDates");
    if (!["mkp", "hipr", "lopr", "clpr", "trqu"].every((key) => numeric(row?.[key]))) { reasons.push("invalidOHLCV"); continue; }
    const [open, high, low, close, volume] = ["mkp", "hipr", "lopr", "clpr", "trqu"].map((key) => Number(row[key]));
    if (Math.min(open, high, low, close) <= 0 || volume <= 0 || high < Math.max(open, close, low) || low > Math.min(open, close, high)) reasons.push("invalidOHLCV");
  }
  if (rows.length > 0 && !numeric(rows[0]?.fltRt)) reasons.push("missingDailyChangeRate");
  return [...new Set(reasons)];
}
function envelope(version, reasons = [], details = {}) {
  return {
    ...BOUNDARY_CORRECTION_DEFINITIONS[version], formulaHash: BOUNDARY_CORRECTION_HASHES[version],
    eligible: reasons.length === 0, score: null, rawScore: null, exclusionReasons: [...new Set(reasons)], ...details,
  };
}

export function calculateBoundaryCorrectionChallengers({ priceHistory, qualityEligibility } = {}) {
  const rows = Array.isArray(priceHistory) ? priceHistory.slice(0, 260) : [];
  const inputReasons = qualityEligibility?.eligible === true ? [] : ["qualityEligibilityNotConfirmed"];
  inputReasons.push(...historyProblems(rows));
  const results = Object.fromEntries(Object.keys(BOUNDARY_CORRECTION_DEFINITIONS).map((version) => {
    const reasons = [...inputReasons];
    if (rows.length < BOUNDARY_CORRECTION_DEFINITIONS[version].minimumHistory) reasons.push("insufficientHistory");
    return [version, envelope(version, reasons)];
  }));
  if (inputReasons.length > 0) return results;

  const corrected = rows.length >= 35 ? calculateTechnicalModelFeaturesV2(rows) : null;
  if (results["C-v2"].eligible) {
    const missing = absentFeatures(corrected, C_FIELDS);
    if (missing.length > 0) results["C-v2"] = envelope("C-v2", ["missingRequiredFeatures"], { missingFeatures: missing });
    else {
      const calculated = calculateEntryStrength(corrected);
      results["C-v2"] = finite(calculated.entryStrength)
        ? envelope("C-v2", [], { score: calculated.entryStrength, details: calculated })
        : envelope("C-v2", ["nonFiniteScore"]);
    }
  }
  if (rows.length < 260) return results;
  // B-v1 retains its original feature lineage, even though its formula ignores RSI.
  const legacyFeatures = calculateTechnicalModelFeatures(rows);
  const bMissing = absentFeatures(legacyFeatures, B_FIELDS);
  if (results["A-v3"].eligible) {
    const missing = [...new Set([...bMissing, ...absentFeatures(corrected, ["rsi", "previousHistogram", "volumeRatio"])])];
    if (missing.length > 0) results["A-v3"] = envelope("A-v3", ["missingRequiredFeatures"], { missingFeatures: missing });
    else {
      const source = calculateTechnicalStrengthV3Raw(rows);
      const raw = Object.values(source.weightedContributions).reduce((sum, value) => sum + value, 0) + source.reversalBonus - source.penalty;
      results["A-v3"] = finite(raw)
        ? envelope("A-v3", [], { score: round(Math.min(100, Math.max(0, raw))), rawScore: round(raw), details: source })
        : envelope("A-v3", ["nonFiniteScore"]);
    }
  }
  if (results["D-v2"].eligible) {
    if (!results["C-v2"].eligible || bMissing.length > 0) {
      results["D-v2"] = envelope("D-v2", ["componentIneligible"], { components: { "B-v1": { eligible: bMissing.length === 0, missingFeatures: bMissing }, "C-v2": { eligible: results["C-v2"].eligible, exclusionReasons: results["C-v2"].exclusionReasons } } });
    } else {
      const b = calculateTrendStrength(legacyFeatures).trendStrength;
      results["D-v2"] = finite(b)
        ? envelope("D-v2", [], { score: calculateCombinedTechnicalScore(b, results["C-v2"].score), components: { "B-v1": b, "C-v2": results["C-v2"].score } })
        : envelope("D-v2", ["nonFiniteScore"]);
    }
  }
  return results;
}

export function compareBoundaryChallengerRecords(left, right, version) {
  if (!(version in BOUNDARY_CORRECTION_DEFINITIONS)) throw new Error(`Unknown boundary challenger: ${version}`);
  const a = left.challengers?.[version], b = right.challengers?.[version];
  if (!a?.eligible || !b?.eligible || !finite(a.score) || !finite(b.score)) throw new Error("Rank only eligible challenger results");
  if (version === "A-v3" && (!finite(a.rawScore) || !finite(b.rawScore))) throw new Error("A-v3 ranking requires finite raw scores");
  if (left.code == null || right.code == null || !String(left.code).trim() || !String(right.code).trim()) throw new Error("Ranking requires stock codes");
  const leftCode = String(left.code).trim().toUpperCase().padStart(6, "0");
  const rightCode = String(right.code).trim().toUpperCase().padStart(6, "0");
  return b.score - a.score || (version === "A-v3" ? b.rawScore - a.rawScore : 0) || (leftCode < rightCode ? -1 : leftCode > rightCode ? 1 : 0);
}
