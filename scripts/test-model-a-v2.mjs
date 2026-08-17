import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import {
  assignModelAV2Ranks,
  finalizeTechnicalStrengthV2,
  MODEL_A_V2_FORMULA_HASH,
} from "../lib/technical-strength-v2.mjs";
import { calculateTechnicalStrength } from "../lib/technical-strength.mjs";
import { calculateTechnicalModelFeatures } from "../lib/technical-model-features.mjs";
import { calculateTrendStrength } from "../lib/trend-strength.mjs";
import { calculateEntryStrength } from "../lib/entry-strength.mjs";
import { calculateCombinedTechnicalScore } from "../lib/combined-technical-score.mjs";
import { calculateSnapshotModels } from "../lib/model-score-engine.mjs";
import {
  assignRanks,
  createHistoryRecord,
  createTopLists,
  createTopListsByVersion,
  MODEL_DEFINITIONS,
  MODEL_HISTORY_SCHEMA_VERSION,
  MODEL_VERSION_DEFINITIONS,
  validateSnapshot,
} from "../lib/model-history-schema.mjs";

const finalizeRaw = (rawScore) => finalizeTechnicalStrengthV2({ technicalScore: rawScore, reversalBonus: 0, penalty: 0 });
assert.equal(finalizeRaw(103.37).finalScore, 100);
assert.equal(finalizeRaw(100.48).finalScore, 100);
assert.equal(finalizeRaw(-1.06).finalScore, 0);
assert.equal(finalizeRaw(50).finalScore, 50);

const syntheticHistory = Array.from({ length: 260 }, (_, index) => {
  const date = new Date(Date.UTC(2026, 7, 13 - index)).toISOString().slice(0, 10).replaceAll("-", "");
  const close = 10000 + (260 - index) * 17 + Math.sin(index / 7) * 120;
  return { basDt: date, clpr: String(close), mkp: String(close - 30), hipr: String(close + 90), lopr: String(close - 110), trqu: String(100000 + index * 137), fltRt: "0.5" };
});
const expectedA = calculateTechnicalStrength(syntheticHistory, null);
const expectedFeatures = calculateTechnicalModelFeatures(syntheticHistory, null);
const expectedB = calculateTrendStrength(expectedFeatures);
const expectedC = calculateEntryStrength(expectedFeatures);
const expectedD = calculateCombinedTechnicalScore(expectedB.trendStrength, expectedC.entryStrength);
const parallel = calculateSnapshotModels(syntheticHistory);
assert.deepEqual(parallel.modelA, expectedA);
assert.deepEqual(parallel.modelB, expectedB);
assert.deepEqual(parallel.modelC, expectedC);
assert.equal(parallel.modelD, expectedD);
assert.equal(parallel.modelAV2.rawScore, expectedA.finalTechnicalScore);
assert.equal(parallel.modelAV2.finalScore, Math.min(100, Math.max(0, expectedA.finalTechnicalScore)));

const tieRecords = [
  { code: "000003", scoresByVersion: { "A-v2": 100 }, rawScoresByVersion: { "A-v2": 100.48 }, ranksByVersion: { "A-v1": 3, "A-v2": null }, scores: { modelA: 3, modelB: 13, modelC: 23, modelD: 33 }, ranks: { modelA: 3, modelB: 13, modelC: 23, modelD: 33 } },
  { code: "000002", scoresByVersion: { "A-v2": 100 }, rawScoresByVersion: { "A-v2": 103.37 }, ranksByVersion: { "A-v1": 2, "A-v2": null }, scores: { modelA: 2, modelB: 12, modelC: 22, modelD: 32 }, ranks: { modelA: 2, modelB: 12, modelC: 22, modelD: 32 } },
  { code: "000001", scoresByVersion: { "A-v2": 100 }, rawScoresByVersion: { "A-v2": 103.37 }, ranksByVersion: { "A-v1": 1, "A-v2": null }, scores: { modelA: 1, modelB: 11, modelC: 21, modelD: 31 }, ranks: { modelA: 1, modelB: 11, modelC: 21, modelD: 31 } },
  { code: "000005", scoresByVersion: { "A-v2": 0 }, rawScoresByVersion: { "A-v2": -2 }, ranksByVersion: { "A-v1": 5, "A-v2": null }, scores: { modelA: 5, modelB: 15, modelC: 25, modelD: 35 }, ranks: { modelA: 5, modelB: 15, modelC: 25, modelD: 35 } },
  { code: "000004", scoresByVersion: { "A-v2": 0 }, rawScoresByVersion: { "A-v2": -1.06 }, ranksByVersion: { "A-v1": 4, "A-v2": null }, scores: { modelA: 4, modelB: 14, modelC: 24, modelD: 34 }, ranks: { modelA: 4, modelB: 14, modelC: 24, modelD: 34 } },
];
const legacyBefore = JSON.stringify(tieRecords.map(({ scores, ranks, ranksByVersion }) => ({ scores, ranks, aV1Rank: ranksByVersion["A-v1"] })));
assignModelAV2Ranks(tieRecords);
assert.deepEqual([...tieRecords].sort((a, b) => a.ranksByVersion["A-v2"] - b.ranksByVersion["A-v2"]).map((record) => record.code), ["000001", "000002", "000003", "000004", "000005"]);
assert.equal(JSON.stringify(tieRecords.map(({ scores, ranks, ranksByVersion }) => ({ scores, ranks, aV1Rank: ranksByVersion["A-v1"] }))), legacyBefore);

const records553 = Array.from({ length: 553 }, (_, index) => {
  const rawScore = ((index * 37) % 140) - 20;
  return {
    code: String(553 - index).padStart(6, "0"),
    scoresByVersion: { "A-v2": finalizeRaw(rawScore).finalScore },
    rawScoresByVersion: { "A-v2": finalizeRaw(rawScore).rawScore },
    ranksByVersion: { "A-v1": index + 1, "A-v2": null },
  };
});
assignModelAV2Ranks(records553);
const firstRanks = records553.map((record) => record.ranksByVersion["A-v2"]);
assert.deepEqual([...firstRanks].sort((a, b) => a - b), Array.from({ length: 553 }, (_, index) => index + 1));
assignModelAV2Ranks(records553);
assert.deepEqual(records553.map((record) => record.ranksByVersion["A-v2"]), firstRanks);

const schemaRecords = Array.from({ length: 553 }, (_, index) => createHistoryRecord({
  stock: { code: String(index + 1).padStart(6, "0"), name: `종목${index + 1}`, market: index % 2 ? "KOSPI" : "KOSDAQ", marketCap: 100000000000 + index },
  asOfDate: "2026-08-17", closePrice: 10000 + index, openPrice: 9900 + index, avgVolume20d: 100000 + index, historyRows: 260,
  modelA: { ...parallel.modelA, finalTechnicalScore: index / 10 }, modelAV2: { ...parallel.modelAV2, rawScore: index / 10, finalScore: index / 10 },
  modelB: { ...parallel.modelB, trendStrength: index / 10 }, modelC: { ...parallel.modelC, entryStrength: index / 10 }, modelD: index / 20, modelE: null,
}));
assignRanks(schemaRecords);
const syntheticSnapshot = {
  schemaVersion: MODEL_HISTORY_SCHEMA_VERSION,
  asOfDate: "2026-08-17",
  modelDefinitions: MODEL_DEFINITIONS,
  modelVersionDefinitions: MODEL_VERSION_DEFINITIONS,
  topLists: createTopLists(schemaRecords),
  topListsByVersion: createTopListsByVersion(schemaRecords),
  records: schemaRecords,
};
assert.deepEqual(validateSnapshot(syntheticSnapshot, 553), []);

const historyBuffer = fs.readFileSync("data/history/2026-08-13.json");
assert.equal(createHash("sha256").update(historyBuffer).digest("hex"), "5e4d913a832d241c90808583eaee1ee7c1165535953c7ac1378c8275f8becdaa");
assert.match(MODEL_A_V2_FORMULA_HASH, /^[a-f0-9]{64}$/);

console.log(JSON.stringify({
  formulaHash: MODEL_A_V2_FORMULA_HASH,
  clampCases: "passed",
  deterministicTieBreak: "passed",
  completeRanks: records553.length,
  schemaValidationRecords: schemaRecords.length,
  legacyFieldsUnchanged: true,
  parallelModelResultsUnchanged: true,
  historySha256Unchanged: true,
  apiIntegration: "verified separately against the local Next.js server",
}, null, 2));
