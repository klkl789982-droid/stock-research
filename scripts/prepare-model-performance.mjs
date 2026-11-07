import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { dataIdentity } from "../lib/publication-identity.mjs";
import { privateReportDirectory } from "../lib/private-report-directory.mjs";
import { buildIntradayModelTopPerformance, buildModelTopPerformance, MODEL_PERFORMANCE_HORIZONS } from "../lib/model-top-performance.mjs";

const HORIZON_FIELDS = {
  "1DAY": { directory: "1d", returnKey: "future1dReturn", dateKey: "future1dDate" },
  "5DAY": { directory: "5d", returnKey: "future5dReturn", dateKey: "future5dDate" },
  "20DAY": { directory: "20d", returnKey: "future20dReturn", dateKey: "future20dDate" },
  "60DAY": { directory: "60d", returnKey: "future60dReturn", dateKey: "future60dDate" },
};

function observedClose(signalDate, target, asOf) {
  return typeof target === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(target) && target > signalDate
    && Date.parse(target + "T15:30:00+09:00") <= asOf;
}

async function readDates(directory) {
  let names;
  try { names = await readdir(directory); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
  const dated = names.filter(name => /^\d{4}-\d{2}-\d{2}\.json$/u.test(name)).sort();
  return Promise.all(dated.map(async name => JSON.parse(await readFile(path.join(directory, name), "utf8"))));
}

function embeddedOutcome(snapshot, horizon, asOf) {
  const fields = HORIZON_FIELDS[horizon];
  const records = (snapshot.records ?? []).map(record => {
    const value = record.futureReturns?.[fields.returnKey];
    const returnPercent = Number.isFinite(value) ? value : null;
    const targetTradingDate = record.futureReturns?.resolvedAt?.[fields.dateKey];
    const mature = returnPercent !== null && observedClose(snapshot.asOfDate, targetTradingDate, asOf);
    return { ticker: record.code, status: mature ? "MATURE" : "PENDING", reason: mature ? null : "outcomeNotVerified",
      returnPercent, targetTradingDate: typeof targetTradingDate === "string" ? targetTradingDate : null };
  });
  if (!records.some(record => record.status === "MATURE")) return null;
  const targetTradingDate = records.find(record => record.targetTradingDate !== null)?.targetTradingDate ?? null;
  return { schemaVersion: 1, dataset: "resolved-history-" + fields.directory + "-outcomes", signalDate: snapshot.asOfDate,
    sourceSnapshotHash: snapshot.contentHash ?? null, targetTradingDate,
    returnDefinition: "frozen signal close to T+" + horizon.replace("DAY", "") + " official trading-day close return", records };
}

function homeRows(layer) {
  const rows = new Map();
  for (const row of layer.daily) {
    if (row.horizon !== "1DAY" || row.topN !== 5 || !row.observationCount || !Number.isFinite(row.meanReturn)) continue;
    if (rows.has(row.modelVersion) && rows.get(row.modelVersion).signalDate >= row.signalDate) continue;
    const { modelVersion, horizon, topN, signalDate, targetTradingDate, observationCount, rankedConstituentCount, meanReturn, positiveRate } = row;
    rows.set(modelVersion, { modelVersion, horizon, topN, signalDate, targetTradingDate, observationCount, rankedConstituentCount, meanReturn, positiveRate });
  }
  return [...rows.values()];
}

// Only bundled EOD and the archived 14:30 layer. The current 14:00 delivery has its own revision-aware route.
export async function prepareModelPerformance({ root = process.cwd(), asOf = Date.now(), commitSha = process.env.VERCEL_GIT_COMMIT_SHA } = {}) {
  const data = (...parts) => path.join(root, "data", ...parts);
  const snapshots = await readDates(data("history"));
  const outcomesByHorizon = Object.fromEntries(await Promise.all(MODEL_PERFORMANCE_HORIZONS.map(async horizon => {
    const immutable = await readDates(data("historical-outcomes", HORIZON_FIELDS[horizon].directory));
    const byDate = new Map(immutable.map(outcome => [outcome.signalDate, { ...outcome, records: outcome.records.filter(row =>
      row.status !== "MATURE" || observedClose(outcome.signalDate, "targetTradingDate" in row ? row.targetTradingDate : outcome.targetTradingDate, asOf)) }]));
    for (const snapshot of snapshots) {
      if (byDate.has(snapshot.asOfDate)) continue;
      const resolved = embeddedOutcome(snapshot, horizon, asOf);
      if (resolved) byDate.set(snapshot.asOfDate, resolved);
    }
    return [horizon, [...byDate.values()].sort((a, b) => a.signalDate.localeCompare(b.signalDate))];
  })));
  const archived = await readDates(data("intraday-outcomes", "model-top"));
  // Apply the same as-of cutoff to an archived MATURE label before freezing
  // the report. These objects are the builder's parsed copies, never the source.
  for (const outcome of archived) for (const row of outcome.records ?? []) {
    for (const leg of Object.values(row.horizons ?? {})) {
      if (leg?.status !== "MATURE" || observedClose(outcome.signalDate, leg.targetTradingDate, asOf)) continue;
      const closeTime = Date.parse(leg.targetTradingDate + "T15:30:00+09:00");
      leg.status = closeTime > asOf ? "PENDING" : "DATA_MISSING";
      leg.returnPercent = null;
    }
  }
  const report = { ...buildModelTopPerformance({ snapshots, outcomesByHorizon }), dataIdentity: dataIdentity(snapshots.at(-1), commitSha),
    publicationReady: snapshots.length > 0, latestEodReferenceDate: snapshots.at(-1)?.asOfDate ?? null, performanceLayer: "DAILY_EOD",
    live: buildIntradayModelTopPerformance({ outcomes: archived }) };
  const identity = { dataIdentity: report.dataIdentity, publicationReady: report.publicationReady, latestEodReferenceDate: report.latestEodReferenceDate };
  const home = { ...identity, daily: homeRows(report), live: { daily: homeRows(report.live) } };
  const directory = path.join(privateReportDirectory(root), "private-model-performance");
  await mkdir(directory, { recursive: true });
  for (const [filename, payload] of Object.entries({ report, home, identity })) {
    await writeFile(path.join(directory, filename + ".json"), JSON.stringify(payload), "utf8");
  }
  return { report, home, identity };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { identity } = await prepareModelPerformance();
  console.log("Prepared private model performance for", identity.latestEodReferenceDate ?? "empty history");
}
