// Read-only replay of existing private evidence. No network, writes or raw-price output.
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { sha256Canonical } from "../lib/snapshot-quality-pipeline.mjs";
import { normalizeResearchHistory, compareResearchObservations } from "../lib/market-source-contract.mjs";
import { evaluateKisEodAuditHistory } from "./audit-kis-eod-private.mjs";
import { KIS_EOD_MODEL_VERSIONS, rankKisEodRecords } from "../lib/kis-eod-pipeline.mjs";
export async function verifyExistingSourceEvidence(root = process.cwd()) {
  const audits = path.join(root, ".runtime/kis-eod/audits"), dates = (await fs.readdir(audits)).filter((v) => /^\d{4}-\d{2}-\d{2}$/u.test(v)).sort();
  const date = dates.at(-1); if (!date) throw new Error("EVIDENCE_UNAVAILABLE");
  const dirs = (await fs.readdir(path.join(audits, date))).filter((v) => /^[a-f0-9]{64}$/u.test(v));
  if (dirs.length !== 1) throw new Error("EVIDENCE_MANIFEST_AMBIGUOUS");
  const folder = path.join(audits, date, dirs[0]), manifest = JSON.parse(await fs.readFile(path.join(folder, "manifest.json"), "utf8"));
  const { artifactHash, ...manifestBody } = manifest;
  if (sha256Canonical(manifestBody) !== artifactHash) throw new Error("EVIDENCE_HASH_INVALID");
  let comparisonDate = date, seed;
  try { seed = JSON.parse(await fs.readFile(path.join(root, "data/analysis/market-seeds", `${date}.json`), "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw error; comparisonDate = manifest.officialBaselineDate;
    seed = JSON.parse(await fs.readFile(path.join(root, "data/analysis/market-seeds", `${comparisonDate}.json`), "utf8")); }
  const calculated = new Map();
  const coverage = Object.fromEntries(KIS_EOD_MODEL_VERSIONS.map((v) => [v, 0]));
  let verified = 0, compared = 0, equal = 0, diagnosticOnly = 0;
  const equalFields = Object.fromEntries(["mkp", "hipr", "lopr", "clpr", "trqu"].map((f) => [f, 0]));
  const files = (await fs.readdir(path.join(folder, "success"))).filter((v) => /^[0-9A-Z]{6}\.json$/u.test(v));
  for (const file of files) {
    const a = JSON.parse(await fs.readFile(path.join(folder, "success", file), "utf8")), { artifactHash: digest, ...body } = a;
    if (sha256Canonical(body) !== digest || a.manifestHash !== dirs[0] || a.code !== file.slice(0, 6)) throw new Error("EVIDENCE_HASH_INVALID");
    const check = evaluateKisEodAuditHistory(a.history, date, manifest.quarantineCodes.includes(a.code), a.code);
    calculated.set(a.code, check);
    verified++;
    for (const v of KIS_EOD_MODEL_VERSIONS) if (Number.isFinite(check.scores[v])) coverage[v]++;
    const saved = seed.records.find((r) => r.code === a.code && r.eligible);
    if (!saved) continue;
    const baseline = comparisonDate, compact = baseline.replaceAll("-", "");
    const kisRows = a.history.rows.filter((r) => r.basDt <= compact);
    if (kisRows[0]?.basDt !== compact || !saved.rows.length) continue;
    const publicRows = saved.rows.map(([d, mkp, hipr, lopr, clpr, trqu]) => ({ basDt: d.replaceAll("-", ""), srtnCd: a.code, mkp, hipr, lopr, clpr, trqu, trPrc: null }));
    const context = { ticker: a.code, referenceDate: baseline, requestedAt: a.history.requestedAt, receivedAt: a.history.receivedAt, observationType: "ACTUAL_RESPONSE", sessionScope: "UNKNOWN" };
    const k = normalizeResearchHistory({ ...context, provider: "KIS", rows: kisRows, adjustment: a.history.adjustment, sourceFinality: "PROVISIONAL", rawSourceHash: digest });
    // This hash covers an existing normalized official seed, NOT a newly received API response.
    const p = normalizeResearchHistory({ ...context, provider: "PUBLIC_EOD", rows: publicRows, sourceFinality: "SUPPLIER_OFFICIAL", rawSourceHash: sha256Canonical(saved),
      requestedAt: null, receivedAt: null, observationType: "SAVED_ARTIFACT" });
    const diff = compareResearchObservations(p, k); compared++;
    if (diff.status === "DIAGNOSTIC_ONLY") diagnosticOnly++;
    for (const f of Object.keys(equalFields)) if (diff.fields[f].difference === 0) equalFields[f]++;
    if (["mkp", "hipr", "lopr", "clpr", "trqu"].every((f) => diff.fields[f].difference === 0)) equal++;
  }
  let modelDiagnostics = "UNAVAILABLE_SAME_DATE_OFFICIAL_RESULT";
  if (comparisonDate === date) {
    const official = JSON.parse(await fs.readFile(path.join(root, "data/model-history", `${date}.json`), "utf8"));
    const records = manifest.universe.map(({ code }) => { const check = calculated.get(code); return { ticker: code,
      scores: check?.scores ?? Object.fromEntries(KIS_EOD_MODEL_VERSIONS.map((v) => [v, null])),
      rawScores: { "A-v2": check?.rawScores?.["A-v2"] ?? null }, ranks: Object.fromEntries(KIS_EOD_MODEL_VERSIONS.map((v) => [v, null])) }; });
    rankKisEodRecords(records);
    modelDiagnostics = Object.fromEntries(KIS_EOD_MODEL_VERSIONS.map((v) => {
      const pairs = records.map((r) => ({ local: r, official: official.records.find((a) => a.ticker === r.ticker)?.models?.[v] }))
        .filter((p) => p.official?.eligible && Number.isFinite(p.local.scores[v]));
      const top = records.filter((r) => r.ranks[v] !== null).sort((a, b) => a.ranks[v] - b.ranks[v]);
      const rankPairs = pairs.filter((p) => Number.isInteger(p.local.ranks[v]) && Number.isInteger(p.official.rank));
      return [v, { compared: pairs.length, scoreDifferenceCount: pairs.filter((p) => p.local.scores[v] !== p.official.score).length,
        maxAbsoluteScoreDifference: Math.max(0, ...pairs.map((p) => Math.abs(p.local.scores[v] - p.official.score))),
        rankCompared: rankPairs.length, rankDifferenceCount: rankPairs.length ? rankPairs.filter((p) => p.local.ranks[v] !== p.official.rank).length : null,
        topOverlap: rankPairs.length ? Object.fromEntries([5, 10, 20].map((n) => [n, top.slice(0, n).filter((r) => official.records.some((a) => a.ticker === r.ticker && a.models[v].eligible && Number.isInteger(a.models[v].rank) && a.models[v].rank <= n)).length])) : null }];
    }));
  }
  return { namespace: "market-source-evidence-replay-v1", collectionDate: date, comparisonDate, originalAuditBaselineDate: manifest.officialBaselineDate, verifiedArtifacts: verified, recalculatedCoverage: coverage, modelDiagnostics,
    compared, equalOHLCV: equal, equalFields, diagnosticOnly, tradingValueComparison: "UNAVAILABLE_IN_OFFICIAL_SEED", priceAndSessionEquivalence: "UNVERIFIED",
    actualCloseTimeObservation: false, requests: 0, filesWritten: 0, productionChanged: false };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(await verifyExistingSourceEvidence())); }
  catch { console.error("PRIVATE_EVIDENCE_REPLAY_FAILED"); process.exitCode = 1; }
}
