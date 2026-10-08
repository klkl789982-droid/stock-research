import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";

type StoredStatus = {
  snapshotReferenceDate?: string | null;
  observedOfficialDate?: string | null;
  freshnessStatus?: string;
  freshnessReason?: string | null;
  runStatus?: string;
  updatedAt?: string;
  lastAttemptAt?: string | null;
  lastAutomaticRunAt?: string | null;
  lastSuccessAt?: string | null;
  lastOfficialEodDate?: string | null;
  lagTradingDays?: number | null;
  recentFailureReason?: string | null;
  lastFailureAt?: string | null;
  publishedReferenceDate?: string | null;
  publicationStatus?: string;
  trigger?: string;
};

type WorkflowRun = { run_started_at?: string; created_at?: string; conclusion?: string | null; status?: string; html_url?: string };

async function latestSnapshotReferenceDate(root: string) {
  const names = (await readdir(path.join(root, "data", "history")))
    .filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/u.test(name))
    .sort();
  return names.at(-1)?.slice(0, 10) ?? null;
}

async function latestScheduledRun(): Promise<WorkflowRun | null> {
  try {
    const response = await fetch("https://api.github.com/repos/klkl789982-droid/stock-research/actions/workflows/daily-production.yml/runs?event=schedule&per_page=1", {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "Tight-Budget-Operations-Status" },
      next: { revalidate: 300 },
    });
    if (!response.ok) return null;
    const body = await response.json() as { workflow_runs?: WorkflowRun[] };
    return body.workflow_runs?.[0] ?? null;
  } catch {
    return null;
  }
}

export async function GET() {
  const root = process.cwd();
  try {
    const [stored, siteApiReferenceDate, scheduledRun] = await Promise.all([
      readFile(path.join(root, "data", "daily-production-status", "latest.json"), "utf8").then((value) => JSON.parse(value) as StoredStatus),
      latestSnapshotReferenceDate(root),
      latestScheduledRun(),
    ]);
    const publishedReferenceDate = stored.publishedReferenceDate ?? stored.snapshotReferenceDate ?? null;
    const publicationStatus = stored.publicationStatus ?? (publishedReferenceDate === siteApiReferenceDate ? "published" : "unknown");
    return NextResponse.json({
      schemaVersion: 1,
      dataset: "daily-production-operations-status",
      lastAttemptAt: stored.lastAttemptAt ?? stored.updatedAt ?? null,
      lastAutomaticRunAt: scheduledRun?.run_started_at ?? scheduledRun?.created_at ?? stored.lastAutomaticRunAt ?? null,
      lastAutomaticRunStatus: scheduledRun?.status ?? null,
      lastAutomaticRunConclusion: scheduledRun?.conclusion ?? null,
      lastAutomaticRunUrl: scheduledRun?.html_url ?? null,
      lastSuccessAt: stored.lastSuccessAt ?? stored.updatedAt ?? null,
      lastOfficialEodDate: stored.lastOfficialEodDate ?? stored.observedOfficialDate ?? null,
      latestConfirmedTradingDate: stored.observedOfficialDate ?? null,
      lagTradingDays: Number.isInteger(stored.lagTradingDays) ? stored.lagTradingDays : stored.snapshotReferenceDate === stored.observedOfficialDate ? 0 : null,
      recentFailureReason: stored.recentFailureReason ?? null,
      lastFailureAt: stored.lastFailureAt ?? null,
      runStatus: stored.runStatus ?? null,
      freshnessStatus: stored.freshnessStatus ?? "unavailable",
      freshnessReason: stored.freshnessReason ?? null,
      publishedReferenceDate,
      publicationStatus,
      siteApiReferenceDate,
      siteApiMatchesPublished: siteApiReferenceDate !== null && siteApiReferenceDate === publishedReferenceDate,
      trigger: stored.trigger ?? null,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({
      schemaVersion: 1,
      dataset: "daily-production-operations-status",
      runStatus: "UNAVAILABLE",
      freshnessStatus: "unavailable",
      publicationStatus: "unknown",
      siteApiReferenceDate: null,
      siteApiMatchesPublished: false,
    }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
