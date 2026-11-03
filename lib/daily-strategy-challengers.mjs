import { hashObject, scoreRank } from "./rank-backtest-engine.mjs";

export const researchModels = ["A-v1", "B-v1", "C-v1", "D-v1"];
export const basketSize = 10;
export const median = (values) => {
  const a = values.filter(Number.isFinite).sort((left, right) => left - right);
  return a.length ? (a[(a.length - 1) >> 1] + a[a.length >> 1]) / 2 : null;
};

// No return, execution price, later snapshot or benchmark outcome enters selection.
export function researchUniverse(snapshot, model) {
  if (snapshot.dataQuality?.certification?.eligibleForRanking !== true) return [];
  const rows = snapshot.records.flatMap((r) => {
    const meta = scoreRank(snapshot, r, model);
    if (r.qualityEligibility?.eligible !== true || !meta || meta.rank < 1) return [];
    const raw = r.modelDetailsByVersion?.["A-v2"]?.rawIndicators;
    return [{ ticker: r.code, market: r.market, rank: meta.rank, score: meta.score,
      momentum: raw?.priceMomentum, volatility: raw?.volatility20, flags: r.riskFlags, factors: r.factors,
      b: scoreRank(snapshot, r, "B-v1")?.score, c: scoreRank(snapshot, r, "C-v1")?.score }];
  }).sort((a, b) => a.rank - b.rank);
  if (new Set(snapshot.records.map((r) => r.code)).size !== snapshot.records.length ||
      rows.some((r, i) => r.rank !== i + 1)) return [];
  return rows;
}

export function marketConditions(rows) {
  const conditions = new Map();
  for (const market of ["KOSPI", "KOSDAQ"]) {
    const all = rows.filter((r) => r.market === market);
    const both = all.filter((r) => Number.isFinite(r.momentum) && Number.isFinite(r.volatility) && r.volatility > 0);
    if (!both.length || both.length !== all.length) continue;
    const momentum = median(both.map((r) => r.momentum)), volatility = median(both.map((r) => r.volatility));
    conditions.set(market, { momentum, volatility,
      band: momentum > volatility ? "up" : momentum < -volatility ? "down" : "sideways" });
  }
  return conditions;
}

export function makeSelections(rows, model, candidate) {
  if (rows.length < basketSize) return [];
  const base = rows.slice(0, basketSize), markets = marketConditions(rows);
  const select = (id, members, capacity = basketSize, allocationFraction = 1) =>
    ({ id, members, capacity, allocationFraction });
  const results = [select(model, base), select("eligible-equal-weight", rows, rows.length)];
  const by = (key) => (a, b) => key(b) - key(a) || a.rank - b.rank;
  const completeMom = rows.every((r) => Number.isFinite(r.momentum));
  if (completeMom) results.push(select("simple-momentum", [...rows].sort(by((r) => r.momentum)).slice(0, basketSize)));
  const version = candidate.modelId + "-" + candidate.version;
  if (model === "A-v1" && rows.every((r) => markets.has(r.market))) {
    const strength = (r) => (r.momentum - markets.get(r.market).momentum) / r.volatility;
    results.push(select(version, [...rows].sort(by(strength)).slice(0, basketSize)));
  } else if (model === "B-v1" && base.every((r) => markets.has(r.market))) {
    results.push(select(version, base.filter((r) => markets.get(r.market).band === "up")));
  } else if (model === "C-v1" && base.every((r) => typeof r.flags?.overbought === "boolean")) {
    results.push(select(version, base.filter((r) => !r.flags.overbought)));
  } else if (model === "D-v1") {
    if (rows.every((r) => Number.isFinite(r.b) && Number.isFinite(r.c))) {
      results.push(select(version, [...rows].sort(by((r) => Math.min(r.b, r.c))).slice(0, basketSize)));
      results.push(select("B-on-D-universe", [...rows].sort(by((r) => r.b)).slice(0, basketSize)));
      results.push(select("C-on-D-universe", [...rows].sort(by((r) => r.c)).slice(0, basketSize)));
    }
    results.push(select("D-v1-cap5pct", base, basketSize, 0.5));
  }
  return results;
}

export function inputLineage(snapshot, model) {
  // D depends on both B and C. All candidates/diagnostics use stored A-v2 raw indicators.
  const versions = [...new Set([model, "A-v2", ...(model === "D-v1" ? ["B-v1", "C-v1"] : [])])];
  const lineage = {};
  for (const v of versions) {
    const source = snapshot.sourceManifest?.modelFormulaHashes?.[v];
    const definition = snapshot.modelVersionDefinitions?.[v]?.formulaHash;
    if (!/^[a-f0-9]{64}$/.test(source ?? "")) return null;
    // The manifest hashes source code; modelVersionDefinitions hashes a formula specification.
    lineage[v] = { source, definition: definition ?? null };
    if (v === "A-v2") {
      const evidence = new Set(snapshot.records.map((r) => r.modelDetailsByVersion?.[v])
        .filter((a) => a?.rawIndicators).map((a) => a.formulaHash));
      if (evidence.size !== 1 || !/^[a-f0-9]{64}$/.test(definition ?? "") || !evidence.has(definition)) return null;
    }
  }
  return { id: hashObject(lineage), lineage };
}
