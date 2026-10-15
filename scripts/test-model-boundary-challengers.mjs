import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { calculateBoundaryCorrectionChallengers as calculate, BOUNDARY_CORRECTION_HASHES as hashes, BOUNDARY_CORRECTION_DEFINITIONS as definitions, compareBoundaryChallengerRecords as compare } from "../lib/model-boundary-challengers.mjs";
import { calculateTechnicalModelFeaturesV2 as features } from "../lib/technical-model-features-v2.mjs";
import { calculateTechnicalModelFeatures as legacyFeatures } from "../lib/technical-model-features.mjs";
import { calculateSnapshotModels } from "../lib/model-score-engine.mjs";
import { MODEL_A_V2_FORMULA_HASH } from "../lib/technical-strength-v2.mjs";

const history = (n = 260, fn = () => 100) => Array.from({ length: n }, (_, i) => {
  const close = fn(n - i, i);
  return { basDt: new Date(Date.UTC(2026, 9, 15 - i)).toISOString().slice(0, 10).replaceAll("-", ""), mkp: close, hipr: close + 1, lopr: close - 1, clpr: close, trqu: 100, fltRt: 0 };
});
const run = (rows, qualityEligibility = { eligible: true }) => calculate({ priceHistory: rows, qualityEligibility });
const flat = history();
const before = JSON.stringify(flat);
const old = calculateSnapshotModels(flat), fixed = run(flat);
assert.equal(legacyFeatures(flat).rsi, 100);
assert.equal(features(flat).rsi, 50);
assert.equal(fixed["A-v3"].score, 34.4);
assert.equal(fixed["C-v2"].score, 56.4);
assert.equal(old.modelA.finalTechnicalScore, 23.9);
assert.equal(old.modelC.entryStrength, 40);
assert.equal(JSON.stringify(flat), before, "Never mutate source rows");
assert.equal(fixed["D-v2"].components["B-v1"], old.modelB.trendStrength);
assert.equal(fixed["D-v2"].score, Number((old.modelB.trendStrength * 56.4 / 100).toFixed(2)));
for (const [fn, expected] of [[(n) => 100 + n, 100], [(n) => 100 - n / 10, 0]]) {
  const rows = history(260, fn);
  assert.equal(features(rows).rsi, expected);
  const current = calculateSnapshotModels(rows), next = run(rows);
  assert.equal(next["A-v3"].score, current.modelAV2.finalScore);
  assert.equal(next["C-v2"].score, current.modelC.entryStrength);
  assert.equal(next["D-v2"].score, current.modelD);
}
const mixed = history(260, (n, i) => 100 + n / 20 + Math.sin(i) * 2);
const mixedOld = calculateSnapshotModels(mixed), mixedNew = run(mixed);
assert.equal(mixedNew["A-v3"].score, mixedOld.modelAV2.finalScore);
assert.equal(mixedNew["C-v2"].score, mixedOld.modelC.entryStrength);
assert.equal(mixedNew["D-v2"].score, mixedOld.modelD);
for (const n of [0, 14, 15, 33, 34, 35, 259, 260]) {
  const r = run(history(n));
  assert.equal(r["C-v2"].eligible, n >= 35, `C-v2 minimum at ${n}`);
  assert.equal(r["A-v3"].eligible, n >= 260, `A-v3 minimum at ${n}`);
  assert.equal(r["D-v2"].eligible, n >= 260, `D-v2 minimum at ${n}`);
  for (const value of Object.values(r)) if (!value.eligible) assert.equal(value.score, null);
}
assert.equal(features(history(34)).previousHistogram, null);
assert.notEqual(features(history(35)).previousHistogram, null);
for (const quality of [undefined, null, { eligible: false }, { eligible: "true" }]) {
  const r = calculate({ priceHistory: flat, qualityEligibility: quality });
  assert.ok(Object.values(r).every((x) => !x.eligible && x.score === null));
}
for (const change of [
  (r) => { r[0].clpr = null; }, (r) => { r[0].clpr = ""; },
  (r) => { r[0].clpr = Infinity; }, (r) => { r[0].trqu = 0; },
  (r) => { r[0].hipr = 1; }, (r) => { delete r[0].fltRt; },
  (r) => { r[1].basDt = r[0].basDt; }, (r) => { r[0].basDt = "20269999"; }, (r) => { r[0].basDt = "20260230"; }, (r) => r.reverse(),
]) {
  const rows = structuredClone(flat); change(rows);
  assert.ok(Object.values(run(rows)).every((x) => !x.eligible && x.score === null));
}
const zeroAtr = flat.map((r) => ({ ...r, hipr: 100, lopr: 100 }));
const missing = run(zeroAtr);
assert.ok(Object.values(missing).every((x) => !x.eligible && x.score === null));
assert.ok(missing["C-v2"].missingFeatures.includes("atr14"));
assert.ok(missing["D-v2"].exclusionReasons.includes("componentIneligible"));
// Test a previous flat RSI window followed by one positive current change.
const firstGain = structuredClone(flat); firstGain[0] = { ...firstGain[0], clpr: 101, hipr: 102 };
assert.equal(features(firstGain).rsi, 100);
assert.equal(features(firstGain).rsiChange, 50);
assert.equal(legacyFeatures(firstGain).rsiChange, 0);
// A real high-scoring path reaches the upper clamp without tuning any coefficients.
const highScore = history(260, (n, i) => i < 15 ? 300 - Math.floor(i / 2) * 6 - (i % 2) * 10 : Math.max(50, 260 - i));
highScore[0].trqu = 1000;
const capped = run(highScore)["A-v3"];
assert.ok(capped.rawScore > 100);
assert.equal(capped.score, 100);
// A-v3's clamp and raw-score tie break must retain the A-v2 behavior.
const tie = (code, score, rawScore) => ({ code, challengers: { "A-v3": { eligible: true, score, rawScore } } });
const ordered = [tie("000003",100,105),tie("000002",100,110),tie("000001",100,110)].sort((a,b)=>compare(a,b,"A-v3"));
assert.deepEqual(ordered.map((x) => x.code), ["000001","000002","000003"]);
assert.throws(() => compare({ code: "1" }, { code: "2" }, "A-v3"), /eligible/);
assert.throws(() => compare({}, {}, "A-v1"), /Unknown/);
assert.ok(compare(tie("2",100,105),tie("000010",100,105),"A-v3") < 0);
assert.throws(() => compare(tie("2",100,NaN),tie("10",100,105),"A-v3"), /raw scores/);
assert.throws(() => compare(tie("",100,105),tie("10",100,105),"A-v3"), /stock codes/);
for (const [version, value] of Object.entries(fixed)) {
  assert.equal(value.formulaHash, hashes[version]);
  assert.match(value.formulaHash, /^[a-f0-9]{64}$/);
  assert.equal(value.evaluationOnly, true);
  assert.equal(value.promotionStatus, "notApproved");
  assert.equal(value.role, "challenger");
  assert.equal(value.minimumHistory, definitions[version].minimumHistory);
}
assert.equal(new Set(Object.values(hashes)).size, 3);
assert.equal(MODEL_A_V2_FORMULA_HASH, "a75a4790a30cabe9885bae8b75567fa6bb1a244626d7f74083b955e901b8e8ff");
const pinned = {
  "lib/technical-strength.mjs": "b4af69fd788044e2c54ee11ce79932ab029ae57a",
  "lib/technical-model-features.mjs": "91db184637e8841f52462e462eba74e0086de0b9",
  "lib/trend-strength.mjs": "9f154704c6e89ddf15ef7ed3d0575170c155d709",
  "lib/entry-strength.mjs": "40bd077d9b3eaf5a1efb757f0ee7eb4ce4d4e8d6",
  "lib/model-score-engine.mjs": "49d1ec5e3c4375bff3a430f2a8138fd7f3b3173f",
};
for (const [file, hash] of Object.entries(pinned)) {
  const bytes = fs.readFileSync(file);
  assert.equal(createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex"), hash, `${file} legacy lineage unchanged`);
}
const registry = JSON.parse(fs.readFileSync("data/model-registry.json"));
assert.equal(new Set(registry.models.map((m) => m.modelVersion)).size, registry.models.length);
for (const version of Object.keys(hashes)) {
  const model = registry.models.find((m) => m.modelVersion === version);
  assert.equal(model.formulaHash, hashes[version]);
  assert.equal(model.evaluationOnly, true);
  assert.equal(model.promotionStatus, "notApproved");
}
assert.equal(registry.models.filter((m) => m.status === "active").map((m) => m.modelVersion).join(), "A-v1");
console.log(JSON.stringify({ status: "PASS", checks: ["flat/gain/loss/mixed RSI", "previous-flat RSI direction", "35/260 history boundaries", "quality and invalid-input fail-closed", "missing ATR fail-closed", "A-v3 deterministic tie break", "legacy source and A-v2 hash immutable", "registry evaluation-only; no champion activation"], formulaHashes: hashes }, null, 2));
