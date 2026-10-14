import { withAdminAccess } from "@/lib/admin-access";
import { isAutomationRequest } from "@/lib/admin-auth.mjs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { nextProductionSchedule } from "@/lib/production-schedule.mjs";
import { dataIdentity, sameSnapshot } from "@/lib/publication-identity.mjs";
import { loadPublicationEvidence, reconcilePublication } from "@/lib/daily-publication-status.mjs";

type StoredStatus = {
  snapshotIdentity?: { referenceDate: string; snapshotHash: string } | null;
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
  sourceStatus?: string;
  lastKnownOfficialEodDate?: string | null;
  lastSourceCheckAt?: string | null;
  latestCollectedReferenceDate?: string | null;
  latestValidatedReferenceDate?: string | null;
};


async function latestSnapshot(root: string) {
  const names = (await readdir(path.join(root, "data", "history")))
    .filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/u.test(name)).sort();
  const name = names.at(-1);
  if (!name) return null;
  return JSON.parse(await readFile(path.join(root, "data", "history", name), "utf8"));
}

async function handleGet(request: Request) {
  const root = process.cwd();
  try {
    const [localStatus, snapshot] = await Promise.all([
      readFile(path.join(root, "data", "daily-production-status", "latest.json"), "utf8").then((value) => JSON.parse(value) as StoredStatus),
      latestSnapshot(root),
    ]);
    const identity = dataIdentity(snapshot);
    const local = { dataIdentity: identity, publicationReady: snapshot?.dataQuality?.structuralStatus === "passed" && identity !== null,
      siteApiReferenceDate: identity?.referenceDate ?? null, publicationStatus: localStatus.publicationStatus ?? "unknown" };
    // The deployment checker needs only this deployed data boundary. Reading its
    // own in-progress external evidence here would be circular (and slow).
    if (isAutomationRequest(request)) return NextResponse.json(local, { headers: { "Cache-Control": "no-store" } });
    const remote = await loadPublicationEvidence();
    const stored: StoredStatus = remote.availability === "AVAILABLE" ? remote.intended : localStatus;
    const deployment = reconcilePublication(identity, remote);
    const scheduledRun = remote.runs.find((run: { event?: string }) => run.event === "schedule");
    const publishedReferenceDate = stored.publishedReferenceDate ?? stored.snapshotReferenceDate ?? null;
    return NextResponse.json({
      ...local, schemaVersion: 2, dataset: "daily-production-operations-status",
      deployment,
      repositoryCommitSha: remote.headSha,
      latestAttempt: remote.availability === "AVAILABLE" ? remote.latestAttempt : null,
      repositoryStatusAvailable: remote.availability === "AVAILABLE",
      sourceStatus: stored.sourceStatus ?? "UNKNOWN",
      lastKnownOfficialEodDate: stored.lastKnownOfficialEodDate ?? stored.observedOfficialDate ?? null,
      lastSourceCheckAt: stored.lastSourceCheckAt ?? null,
      latestCollectedReferenceDate: stored.latestCollectedReferenceDate ?? null,
      latestValidatedReferenceDate: stored.latestValidatedReferenceDate ?? null,
      nextScheduledAt: nextProductionSchedule("DAILY"), scheduleTimingGuaranteed: false,
      lastAttemptAt: stored.lastAttemptAt ?? stored.updatedAt ?? null,
      lastAutomaticRunAt: scheduledRun?.run_started_at ?? scheduledRun?.created_at ?? stored.lastAutomaticRunAt ?? null,
      lastAutomaticRunStatus: scheduledRun?.status ?? null,
      lastAutomaticRunConclusion: scheduledRun?.conclusion ?? null,
      lastAutomaticRunUrl: scheduledRun ? `https://github.com/klkl789982-droid/stock-research/actions/runs/${scheduledRun.id}` : null,
      // Historical collection/promotion time, never a deployment success time.
      lastSuccessAt: stored.lastSuccessAt ?? null,
      lastGoodStoredReferenceDate: stored.publishedReferenceDate ?? null,
      lastOfficialEodDate: stored.lastOfficialEodDate ?? stored.observedOfficialDate ?? null,
      latestConfirmedTradingDate: stored.observedOfficialDate ?? null,
      lagTradingDays: Number.isInteger(stored.lagTradingDays) ? stored.lagTradingDays : null,
      recentFailureReason: stored.recentFailureReason ?? null,
      lastFailureAt: stored.lastFailureAt ?? null,
      runStatus: stored.runStatus ?? null,
      freshnessStatus: stored.freshnessStatus ?? "unavailable",
      freshnessReason: stored.freshnessReason ?? null,
      publishedReferenceDate,
      repositoryPublicationStatus: stored.publicationStatus ?? "unknown",
      siteApiMatchesPublished: sameSnapshot(identity, stored.snapshotIdentity),
      trigger: stored.trigger ?? null,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ schemaVersion: 2, dataset: "daily-production-operations-status", runStatus: "UNAVAILABLE", freshnessStatus: "unavailable",
      dataIdentity: null, publicationReady: false, publicationStatus: "unknown", siteApiReferenceDate: null, siteApiMatchesPublished: false,
      deployment: { state: "UNVERIFIED", reason: "LOCAL_STATUS_UNAVAILABLE", lastVerified: null },
    }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}

export const GET = withAdminAccess(handleGet);
