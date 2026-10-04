import fs from "node:fs/promises";
import path from "node:path";
import { sha256Canonical } from "./snapshot-quality-pipeline.mjs";
import { DAILY_MODEL_VERSIONS } from "./daily-production.mjs";

export const MODEL_MATURITY_COVERAGE_SCHEMA_VERSION = 1;
export const MODEL_MATURITY_HORIZONS = ["1D", "5D", "20D", "60D"];

const modelValue = (record, version) => {
  if (version === "A-v1") return { score: record.scoresByVersion?.[version] ?? record.scores?.modelA, rank: record.ranksByVersion?.[version] ?? record.ranks?.modelA };
  if (version === "A-v2") return { score: record.scoresByVersion?.[version], rank: record.ranksByVersion?.[version] };
  const key = { "B-v1": "modelB", "C-v1": "modelC", "D-v1": "modelD" }[version];
  return { score: record.scores?.[key], rank: record.ranks?.[key] };
};

function createHorizonTotals() {
  return Object.fromEntries(MODEL_MATURITY_HORIZONS.map((horizon) => [horizon, {
    totalSignals: 0, MATURE: 0, PENDING: 0, DATA_MISSING: 0, matureRate: null, dataMissingReasons: {},
  }]));
}

function addObservation(total, coverage) {
  total.totalSignals += 1;
  const status = coverage?.status;
  if (status === "MATURE" || status === "PENDING" || status === "DATA_MISSING") {
    total[status] += 1;
  } else {
    total.DATA_MISSING += 1;
    total.dataMissingReasons.coverageRecordMissing = (total.dataMissingReasons.coverageRecordMissing ?? 0) + 1;
    return;
  }
  if (status === "DATA_MISSING") {
    const reason = coverage.reason ?? "unknown";
    total.dataMissingReasons[reason] = (total.dataMissingReasons[reason] ?? 0) + 1;
  }
}

export function buildModelMaturityCoverageReport({ snapshots, coverageArtifacts }) {
  const coverageByDate = new Map(coverageArtifacts.map((artifact) => [artifact.signalDate, artifact]));
  const models = Object.fromEntries(DAILY_MODEL_VERSIONS.map((version) => [version, {
    modelVersion: version,
    selectionDefinition: "finiteScoreAndIntegerRank",
    horizons: createHorizonTotals(),
  }]));
  const usedCoverage = [];
  for (const snapshot of [...snapshots].sort((left, right) => left.asOfDate.localeCompare(right.asOfDate))) {
    const coverage = coverageByDate.get(snapshot.asOfDate);
    if (!coverage) throw new Error(`${snapshot.asOfDate}: outcome coverage artifact가 없습니다.`);
    const snapshotHash = snapshot.contentHash ?? sha256Canonical(snapshot);
    if (coverage.sourceSnapshotHash !== snapshotHash) throw new Error(`${snapshot.asOfDate}: outcome coverage sourceSnapshotHash가 일치하지 않습니다.`);
    const byTicker = new Map(coverage.records.map((record) => [record.ticker, record]));
    usedCoverage.push({ signalDate: snapshot.asOfDate, contentHash: coverage.contentHash });
    for (const record of snapshot.records) {
      const coverageRecord = byTicker.get(record.code);
      for (const version of DAILY_MODEL_VERSIONS) {
        const value = modelValue(record, version);
        if (!Number.isFinite(value.score) || !Number.isInteger(value.rank)) continue;
        for (const horizon of MODEL_MATURITY_HORIZONS) addObservation(models[version].horizons[horizon], coverageRecord?.horizons?.[horizon]);
      }
    }
  }
  for (const model of Object.values(models)) {
    for (const total of Object.values(model.horizons)) {
      total.matureRate = total.totalSignals === 0 ? null : Number((total.MATURE / total.totalSignals * 100).toFixed(4));
    }
  }
  const base = {
    schemaVersion: MODEL_MATURITY_COVERAGE_SCHEMA_VERSION,
    dataset: "model-maturity-coverage-report",
    coverageAsOfDate: coverageArtifacts.map((artifact) => artifact.coverageAsOfDate).sort().at(-1) ?? null,
    observationDefinition: "one ranked ticker in one model snapshot on one signalDate; repeated tickers on different signal dates are independent observations",
    coverageSource: "daily-outcome-coverage",
    models,
    sourceCoverageArtifacts: usedCoverage,
  };
  return { ...base, contentHash: sha256Canonical(base) };
}

export function renderModelMaturityCoverageMarkdown(report) {
  const lines = ["# Model maturity coverage", "", `Coverage as of: ${report.coverageAsOfDate ?? "unknown"}`, "", "| Model | Horizon | Total signals | Mature | Pending | Data missing | Mature rate |", "| --- | --- | ---: | ---: | ---: | ---: | ---: |"];
  for (const [version, model] of Object.entries(report.models)) {
    for (const horizon of MODEL_MATURITY_HORIZONS) {
      const total = model.horizons[horizon];
      lines.push(`| ${version} | ${horizon} | ${total.totalSignals} | ${total.MATURE} | ${total.PENDING} | ${total.DATA_MISSING} | ${total.matureRate == null ? "N/A" : `${total.matureRate}%`} |`);
    }
  }
  lines.push("", "## Data-missing reasons", "");
  for (const [version, model] of Object.entries(report.models)) {
    for (const horizon of MODEL_MATURITY_HORIZONS) {
      const reasons = Object.entries(model.horizons[horizon].dataMissingReasons);
      if (reasons.length) lines.push(`- ${version} ${horizon}: ${reasons.map(([reason, count]) => `${reason} (${count})`).join(", ")}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

async function loadJsonDirectory(directory) {
  try {
    const names = (await fs.readdir(directory)).filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/u.test(name)).sort();
    return Promise.all(names.map((name) => fs.readFile(path.join(directory, name), "utf8").then(JSON.parse)));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

export async function writeModelMaturityCoverageReport({ root = process.cwd() }) {
  const [snapshots, coverageArtifacts] = await Promise.all([
    loadJsonDirectory(path.join(root, "data", "history")),
    loadJsonDirectory(path.join(root, "data", "outcome-coverage")),
  ]);
  const report = buildModelMaturityCoverageReport({ snapshots, coverageArtifacts });
  const directory = path.join(root, "data", "model-validation");
  await fs.mkdir(directory, { recursive: true });
  const jsonPath = path.join(directory, "maturity-coverage.json");
  const markdownPath = path.join(directory, "maturity-coverage.md");
  const output = [[jsonPath, `${JSON.stringify(report, null, 2)}\n`], [markdownPath, renderModelMaturityCoverageMarkdown(report)]];
  const changedPaths = [];
  for (const [target, content] of output) {
    let current = null;
    try { current = await fs.readFile(target, "utf8"); } catch (error) { if (error?.code !== "ENOENT") throw error; }
    if (current === content) continue;
    await fs.writeFile(target, content, "utf8");
    changedPaths.push(path.relative(root, target).replaceAll("\\", "/"));
  }
  return { report, changedPaths };
}
