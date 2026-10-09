import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { evaluateKisEodAuditHistory } from "./audit-kis-eod-private.mjs";
import { loadKisEodInputs } from "./run-kis-eod.mjs";
import { sha256Canonical } from "../lib/snapshot-quality-pipeline.mjs";
import { rankKisEodRecords, KIS_EOD_MODEL_VERSIONS } from "../lib/kis-eod-pipeline.mjs";
import { kisEodPrivateStoreFromEnv } from "../lib/kis-eod-private-store.mjs";
import { persistPrivateModelBundle, queryPrivateModelTop } from "../lib/kis-eod-private-models.mjs";
import { createLocalPrivateModelStore } from "../lib/kis-eod-private-local-store.mjs";

const fail = (code) => { throw Object.assign(new Error(code), { code }); };
// Reuse the latest COMPLETE existing audit, not a fresh 553 collection, and
// retain actual historical request timestamps. Never creates a LIVE head.
export async function buildPrivateResearchReplay({ root = process.cwd(), directory = null, loadInputs = loadKisEodInputs } = {}) {
  const base = path.resolve(root, ".runtime", "kis-eod", "audits");
  let selected = directory;
  if (!selected) {
    const dates = (await fs.readdir(base)).filter((date) => /^\d{4}-\d{2}-\d{2}$/u.test(date)).sort().reverse();
    outer: for (const date of dates) for (const hash of (await fs.readdir(path.join(base, date))).filter((value) => /^[a-f0-9]{64}$/u.test(value)).sort().reverse()) {
      const candidate = path.join(base, date, hash);
      const manifest = JSON.parse(await fs.readFile(path.join(candidate, "manifest.json"), "utf8"));
      const files = await fs.readdir(path.join(candidate, "success"));
      if (files.length === manifest.universe.length - manifest.quarantineCodes.length) { selected = candidate; break outer; }
    }
  }
  if (!selected) fail("PRIVATE_REPLAY_COMPLETE_AUDIT_MISSING");
  const realRoot = await fs.realpath(root), real = await fs.realpath(path.resolve(selected));
  if (!real.startsWith(`${realRoot}${path.sep}.runtime${path.sep}kis-eod${path.sep}audits${path.sep}`)) fail("PRIVATE_REPLAY_PATH_INVALID");
  const read = async (file) => {
    const target = await fs.realpath(path.join(real, file));
    if (!target.startsWith(`${real}${path.sep}`)) fail("PRIVATE_REPLAY_PATH_INVALID");
    return JSON.parse(await fs.readFile(target, "utf8"));
  };
  const storedManifest = await read("manifest.json"), { artifactHash: manifestHash, ...manifest } = storedManifest;
  if (manifestHash !== sha256Canonical(manifest) || manifestHash !== path.basename(real) || manifest.namespace !== "kis-eod-private-audit") fail("PRIVATE_REPLAY_MANIFEST_INVALID");
  const inputs = await loadInputs({ root, referenceDate: manifest.referenceDate, expectedUniverseCount: manifest.universe.length });
  if (sha256Canonical(inputs.formulaHashes) !== sha256Canonical(manifest.formulaHashes)) fail("PRIVATE_REPLAY_FORMULA_MISMATCH");
  const quarantined = new Set(manifest.quarantineCodes), currentQuarantine = inputs.officialSnapshot.records.filter((record) => record.qualityEligibility?.status === "quarantined" || record.qualityEligibility?.exclusions?.length).map((record) => record.code).sort();
  if (sha256Canonical(currentQuarantine) !== sha256Canonical([...quarantined].sort())) fail("PRIVATE_REPLAY_QUARANTINE_MISMATCH");
  const artifacts = [], records = [];
  for (const stock of inputs.universeRecords) {
    if (quarantined.has(stock.code)) {
      records.push({ ticker: stock.code, companyName: stock.name, market: stock.market,
        scores: Object.fromEntries(KIS_EOD_MODEL_VERSIONS.map((version) => [version, null])), rawScores: { "A-v2": null },
        ranks: Object.fromEntries(KIS_EOD_MODEL_VERSIONS.map((version) => [version, null])),
        exclusionReasons: Object.fromEntries(KIS_EOD_MODEL_VERSIONS.map((version) => [version, "officialQuarantinePreserved"])), sourceArtifactHash: null });
      continue;
    }
    const artifact = await read(`success/${stock.code}.json`), { artifactHash, ...body } = artifact;
    if (artifactHash !== sha256Canonical(body) || artifact.manifestHash !== manifestHash || artifact.code !== stock.code || artifact.requestedDate !== manifest.referenceDate
      || artifact.observationType !== "HISTORICAL_RESEARCH_REQUEST") fail("PRIVATE_REPLAY_HASH_MISMATCH");
    const checked = evaluateKisEodAuditHistory(artifact.history, manifest.referenceDate, quarantined.has(stock.code), stock.code);
    if (sha256Canonical(checked.scores) !== sha256Canonical(artifact.validation.scores) || sha256Canonical(checked.exclusions) !== sha256Canonical(artifact.validation.exclusions)) fail("PRIVATE_REPLAY_SCORE_MISMATCH");
    artifacts.push(artifact);
    records.push({ ticker: stock.code, companyName: stock.name, market: stock.market, scores: checked.scores, rawScores: checked.rawScores,
      ranks: Object.fromEntries(KIS_EOD_MODEL_VERSIONS.map((version) => [version, null])), exclusionReasons: checked.exclusions,
      sourceArtifactHash: artifactHash, requestedAt: artifact.requestedAt, receivedAt: artifact.receivedAt });
  }
  rankKisEodRecords(records);
  const raw = { namespace: "kis-private-model-research-inputs", referenceDate: manifest.referenceDate, manifest, artifacts };
  const research = { namespace: "kis-eod-private-research-models", observationType: "HISTORICAL_RESEARCH_REQUEST", referenceDate: manifest.referenceDate,
    collectionStartedAt: artifacts.map((artifact) => artifact.requestedAt).sort()[0], collectionCompletedAt: artifacts.map((artifact) => artifact.receivedAt).sort().at(-1),
    modelFormulaHashes: inputs.formulaHashes, inputHash: sha256Canonical(raw), manifestHash, records, sourceFinality: "NOT_CONFIRMED", publicationEligible: false };
  return { raw, research, summary: { referenceDate: research.referenceDate, observationType: research.observationType,
    requestedCount: inputs.universeRecords.length, collectedCount: artifacts.length, quarantineCount: quarantined.size, scoresIdenticalToAudit: true,
    rankingCounts: Object.fromEntries(KIS_EOD_MODEL_VERSIONS.map((version) => [version, records.filter((record) => Number.isInteger(record.ranks[version])).length])), inputHash: research.inputHash } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  try {
    if (args.length !== 1 || !["--verify-local", "--persist-private-research"].includes(args[0])) fail("PRIVATE_REPLAY_CLI_INVALID");
    const result = await buildPrivateResearchReplay();
    const store = args[0] === "--persist-private-research" ? kisEodPrivateStoreFromEnv() : createLocalPrivateModelStore();
    const persisted = await persistPrivateModelBundle({ store, ...result, mode: "research", runId: "existing-audit-replay" });
    for (const version of KIS_EOD_MODEL_VERSIONS) for (const limit of [5, 10, 20]) await queryPrivateModelTop(store, { version, limit, mode: "research" });
    console.log(`KIS_PRIVATE_REPLAY_JSON=${JSON.stringify({ ...result.summary, privatePersistence: persisted.status,
      backend: args[0] === "--persist-private-research" ? "PRIVATE_GITHUB" : "LOCAL_PRIVATE_DISK", liveHeadChanged: false })}`);
  } catch (error) {
    console.log(`KIS_PRIVATE_REPLAY_JSON=${JSON.stringify({ status: "FAILED", reason: /^PRIVATE_[A-Z0-9_]{1,80}$/u.test(error?.code ?? "") ? error.code : "PRIVATE_REPLAY_FAILED" })}`);
    process.exitCode = 1;
  }
}
