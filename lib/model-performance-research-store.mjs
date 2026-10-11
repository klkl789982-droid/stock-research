import fs from "node:fs/promises";
import path from "node:path";
import { hashObject, scoreRank, MODEL_VERSIONS } from "./rank-backtest-engine.mjs";
import { validateCompactModelHistory } from "./daily-production.mjs";
import { buildModelPerformanceResearch } from "./model-performance-research.mjs";

const DATE_FILE = /^\d{4}-\d{2}-\d{2}\.json$/;
async function readJson(file, files, root) {
  const value = JSON.parse(await fs.readFile(file, "utf8"));
  files.push({ path: path.relative(root, file).replaceAll("\\", "/"), contentHash: hashObject(value) });
  return value;
}
async function optionalJson(file, files, root) {
  try { return await readJson(file, files, root); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
async function dateFiles(directory) {
  try { return (await fs.readdir(directory)).filter((name) => DATE_FILE.test(name)).sort(); } catch (error) { if (error.code === "ENOENT") return []; throw error; }
}

/** Compare frozen selections with the promoted compact artifact, not mutable future-return fields. */
export function identifyStoredResearchSignal(snapshot, compact, manifests = []) {
  const source = snapshot.sourceAvailability ?? {};
  const retrospective = snapshot.researchClassification === "RETROSPECTIVE";
  if (retrospective) return { snapshot, layer: "DAILY_EOD", classification: "RETROSPECTIVE", availableAt: source.signalAvailableAt ?? snapshot.signalAvailableAt ?? null,
    availabilityEvidence: "UNVERIFIED", sourceSnapshotHash: hashObject(snapshot) };
  const compactValid = compact && compact.referenceDate === snapshot.asOfDate && !validateCompactModelHistory(compact, snapshot.records?.length ?? 0).length;
  const sameSelections = compactValid && hashObject(compact.provenance?.sourceManifest ?? null) === hashObject(snapshot.sourceManifest ?? null) && compact.records.every((c) => {
    const record = snapshot.records.find((r) => r.code === c.ticker);
    if (!record || record.market !== c.market) return false;
    return MODEL_VERSIONS.every((model) => {
      const meta = scoreRank(snapshot, record, model), frozen = c.models[model];
      return (meta?.score ?? null) === frozen.score && (meta?.rank ?? null) === frozen.rank;
    });
  });
  const manifest = manifests.filter((m) => m.referenceDate === snapshot.asOfDate && m.status === "PROMOTED" && m.promoted === true && m.snapshotHash === compact?.sourceSnapshotHash && m.compactHistoryHash === compact?.contentHash)
    .find((m) => { const { contentHash, ...base } = m; return contentHash === hashObject(base); });
  const classification = sameSelections && manifest ? "AS_PUBLISHED" : "UNVERIFIED";
  // commitIntentTimestamp/promotedAt are NOT evidence of completed push/publication.
  const completedAt = snapshot.publication?.completedAt;
  const computedAt = snapshot.signalComputedAt ?? source.signalComputedAt;
  const verified = classification === "AS_PUBLISHED" && snapshot.publication?.status === "VERIFIED" && Number.isFinite(Date.parse(completedAt))
    && snapshot.publication?.sourceSnapshotHash === compact.sourceSnapshotHash && Number.isFinite(Date.parse(computedAt)) && Date.parse(completedAt) >= Date.parse(computedAt);
  return { snapshot, layer: "DAILY_EOD", classification, sourceSnapshotHash: compact?.sourceSnapshotHash ?? hashObject(snapshot),
    availableAt: verified ? completedAt : source.signalAvailableAt ?? snapshot.signalAvailableAt ?? null, availabilityEvidence: verified ? "VERIFIED" : "COMMIT_INTENT_OR_UNKNOWN" };
}

/** Explicit public-official allowlist; never read private KIS or LIVE directories. No writes/cache files. */
export async function loadModelPerformanceResearch({ root = process.cwd(), options = {}, asOf = new Date().toISOString() } = {}) {
  const data = path.join(root, "data"), files = [], signals = [], ledgers = [];
  for (const name of await dateFiles(path.join(data, "history"))) {
    const date = name.slice(0, 10);
    if ((options.from && date < options.from) || (options.to && date > options.to)) continue;
    const snapshot = await readJson(path.join(data, "history", name), files, root);
    if (snapshot.asOfDate !== date) throw new Error("연구 신호 파일 기준일 불일치");
    const compact = await optionalJson(path.join(data, "model-history", name), files, root), manifests = [];
    const runDirectory = path.join(data, "daily-runs", date);
    let runs = [];
    try { runs = (await fs.readdir(runDirectory)).filter((v) => /^[a-zA-Z0-9_-]+\.json$/.test(v)); } catch (error) { if (error.code !== "ENOENT") throw error; }
    for (const run of runs.sort()) manifests.push(await readJson(path.join(runDirectory, run), files, root));
    signals.push(identifyStoredResearchSignal(snapshot, compact, manifests));
  }
  for (const name of await dateFiles(path.join(data, "market-prices"))) {
    const ledger = await readJson(path.join(data, "market-prices", name), files, root);
    if (ledger.date !== name.slice(0, 10)) throw new Error("연구 가격 원장 기준일 불일치");
    ledgers.push(ledger);
  }
  const calendar = await optionalJson(path.join(data, "trading-calendar", "status.json"), files, root) ?? { dates: {} };
  const inputs = { signals, ledgers, calendar, options, asOf, inputFiles: files };
  const result = buildModelPerformanceResearch(inputs);
  // Compare horizons from the same loaded official inputs; no extra collection or writes.
  const horizonComparison = Object.fromEntries(["H1", "H5", "H20"].map((horizon) => {
    const period = horizon === result.filter.horizon ? result : buildModelPerformanceResearch({ ...inputs, options: { ...options, horizon } });
    return [horizon, period.cohorts.map((c) => ({ cohortId: c.id, modelVersion: c.modelVersion, stockMetrics: c.stockMetrics, portfolioMetrics: c.portfolioMetrics,
      matureSignalDateCount: c.matureSignalDateCount, pendingCount: c.pendingCount, missingCount: c.missingCount, inputHash: period.provenance.inputHash }))];
  }));
  return { ...result, horizonComparison };
}
