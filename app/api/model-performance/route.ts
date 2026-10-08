import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { buildIntradayModelTopPerformance, buildModelTopPerformance, MODEL_PERFORMANCE_HORIZONS } from "@/lib/model-top-performance.mjs";

const HORIZON_FIELDS = {
  "1DAY": { directory: "1d", returnKey: "future1dReturn", dateKey: "future1dDate" },
  "5DAY": { directory: "5d", returnKey: "future5dReturn", dateKey: "future5dDate" },
  "20DAY": { directory: "20d", returnKey: "future20dReturn", dateKey: "future20dDate" },
} as const;

type HistoryRecord = {
  code: string;
  futureReturns?: Record<string, number | null | Record<string, string | null>>;
  [key: string]: unknown;
};
type HistorySnapshot = { asOfDate: string; records: HistoryRecord[]; [key: string]: unknown };
type OutcomeRecord = { ticker: string; status: string; reason: string | null; returnPercent: number | null };
type OutcomeArtifact = {
  schemaVersion: number;
  dataset: string;
  signalDate: string;
  targetTradingDate: string | null;
  returnDefinition: string | null;
  records: OutcomeRecord[];
  [key: string]: unknown;
};

async function readJsonFiles<T>(directory: string): Promise<T[]> {
  let names: string[];
  try { names = (await readdir(directory)).filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/u.test(name)).sort(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return Promise.all(names.map(async (name) => JSON.parse(await readFile(path.join(directory, name), "utf8")) as T));
}

function embeddedOutcome(snapshot: HistorySnapshot, horizon: keyof typeof HORIZON_FIELDS): OutcomeArtifact | null {
  const fields = HORIZON_FIELDS[horizon];
  const records = (snapshot.records ?? []).map((record) => {
    const returnPercent = record.futureReturns?.[fields.returnKey];
    const finiteReturn = typeof returnPercent === "number" && Number.isFinite(returnPercent) ? returnPercent : null;
    return {
      ticker: record.code,
      status: finiteReturn == null ? "PENDING" : "MATURE",
      reason: finiteReturn == null ? "outcomeNotMature" : null,
      returnPercent: finiteReturn,
    };
  });
  if (!records.some((record) => record.status === "MATURE")) return null;
  const targetTradingDate = (snapshot.records ?? []).map((record) => {
    const resolvedAt = record.futureReturns?.resolvedAt;
    return typeof resolvedAt === "object" && resolvedAt ? resolvedAt[fields.dateKey] : null;
  }).find((date): date is string => typeof date === "string") ?? null;
  return {
    schemaVersion: 1,
    dataset: `resolved-history-${fields.directory}-outcomes`,
    signalDate: snapshot.asOfDate,
    targetTradingDate,
    returnDefinition: `frozen signal close to T+${horizon.replace("DAY", "")} official trading-day close return`,
    records,
  };
}

export async function GET() {
  const root = process.cwd();
  const historyDir = path.join(root, "data", "history");
  try {
    const snapshots = await readJsonFiles<HistorySnapshot>(historyDir);
    const outcomesByHorizon = Object.fromEntries(await Promise.all(MODEL_PERFORMANCE_HORIZONS.map(async (horizon) => {
      const fields = HORIZON_FIELDS[horizon as keyof typeof HORIZON_FIELDS];
      const immutable = await readJsonFiles<OutcomeArtifact>(path.join(root, "data", "historical-outcomes", fields.directory));
      const bySignalDate = new Map(immutable.map((outcome) => [outcome.signalDate, outcome]));
      for (const snapshot of snapshots) {
        if (bySignalDate.has(snapshot.asOfDate)) continue;
        const resolved = embeddedOutcome(snapshot, horizon as keyof typeof HORIZON_FIELDS);
        if (resolved) bySignalDate.set(snapshot.asOfDate, resolved);
      }
      return [horizon, [...bySignalDate.values()].sort((left, right) => left.signalDate.localeCompare(right.signalDate))];
    })));
    const daily = buildModelTopPerformance({ snapshots, outcomesByHorizon });
    let intradayOutcomes: Record<string, unknown>[] = [];
    try { intradayOutcomes = await readJsonFiles<Record<string, unknown>>(path.join(root, "data", "intraday-outcomes", "model-top")); }
    catch { intradayOutcomes = []; }
    return NextResponse.json({ ...daily, latestEodReferenceDate: snapshots.at(-1)?.asOfDate ?? null, performanceLayer: "DAILY_EOD", live: buildIntradayModelTopPerformance({ outcomes: intradayOutcomes }) }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({
      schemaVersion: 2,
      dataset: "model-top-performance",
      availableHorizons: [],
      matureSignalDates: [],
      matureSignalDatesByHorizon: { "1DAY": [], "5DAY": [], "20DAY": [] },
      signalDateRange: null,
      lastOutcomeDate: null,
      latestEodReferenceDate: null,
      totalOutcomeObservationCount: 0,
      daily: [],
      summary: [],
      performanceLayer: "DAILY_EOD",
      live: buildIntradayModelTopPerformance({ outcomes: [] }),
    }, { headers: { "Cache-Control": "no-store" } });
  }
}
