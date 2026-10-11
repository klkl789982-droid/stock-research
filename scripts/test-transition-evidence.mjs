import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { evaluateTransitionEvidence, attachTransitionEvidence, createEvidenceObservationSnapshot, evidenceConfigHash } from "../lib/transition-evidence.mjs";
import { evidencePolicy, applyEvidencePreset } from "../lib/transition-evidence-policy.mjs";
import { buildTransitionRows, parseTransitionFilters, screenTransitions, createTransitionObservationSnapshot } from "../lib/transition-screener.mjs";
import { createTransitionStore } from "../lib/transition-screener-store.mjs";
import { calculateMarketAnalysis } from "../lib/market-analysis-v1.mjs";
import { calculateTechnicalModelFeatures } from "../lib/technical-model-features.mjs";
import { sha256Canonical } from "../lib/snapshot-quality-pipeline.mjs";
import { observeDirectionalTransition } from "../lib/directional-transition.mjs";

// SYNTHETIC fixtures, never stored in Production. MACD below signal but improving.
const points = [90, 92, 95, 99].map((ma5) => ({ ma5, ma20: 100, ma60: 110, close: ma5 }));
const current = { rsi: 45, rsiChange: 2, macd: -2, signal: -1, histogram: -1, previousHistogram: -2, volumeRatio: 150 };
const bars = [{ clpr: 105, trqu: 200, hipr: 106 }, ...Array.from({ length: 20 }, () => ({ clpr: 100, trqu: 100, hipr: 102 }))];
const fixture = { points, pair: "5-20", current, bars };
const full = evaluateTransitionEvidence(fixture);
assert.equal(full.fulfilledCount, 4); assert.equal(full.evaluableCount, 4);
assert.equal(full.categories.momentum.status, "MET", "Signal below is not a blanket exclusion");
assert.equal(full.breakout.status, "MET");
assert.equal(full.version, "transition-evidence-research-v1"); assert.equal(full.configHash, sha256Canonical(evidencePolicy));
assert.deepEqual(full, evaluateTransitionEvidence(structuredClone(fixture)));
assert.equal(evaluateTransitionEvidence({ ...fixture, points: [90, 95, 94, 99].map(ma5 => ({ ma5, ma20: 100, ma60: 110 })) }).categories.gap.status, "PARTIAL");
const crossed = evaluateTransitionEvidence({ ...fixture, points: [...points.slice(0, 3), { ma5: 101, ma20: 100, ma60: 110 }] });
assert.equal(crossed.categories.gap.status, "NOT_MET"); assert.equal(crossed.categories.gap.metrics.phase, "ALREADY_AT_OR_ABOVE");
const slowing = evaluateTransitionEvidence({ ...fixture, points: [100, 97, 95, 94].map(ma5 => ({ ma5, ma20: 110, ma60: 120 })) });
assert.equal(slowing.categories.trend.status, "PARTIAL"); assert.equal(slowing.categories.trend.metrics.phase, "DECLINE_SLOWING");
const falling = evaluateTransitionEvidence({ ...fixture, points: [100, 99, 97, 94].map(ma5 => ({ ma5, ma20: 110, ma60: 120 })) });
assert.equal(falling.categories.trend.status, "NOT_MET");
assert.equal(evaluateTransitionEvidence({ ...fixture, points: [90, 90, 90, 90].map(ma5 => ({ ma5, ma20: 100, ma60: 110 })) }).categories.trend.metrics.phase, "FLAT");
const downVolume = evaluateTransitionEvidence({ ...fixture, bars: [{ ...bars[0], clpr: 95 }, ...bars.slice(1)] });
assert.equal(downVolume.categories.volume.status, "NOT_MET", "Down-day volume is not upward support");
for (const key of ["rsi", "rsiChange", "macd", "signal", "histogram", "previousHistogram"]) {
  const missing = evaluateTransitionEvidence({ ...fixture, current: { ...current, [key]: null } });
  assert.equal(missing.categories.momentum.status, "DATA_MISSING"); assert.equal(missing.evaluableCount, 3); assert.equal(missing.fulfilledCount, 3);
}
assert.equal(evaluateTransitionEvidence({ ...fixture, bars: [{ ...bars[0] }, { ...bars[1], trqu: 0 }] }).categories.volume.status, "DATA_MISSING");
const deadPoints = [110, 109, 108, 107, 105, 102].map(s => ({ ma5: s, ma20: 100, ma60: 100, close: s }));
const dead = observeDirectionalTransition(deadPoints, "ma5", "ma20", "dead");
assert.equal(dead.status, "APPROACHING"); assert.ok(dead.approachStrength > 50);
const deadEvidence = evaluateTransitionEvidence({ ...fixture, points: deadPoints, current: { ...current, rsiChange: -1, histogram: -3 }, bars: [{ ...bars[0], clpr: 95 }, ...bars.slice(1)] });
assert.equal(deadEvidence.categories.trend.status, "NOT_MET"); assert.equal(deadEvidence.fulfilledCount, 0, "High dead approach does not imply bullish evidence");
const paramsFor = (params) => new URLSearchParams(Object.entries(params).filter(([, value]) => value !== "" && value != null));
const filters = (params = {}) => parseTransitionFilters(paramsFor({ rules: "directional-v2", crossDirection: "golden", ...params }));
const candidate = (code, evidence, status = "APPROACHING") => ({ code, name: code, market: "KOSPI", referenceDate: "2026-10-07", missingReasons: [], models: { "A-v1": { score: 80 } }, indicators: { rsi: 45, macdState: "falling", volumeMultiple: 1.5, dailyChangePercent: 5 }, upwardEvidence: { "5-20": evidence }, directionalTransitions: { "5-20": { golden: { status, approachStrength: 60, gapPercent: -1 } } } });
const incomplete = structuredClone(full); incomplete.evaluableCount = 3; incomplete.categories.trend.status = "DATA_MISSING";
const lower = structuredClone(full); lower.fulfilledCount = 1;
const samples = [candidate("000001", incomplete), candidate("000002", lower), candidate("000003", full)];
assert.deepEqual(screenTransitions(samples, filters({ sort: "evidence", direction: "desc" })).results.map(r => r.code), ["000003", "000002", "000001"]);
assert.equal(screenTransitions(samples, filters({ evidenceMin: "2" })).exclusions.filterMissing, 1);
assert.equal(screenTransitions(samples, filters({ trendEvidence: "met" })).exclusions.filterMissing, 1);
for (const q of [{ evidenceMin: "5" }, { evidenceMin: "NaN" }, { evidenceMin: "1.5" }, { momentumEvidence: "toString" }, { volumeEvidence: "INVALID" }]) assert.throws(() => filters(q), /FILTER_INVALID/);
const initial = Object.fromEntries(Object.entries(filters()).map(([k, v]) => [k, v === null ? "" : String(v)]));
for (const preset of ["early", "confirmed", "strong"]) {
  const selected = applyEvidencePreset(initial, preset);
  assert.doesNotThrow(() => parseTransitionFilters(paramsFor(selected)));
  assert.equal(initial.state, "all", "Preset application never mutates user filters");
}
assert.equal(screenTransitions([candidate("000001", full, "CROSS_OCCURRED"), candidate("000002", full, "CONFIRMED"), candidate("000003", full, "NONE")], filters({ state: "CROSSED_OR_CONFIRMED" })).results.length, 2);
assert.equal(screenTransitions([candidate("000003", full, "NONE")], filters(applyEvidencePreset(initial, "strong"))).results.length, 1, "Strong early preset does not require a cross");

// REAL checked-in official EOD data; read-only. Never run production or modify snapshots.
const latest = (await readdir("data/history")).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/u.test(f)).sort().at(-1);
const history = JSON.parse(await readFile(`data/history/${latest}`, "utf8"));
const seed = JSON.parse(await readFile(`data/analysis/market-seeds/${latest}`, "utf8"));
const calendar = JSON.parse(await readFile("data/trading-calendar/status.json", "utf8"));
const legacy = buildTransitionRows({ history, seed, calendar });
const inputsBefore = sha256Canonical({ history, seed, calendar, legacy });
const rows = attachTransitionEvidence(legacy, seed);
assert.equal(sha256Canonical({ history, seed, calendar, legacy }), inputsBefore);
for (let index = 0; index < rows.length; index++) {
  const { upwardEvidence, ...unchanged } = rows[index];
  assert.deepEqual(unchanged, legacy[index], "Existing A-D scores, cross states, strength, inputs unchanged");
  if (upwardEvidence) for (const value of Object.values(upwardEvidence)) assert.equal(value.configHash, evidenceConfigHash);
}
assert.deepEqual(createTransitionObservationSnapshot({ rows, history, seed }), createTransitionObservationSnapshot({ rows: legacy, history, seed }), "Legacy immutable hashes unchanged");
for (const record of seed.records.filter(r => r.eligible && rows.some(row => row.code === r.code && row.upwardEvidence))) {
  const input = record.rows.map(([basDt, mkp, hipr, lopr, clpr, trqu]) => ({ basDt, mkp, hipr, lopr, clpr, trqu }));
  const market = calculateMarketAnalysis(input).indicators, features = calculateTechnicalModelFeatures(input);
  for (const [a, b] of [[market.rsi14, features.rsi], [market.macd, features.macd], [market.signal, features.signal], [market.histogram, features.histogram], [market.volumeRatio, features.volumeRatio]]) assert.ok(Math.abs(a - b) < 1e-9, "Reused features match existing indicators");
}
const snapshot = createEvidenceObservationSnapshot({ rows, history, seed });
assert.deepEqual(snapshot, createEvidenceObservationSnapshot({ rows: structuredClone(rows), history, seed }));
assert.equal(snapshot.futureOutcomes.status, "NOT_OBSERVED"); assert.equal(snapshot.futureOutcomes.entryContract, null);
assert.equal(new Set(snapshot.records.map(r => r.observationId)).size, snapshot.records.length);
const { contentHash, ...payload } = snapshot; assert.equal(contentHash, sha256Canonical(payload));
const load = createTransitionStore(); const [one, two] = await Promise.all([load(), load()]); assert.strictEqual(one, two); assert.strictEqual(await load(), one);
assert.deepEqual(one.rows, rows);
const summary = Object.fromEntries(Object.keys(rows.find(r => r.upwardEvidence).upwardEvidence).map(pair => [pair, {
  goldenApproaching: rows.filter(r => r.directionalTransitions?.[pair]?.golden.status === "APPROACHING").length,
  fullyEvaluable: rows.filter(r => r.upwardEvidence?.[pair]?.evaluableCount === 4).length,
  metCounts: Object.fromEntries(["gap", "trend", "momentum", "volume"].map(key => [key, rows.filter(r => r.upwardEvidence?.[pair]?.categories[key].status === "MET").length])),
  presets: Object.fromEntries(["early", "confirmed", "strong"].map(key => [key, screenTransitions(rows, filters({ ...applyEvidencePreset(initial, key), pair })).results.length])),
}]));
const caseSelectors = {
  highGoldenApproachWeakEvidence: r => r.directionalTransitions?.["5-20"]?.golden.status === "APPROACHING" && r.directionalTransitions["5-20"].golden.approachStrength >= 70 && r.upwardEvidence["5-20"].fulfilledCount <= 1,
  declineContinuing: r => r.upwardEvidence?.["5-20"]?.categories.trend.metrics.phase === "DECLINING",
  alreadyGoldenCross: r => r.directionalTransitions?.["5-20"]?.golden.status === "CROSS_OCCURRED",
  gapOnlyNotTrend: r => r.upwardEvidence?.["5-20"]?.categories.gap.status === "MET" && r.upwardEvidence["5-20"].categories.trend.status !== "MET",
  downDayVolumeIncrease: r => r.upwardEvidence?.["5-20"]?.categories.volume.metrics.volumeGrowthPercent > 0 && r.upwardEvidence["5-20"].categories.volume.metrics.priceChangePercent < 0,
};
const actualCases = Object.fromEntries(Object.entries(caseSelectors).map(([key, select]) => {
  const found = rows.find(select); return [key, found ? { code: found.code, name: found.name, fulfilledCount: found.upwardEvidence["5-20"].fulfilledCount } : null];
}));
console.log(JSON.stringify({ actualOfficialDate: history.asOfDate, universe: rows.length, validated: rows.filter(r => r.upwardEvidence).length, summary }));
console.log(JSON.stringify({ actualCases, missingRsiMacd: "synthetic only: all 508 eligible actual inputs have indicators" }));
console.log("transition evidence synthetic/actual causal inputs/coverage/presets/AND/sort/features parity/immutable hashes/cache tests passed");
