// Pure Actions job metadata contract. No network, Node globals or hash generation.
import { isCommitSha, isReferenceDate } from "./publication-identity-format.mjs";
import { VERIFICATION_REASONS } from "./daily-production-deployment-verifier.mjs";
export const PUBLICATION_REPOSITORY = "klkl789982-droid/stock-research";
const WORKFLOW = ".github/workflows/daily-production.yml";
const trustedActors = new Set(["klkl789982-droid", "github-actions[bot]"]);
const validTime = (value, now) => typeof value === "string" && Number.isFinite(Date.parse(value)) && Date.parse(value) <= now + 60_000;
const markerPattern = /^Publication evidence v1 \| (VERIFIED|FAILED) \| (\d{4}-\d{2}-\d{2}) \| ([a-f0-9]{64}) \| ([a-f0-9]{40}) \| ([A-Z0-9_]+)$/u;

export function trustedProductionRun(run) {
  return run?.repository?.full_name === PUBLICATION_REPOSITORY && run?.head_repository?.full_name === PUBLICATION_REPOSITORY
    && run.path === WORKFLOW && run.head_branch === "main" && ["schedule", "workflow_dispatch"].includes(run.event)
    && trustedActors.has(run.actor?.login) && isCommitSha(run.head_sha) && Number.isSafeInteger(run.id) && Number.isInteger(run.run_attempt) && run.run_attempt > 0;
}

// Transported through GitHub's existing job metadata, not user-generated logs.
// Success must be supported by both the verifier step and its marker step.
export function parsePublicationEvidence(run, jobs, now = Date.now()) {
  if (!trustedProductionRun(run)) return [];
  const matching = jobs.filter((job) => job.name === "publish" && job.run_id === run.id && job.head_sha === run.head_sha && job.run_attempt === run.run_attempt);
  if (matching.length !== 1) return [];
  const job = matching[0];
  const markers = (job.steps ?? []).filter((step) => step.name?.startsWith("Publication evidence v1"));
  const verifiers = (job.steps ?? []).filter((step) => step.name === "Verify Vercel deployment and production APIs");
  if (markers.length !== 1 || verifiers.length !== 1) return [];
  const marker = markers[0], verifier = verifiers[0], match = markerPattern.exec(marker.name);
  if (!match || marker.status !== "completed" || marker.conclusion !== "success" || verifier.status !== "completed"
    || !validTime(verifier.completed_at, now) || !validTime(marker.completed_at, now) || !validTime(run.run_started_at, now)
    || Date.parse(verifier.completed_at) < Date.parse(run.run_started_at) || Date.parse(marker.completed_at) < Date.parse(verifier.completed_at)) return [];
  const [, status, referenceDate, snapshotHash, commitSha, reason] = match;
  if (!isReferenceDate(referenceDate) || referenceDate > new Date(Date.parse(verifier.completed_at) + 9 * 3_600_000).toISOString().slice(0, 10) || !VERIFICATION_REASONS.includes(reason)
    || status === "VERIFIED" && (verifier.conclusion !== "success" || reason !== "NONE")
    || status === "FAILED" && (verifier.conclusion !== "failure" || reason === "NONE")) return [];
  return [{ status, referenceDate, snapshotHash, commitSha, reason: reason === "NONE" ? null : reason,
    checkedAt: verifier.completed_at, verifiedAt: status === "VERIFIED" ? verifier.completed_at : null,
    runId: run.id, runAttempt: run.run_attempt, sourceCommitSha: run.head_sha,
    runUrl: `https://github.com/${PUBLICATION_REPOSITORY}/actions/runs/${run.id}/attempts/${run.run_attempt}` }];
}
