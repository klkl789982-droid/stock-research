import assert from "node:assert/strict";
import { buildModelTopPerformance } from "../lib/model-top-performance.mjs";
const record = (code, rank) => ({ code, scores: { modelA: 1, modelB: 1, modelC: 1, modelD: 1 }, ranks: { modelA: rank, modelB: rank, modelC: rank, modelD: rank }, scoresByVersion: { "A-v1": 1 }, ranksByVersion: { "A-v1": rank } });
const snapshot = { asOfDate: "2026-09-30", records: Array.from({ length: 20 }, (_, index) => record(String(index + 1).padStart(6, "0"), index + 1)) };
const outcome = { signalDate: "2026-09-30", targetTradingDate: "2026-10-01", records: snapshot.records.map((item, index) => ({ ticker: item.code, status: index === 19 ? "PENDING" : "MATURE", returnPercent: index + 1 })) };
const result = buildModelTopPerformance({ snapshots: [snapshot], outcomes: [outcome] });
const b5 = result.daily.find((item) => item.modelVersion === "B-v1" && item.topN === 5); assert.equal(b5.observationCount, 5); assert.equal(b5.meanReturn, 3); assert.equal(b5.universeMeanReturn, 10); assert.equal(b5.excessReturn, -7); assert.equal(result.matureSignalDates.length, 1); console.log("model TOP performance mature-only/top5/top10/top20 test passed");
