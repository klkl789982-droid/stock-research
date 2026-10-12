import { MARKET_SOURCE_CONTRACT, PRICE_FIELDS, SOURCE_IDS, requireResearchRights, verifyResearchObservation, researchInputBody, validResearchDate } from "./market-source-contract.mjs";
import { calculateEligibleSnapshotModels } from "./model-score-engine.mjs";
import { MODEL_HISTORY_REQUIREMENTS, normalizeModelInputRows } from "./market-data-quality-validator.mjs";
import { validateKisEodInputHistory, deriveKisEodInputChangeRate, rankKisEodRecords, KIS_EOD_MODEL_VERSIONS } from "./kis-eod-pipeline.mjs";
import { sha256Canonical } from "./snapshot-quality-pipeline.mjs";
const versions = KIS_EOD_MODEL_VERSIONS;
const empty = () => Object.fromEntries(versions.map((v) => [v, null]));
export function analyzeResearchBatch({ observations, universe, referenceDate, officialSnapshot, formulaHashes, expectedFormulaHashes,
  grants = {}, asOf = new Date().toISOString() }) {
  const failures = [];
  if (!Array.isArray(observations) || !Array.isArray(universe) || !universe.length || universe.length > 1000 || !validResearchDate(referenceDate)) throw new Error("RESEARCH_BATCH_INVALID");
  const codes = universe.map((r) => r.code), provider = observations[0]?.provider ?? null;
  if (codes.some((c) => !/^[0-9A-Z]{6}$/u.test(c ?? "")) || new Set(codes).size !== codes.length) failures.push("UNIVERSE_INVALID");
  try { requireResearchRights(grants, provider, ["privateResearch", "derivedCalculation"]); } catch { failures.push("SOURCE_RIGHTS_NOT_VERIFIED"); }
  try { observations.forEach(verifyResearchObservation); } catch { failures.push("SOURCE_OBSERVATION_INVALID"); }
  if (observations.length !== codes.length || new Set(observations.map((o) => o.ticker)).size !== observations.length
    || observations.some((o) => !codes.includes(o.ticker))) failures.push("PARTIAL_OR_DUPLICATE_UNIVERSE");
  if (!Number.isFinite(Date.parse(asOf)) || Date.parse(asOf) < Date.parse(`${referenceDate}T15:30:00+09:00`)) failures.push("AS_OF_BEFORE_CLOSE");
  if (observations.some((o) => o.provider !== provider || o.referenceDate !== referenceDate)) failures.push("MIXED_SOURCE_OR_DATE");
  if (observations.some((o) => !o.requestedAt || !o.receivedAt || Date.parse(o.receivedAt) > Date.parse(asOf))) failures.push("OBSERVATION_TIME_UNVERIFIED");
  for (const key of ["adjustment", "sessionScope", "sourceFinality", "observationType"]) {
    const values = new Set(observations.map((o) => o[key]));
    if (values.size !== 1 || (["adjustment", "sessionScope"].includes(key) && values.has("UNKNOWN"))) failures.push(`MIXED_OR_UNKNOWN_${key.toUpperCase()}`);
  }
  if (!Array.isArray(officialSnapshot?.records) || !validResearchDate(officialSnapshot?.asOfDate) || officialSnapshot.asOfDate > referenceDate) failures.push("QUARANTINE_BASIS_UNVERIFIED");
  if (versions.some((v) => !/^[a-f0-9]{64}$/u.test(formulaHashes?.[v] ?? "") || formulaHashes[v] !== expectedFormulaHashes?.[v])) failures.push("FORMULA_HASH_MISMATCH");
  const quarantine = new Set((officialSnapshot?.records ?? []).filter((r) => r.qualityEligibility?.status === "quarantined" || r.qualityEligibility?.exclusions?.length).map((r) => r.code));
  const byCode = new Map(observations.map((o) => [o.ticker, o]));
  const records = universe.map((stock) => {
    const o = byCode.get(stock.code);
    const record = { ticker: stock.code, scores: empty(), rawScores: { "A-v2": null }, ranks: empty(), exclusionReasons: {}, inputHash: o?.inputHash ?? null };
    let reason = failures[0] ?? (quarantine.has(stock.code) ? "officialQuarantinePreserved" : null);
    if (!reason && o.quality.issues.length) reason = o.quality.issues[0];
    if (!reason && o.securityStatus === "DELISTED") reason = "delisted";
    if (!reason && o.securityStatus === "HALTED") reason = "tradingHaltOrNoTrade";
    if (!reason && o.corporateActionStatus === "EVENT_REPORTED") reason = "corporateActionReviewRequired";
    if (!reason) reason = validateKisEodInputHistory(o.rows, referenceDate, { adjustment: o.adjustment }, o.adjustment);
    const rows = reason ? [] : normalizeModelInputRows(o.rows);
    const rate = deriveKisEodInputChangeRate(rows);
    if (!reason && rows.length >= 34 && !Number.isFinite(rate.value)) reason = "dailyChangeRateMissing";
    if (rows.length && Number.isFinite(rate.value)) rows[0] = { ...rows[0], fltRt: rate.value };
    const eligible = Object.fromEntries(versions.map((v) => [v, !reason && rows.length >= MODEL_HISTORY_REQUIREMENTS[v]]));
    record.exclusionReasons = Object.fromEntries(versions.map((v) => [v, eligible[v] ? null : reason ?? "insufficientHistory"]));
    if (Object.values(eligible).some(Boolean)) {
      try {
        const result = calculateEligibleSnapshotModels(rows.slice(0, 260), eligible);
        record.scores = { "A-v1": result.modelA?.finalTechnicalScore ?? null, "A-v2": result.modelAV2?.finalScore ?? null,
          "B-v1": result.modelB?.trendStrength ?? null, "C-v1": result.modelC?.entryStrength ?? null, "D-v1": result.modelD ?? null };
        record.rawScores["A-v2"] = result.modelAV2?.rawScore ?? null;
        if (versions.some((v) => eligible[v] && !Number.isFinite(record.scores[v]))) throw new Error("INVALID_SCORE");
      } catch { failures.push("MODEL_CALCULATION_FAILED"); record.scores = empty(); record.rawScores["A-v2"] = null; }
    }
    return record;
  });
  // Partial/invalid current data cannot masquerade as a complete ranked batch.
  if (records.some((r) => versions.some((v) => r.exclusionReasons[v] && !["officialQuarantinePreserved", "insufficientHistory", "tradingHaltOrNoTrade", "delisted"].includes(r.exclusionReasons[v])))) failures.push("INPUT_BATCH_NOT_READY");
  if (!failures.length) rankKisEodRecords(records);
  const body = { namespace: MARKET_SOURCE_CONTRACT, resultKind: "RESEARCH_ONLY", referenceDate, provider, asOf,
    publicationEligible: false, productionChanged: false, status: failures.length ? "BLOCKED" : "RESEARCH_CALCULATED",
    failures: [...new Set(failures)], universeHash: sha256Canonical(codes), formulaHashes: formulaHashes ?? {},
    basis: { adjustment: observations[0]?.adjustment ?? null, sessionScope: observations[0]?.sessionScope ?? null },
    quarantineBasisHash: sha256Canonical(officialSnapshot ?? null), records,
    stages: { collection: observations.length === codes.length ? "COMPLETE" : "PARTIAL", validation: failures.length ? "NOT_READY" : "VALIDATED",
      calculation: failures.length ? "NOT_PUBLISHABLE" : "CALCULATED", storage: "NOT_ATTEMPTED", publication: "DISABLED" } };
  return { ...body, resultHash: sha256Canonical(body) };
}
export function queryResearchTop(result, version, limit) {
  const { resultHash, ...body } = result ?? {};
  if (sha256Canonical(body) !== resultHash || result.namespace !== MARKET_SOURCE_CONTRACT || result.resultKind !== "RESEARCH_ONLY" || result.publicationEligible !== false) throw new Error("RESEARCH_RESULT_HASH_INVALID");
  if (!versions.includes(version) || ![5, 10, 20].includes(limit)) throw new Error("RESEARCH_QUERY_INVALID");
  return { referenceDate: result.referenceDate, provider: result.provider, version, available: result.status === "RESEARCH_CALCULATED",
    status: result.status, rows: result.status === "RESEARCH_CALCULATED" ? result.records.filter((r) => Number.isInteger(r.ranks[version])).sort((a, b) => a.ranks[version] - b.ranks[version]).slice(0, limit).map((r) => ({ ticker: r.ticker, score: r.scores[version], rank: r.ranks[version] })) : [] };
}
export function compareResearchModels(left, right) {
  for (const result of [left, right]) queryResearchTop(result, "A-v1", 5);
  const comparable = left.status === "RESEARCH_CALCULATED" && right.status === "RESEARCH_CALCULATED" && left.referenceDate === right.referenceDate
    && left.universeHash === right.universeHash && sha256Canonical(left.formulaHashes) === sha256Canonical(right.formulaHashes)
    && sha256Canonical(left.basis) === sha256Canonical(right.basis);
  if (!comparable) return { status: "NOT_COMPARABLE", officialReplacementAllowed: false };
  return { status: "COMPARED_RESEARCH_ONLY", officialReplacementAllowed: false, models: Object.fromEntries(versions.map((v) => [v, {
    observations: left.records.map((a) => { const b = right.records.find((r) => r.ticker === a.ticker); return { ticker: a.ticker,
      scoreDelta: a.scores[v] !== null && b.scores[v] !== null ? b.scores[v] - a.scores[v] : null,
      rankDelta: a.ranks[v] !== null && b.ranks[v] !== null ? a.ranks[v] - b.ranks[v] : null,
      exclusionChanged: a.exclusionReasons[v] !== b.exclusionReasons[v] }; }),
    topOverlap: Object.fromEntries([5, 10, 20].map((n) => { const a = queryResearchTop(left, v, n).rows, b = queryResearchTop(right, v, n).rows;
      return [n, { leftCount: a.length, rightCount: b.length, commonCount: a.filter((r) => b.some((s) => s.ticker === r.ticker)).length }]; })),
  }])) };
}
// Reuse a caller-supplied EXISTING private adapter. No remote store is created here.
export async function storeResearchResult({ store, result, observations, grants, location = "localStorage" }) {
  if (!["localStorage", "cloudStorage"].includes(location)) throw new Error("RESEARCH_STORE_LOCATION_INVALID");
  queryResearchTop(result, "A-v1", 5);
  requireResearchRights(grants, result.provider, [location, "privateResearch"]);
  if (!Array.isArray(observations) || observations.length !== result.records.filter((r) => r.inputHash !== null).length
    || new Set(observations.map((o) => o.ticker)).size !== observations.length
    || observations.some((o) => o.provider !== result.provider || o.referenceDate !== result.referenceDate
      || !result.records.some((r) => r.ticker === o.ticker && r.inputHash === o.inputHash))) throw new Error("RESEARCH_STORE_INPUT_MISMATCH");
  for (const o of observations) { verifyResearchObservation(o); requireResearchRights(grants, o.provider, [location]); }
  const inputs = [];
  for (const o of observations) {
    const body = researchInputBody(o), key = `multi-source-research/inputs/${o.inputHash}.json`;
    await store.writeImmutable(key, body);
    if (sha256Canonical((await store.read(key))?.value) !== o.inputHash) throw new Error("RESEARCH_STORE_HASH_MISMATCH");
    inputs.push({ key, inputHash: o.inputHash, observationHash: o.observationHash, rawSourceHash: o.rawSourceHash, requestedAt: o.requestedAt, receivedAt: o.receivedAt });
  }
  const manifest = { namespace: MARKET_SOURCE_CONTRACT, result, inputs };
  const manifestHash = sha256Canonical(manifest), key = `multi-source-research/results/${manifestHash}.json`;
  await store.writeImmutable(key, manifest);
  if (sha256Canonical((await store.read(key))?.value) !== manifestHash) throw new Error("RESEARCH_STORE_HASH_MISMATCH");
  return { key, manifestHash, status: "STORED_READBACK_VERIFIED", publication: "DISABLED" };
}
export async function readResearchResult({ store, key, grants, location = "localStorage" }) {
  if (!["localStorage", "cloudStorage"].includes(location) || !/^multi-source-research\/results\/[a-f0-9]{64}\.json$/u.test(key ?? "")) throw new Error("RESEARCH_STORE_KEY_INVALID");
  const permitted = SOURCE_IDS.some((provider) => {
    try { requireResearchRights(grants, provider, [location, "privateResearch"]); return true; } catch { return false; }
  });
  if (!permitted) throw new Error("SOURCE_RIGHTS_NOT_VERIFIED");
  const manifest = (await store.read(key))?.value;
  if (!manifest || sha256Canonical(manifest) !== key.split("/").at(-1).slice(0, 64)) throw new Error("RESEARCH_STORE_HASH_MISMATCH");
  queryResearchTop(manifest.result, "A-v1", 5);
  requireResearchRights(grants, manifest.result.provider, [location, "privateResearch"]);
  if (!Array.isArray(manifest.inputs) || manifest.inputs.length !== manifest.result.records.filter((r) => r.inputHash !== null).length) throw new Error("RESEARCH_STORE_INPUT_MISMATCH");
  const seen = new Set();
  for (const input of manifest.inputs) {
    if (input.key !== `multi-source-research/inputs/${input.inputHash}.json`) throw new Error("RESEARCH_STORE_INPUT_MISMATCH");
    const value = (await store.read(input.key))?.value;
    if (!value || sha256Canonical(value) !== input.inputHash) throw new Error("RESEARCH_STORE_HASH_MISMATCH");
    if (seen.has(value.ticker) || value.provider !== manifest.result.provider || value.referenceDate !== manifest.result.referenceDate
      || !manifest.result.records.some((r) => r.ticker === value.ticker && r.inputHash === input.inputHash)) throw new Error("RESEARCH_STORE_INPUT_MISMATCH");
    seen.add(value.ticker);
  }
  return manifest.result;
}
export { PRICE_FIELDS };
