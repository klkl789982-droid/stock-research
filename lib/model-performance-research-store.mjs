import fs from "node:fs/promises";
import path from "node:path";
import { hashObject, scoreRank, MODEL_VERSIONS } from "./rank-backtest-engine.mjs";
import { validateCompactModelHistory } from "./daily-production.mjs";
import { buildModelPerformanceResearch } from "./model-performance-research.mjs";
import { EXECUTION_HORIZONS, locateExecutionTradingDay } from "./execution-return-resolver.mjs";
import { deriveMarketBenchmarkLegs, indexLegKey, loadResearchIndexSeries } from "./research-index-benchmarks.mjs";

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
export function identifyStoredResearchSignal(snapshot, compact, manifests = [], receipts = []) {
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
  const receipt = classification === "AS_PUBLISHED" && receipts.filter((r) => r.status === "VERIFIED" && r.reason == null && r.referenceDate === snapshot.asOfDate &&
    r.snapshotHash === compact.sourceSnapshotHash && /^[0-9a-f]{40}$/.test(r.commitSha) && Number.isSafeInteger(r.runId) && Number.isInteger(r.runAttempt) && r.runAttempt > 0 &&
    r.runUrl === `https://github.com/klkl789982-droid/stock-research/actions/runs/${r.runId}/attempts/${r.runAttempt}` &&
    Number.isFinite(Date.parse(computedAt)) && Date.parse(r.verifiedAt) >= Date.parse(computedAt))
    .sort((a, b) => Date.parse(a.verifiedAt) - Date.parse(b.verifiedAt))[0];
  if (receipt && (!verified || Date.parse(receipt.verifiedAt) < Date.parse(completedAt))) {
    return { snapshot, layer: "DAILY_EOD", classification, sourceSnapshotHash: compact.sourceSnapshotHash,
      availableAt: receipt.verifiedAt, availabilityEvidence: "VERIFIED", publicationVerification: { basis: "SITE_CONFIRMED_BY", checkedAt: receipt.verifiedAt, commitSha: receipt.commitSha, runUrl: receipt.runUrl } };
  }
  return { snapshot, layer: "DAILY_EOD", classification, sourceSnapshotHash: compact?.sourceSnapshotHash ?? hashObject(snapshot),
    availableAt: verified ? completedAt : source.signalAvailableAt ?? snapshot.signalAvailableAt ?? null, availabilityEvidence: verified ? "VERIFIED" : "COMMIT_INTENT_OR_UNKNOWN" };
}

function publicationTiming(signal, calendar) {
  const confirmedBy = signal.availableAt;
  const kstDay = new Date(Date.parse(confirmedBy) + 9 * 3600000).toISOString().slice(0, 10);
  const next = locateExecutionTradingDay(calendar, kstDay, 1);
  const beforeOpen = Date.parse(confirmedBy) < Date.parse(kstDay + "T09:00:00+09:00");
  const status = calendar.dates[kstDay]?.status;
  const firstKnownRegularOpen = beforeOpen && status === "tradingDay" ? kstDay :
    beforeOpen && !["tradingDay", "marketClosed"].includes(status) ? null : next.status === "resolved" ? next.date : null;
  const planned = locateExecutionTradingDay(calendar, signal.snapshot.asOfDate, 2);
  return { signalDate: signal.snapshot.asOfDate, confirmedBy, generatedAt: signal.snapshot.signalComputedAt ?? signal.snapshot.sourceAvailability?.signalComputedAt ?? null,
    firstKnownRegularOpen, plannedEntryDate: planned.status === "resolved" ? planned.date : null,
    sourceHash: signal.sourceSnapshotHash, runUrl: signal.publicationVerification?.runUrl ?? null };
}

/** Official stock ledgers and separately authenticated index references; no LIVE directories or writes.
 * @param {{root?: string, options?: Record<string, any>, asOf?: string, indexRequest?: (input: URL, init: RequestInit) => Promise<Response>, archiveReader?: Function, receiptReader?: Function, publicationEvidence?: () => Promise<{evidence?: object[]}>, includeChoices?: boolean}} [input] */
export async function loadModelPerformanceResearch({ root = process.cwd(), options = {}, asOf, indexRequest, archiveReader, receiptReader, publicationEvidence, includeChoices = false } = {}) {
  const files = [], stored = [], ledgers = [];
  const archive = await optionalJson(path.join(root, "data", "model-validation", "daily-publication-evidence.json"), files, root);
  const latest = publicationEvidence ? await publicationEvidence() : null;
  const receipts = [...(archive?.evidence ?? []), ...(latest?.evidence ?? [])];
  for (const name of await dateFiles(path.join(root, "data", "history"))) {
    const date = name.slice(0, 10);
    if ((options.from && date < options.from) || (options.to && date > options.to)) continue;
    const snapshot = await readJson(path.join(root, "data", "history", name), files, root);
    if (snapshot.asOfDate !== date) throw new Error("연구 신호 파일 기준일 불일치");
    const compact = await optionalJson(path.join(root, "data", "model-history", name), files, root), manifests = [];
    const runDirectory = path.join(root, "data", "daily-runs", date);
    let runs = [];
    try { runs = (await fs.readdir(runDirectory)).filter((v) => /^[a-zA-Z0-9_-]+\.json$/.test(v)); } catch (error) { if (error.code !== "ENOENT") throw error; }
    for (const run of runs.sort()) manifests.push(await readJson(path.join(runDirectory, run), files, root));
    stored.push({ snapshot, compact, manifests });
  }
  // Obtain verified original-run receipts which have scrolled off the operational status widget.
  const uncaptured = stored.filter(({ compact }) => compact?.sourceSnapshotHash &&
    !archive?.evidence?.some((r) => r.referenceDate === compact.referenceDate && r.snapshotHash === compact.sourceSnapshotHash))
    .map(({ compact }) => ({ date: compact.referenceDate, hash: compact.sourceSnapshotHash }));
  if (uncaptured.length && receiptReader) receipts.push(...await receiptReader(uncaptured, { now: asOf ? Date.parse(asOf) : Date.now() }));
  const signals = stored.map(({ snapshot, compact, manifests }) => identifyStoredResearchSignal(snapshot, compact, manifests, receipts));
  for (const name of await dateFiles(path.join(root, "data", "market-prices"))) {
    const ledger = await readJson(path.join(root, "data", "market-prices", name), files, root);
    if (ledger.date !== name.slice(0, 10)) throw new Error("연구 가격 원장 기준일 불일치");
    ledgers.push(ledger);
  }
  const calendar = await optionalJson(path.join(root, "data", "trading-calendar", "status.json"), files, root) ?? { dates: {} };
  const pairs = new Map();
  for (const { snapshot } of signals) {
    const entry = locateExecutionTradingDay(calendar, snapshot.asOfDate, 2);
    if (entry.status !== "resolved") continue;
    for (const { holdingTradingDay } of Object.values(EXECUTION_HORIZONS)) {
      const exit = holdingTradingDay === 1 ? entry : locateExecutionTradingDay(calendar, entry.date, holdingTradingDay - 1);
      if (exit.status === "resolved") pairs.set(entry.date + exit.date, { entryDate: entry.date, exitDate: exit.date });
    }
  }
  const intervals = [...pairs.values()];
  const saved = archiveReader && options.benchmark !== "NONE" ? await archiveReader(intervals, { asOf: asOf ? Date.parse(asOf) : Date.now() }) : [];
  const savedKeys = new Set(saved.map(indexLegKey));
  const missing = intervals.filter((v) => ["KOSPI", "KOSDAQ"].some((market) => !savedKeys.has(indexLegKey({ ...v, market }))));
  const indexDates = [...new Set(missing.flatMap((v) => [v.entryDate, v.exitDate]))].sort();
  const series = options.benchmark === "NONE" ? [] : await loadResearchIndexSeries(indexDates, indexRequest);
  const benchmarks = [...saved, ...deriveMarketBenchmarkLegs(series, missing).filter((v) => !savedKeys.has(indexLegKey(v)))];
  const inputs = { signals, ledgers, calendar, benchmarks, options, asOf: asOf ?? new Date().toISOString(), inputFiles: files };
  const result = buildModelPerformanceResearch(inputs);
  const choices = [];
  // Compare horizons from the same loaded official inputs; no extra collection or writes.
  const horizonComparison = Object.fromEntries(["H1", "H5", "H20"].map((horizon) => {
    const period = horizon === result.filter.horizon ? result : buildModelPerformanceResearch({ ...inputs, options: { ...options, horizon } });
    if (includeChoices) {
      for (const cohort of period.cohorts) for (const date of cohort.signalDates) {
        const rows = cohort.rows.filter(row => row.signalDate === date);
        for (const topN of [5, 10, 20]) {
          const top = rows.filter(row => row.rank <= topN);
          const mature = top.filter(row => row.status === "MATURE").length;
          const pending = top.filter(row => row.status === "PENDING").length;
          choices.push({ date, model: cohort.modelVersion, horizon, topN, selected: top.length, mature, pending, missing: top.length - mature - pending });
        }
      }
    }
    return [horizon, period.cohorts.map((c) => ({ cohortId: c.id, modelVersion: c.modelVersion, stockMetrics: c.stockMetrics, portfolioMetrics: c.portfolioMetrics,
      matureSignalDateCount: c.matureSignalDateCount, pendingCount: c.pendingCount, missingCount: c.missingCount, inputHash: period.provenance.inputHash }))];
  }));
  return { ...result, horizonComparison, ...(includeChoices ? { choices } : {}), verifiedPublicationDates: signals.filter((s) => s.availabilityEvidence === "VERIFIED" && Date.parse(s.availableAt) <= Date.parse(inputs.asOf)).map(s => publicationTiming(s, calendar)),
    benchmarkCoverage: { provider: "KIS 국내업종기간별시세", indexCodes: { KOSPI: "0001", KOSDAQ: "1001" },
    datesByMarket: Object.fromEntries(["KOSPI", "KOSDAQ"].map((m) => [m, new Set(benchmarks.filter((v) => v.market === m).flatMap((v) => [v.entryDate, v.exitDate])).size])),
    archiveLegs: saved.length, matchedLegCount: benchmarks.length, sourceHash: benchmarks.length ? hashObject(benchmarks.map((v) => v.provenance.sourceHash).sort()) : null } };
}
