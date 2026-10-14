import { isCommitSha, isReferenceDate, safeDataIdentity, sameSnapshot } from "./publication-identity.mjs";
import { VERIFICATION_REASONS } from "./daily-production-deployment-verifier.mjs";

export const PUBLICATION_REPOSITORY = "klkl789982-droid/stock-research";
const API = `https://api.github.com/repos/${PUBLICATION_REPOSITORY}`;
const PRODUCTION_VERCEL_CONTEXT = "Vercel – stock-research";
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

export function summarizePublicationAttempt(run, jobs) {
  if (!trustedProductionRun(run)) return null;
  const job = jobs.find((item) => item.name === "publish" && item.run_id === run.id && item.run_attempt === run.run_attempt && item.head_sha === run.head_sha);
  const failed = (job?.steps ?? []).find((step) => step.conclusion === "failure");
  const stage = ({ "Run candidate pipeline once": "COLLECTION", "Mark validated candidate promoted": "VALIDATION",
    "Stage only allowlisted artifacts": "REPOSITORY", "Commit and push atomic promotion": "REPOSITORY",
    "Verify Vercel deployment and production APIs": "VERIFICATION", "Fail unsuccessful run": "COLLECTION" })[failed?.name] ?? (failed ? "WORKFLOW" : null);
  return { status: run.status, conclusion: run.conclusion ?? null, stage, startedAt: run.run_started_at,
    completedAt: job?.completed_at ?? run.updated_at ?? null, sourceCommitSha: run.head_sha,
    runUrl: `https://github.com/${PUBLICATION_REPOSITORY}/actions/runs/${run.id}/attempts/${run.run_attempt}` };
}

const metadataError = (error) => error?.name === "TimeoutError" || error?.name === "AbortError" ? "GITHUB_TIMEOUT"
  : ["GITHUB_401", "GITHUB_403", "GITHUB_429", "GITHUB_INVALID_RESPONSE", "GITHUB_EVIDENCE_EXPIRED"].includes(error?.message) ? error.message : "GITHUB_UNAVAILABLE";
async function githubJson(fetchImpl, suffix, now, observedTimes) {
  const response = await fetchImpl(`${API}${suffix}`, { headers: { Accept: "application/vnd.github+json", "User-Agent": "Tight-Budget-Operations-Status" }, next: { revalidate: 600 }, redirect: "error", signal: AbortSignal.timeout(8_000) });
  if (!response.ok) throw new Error(`GITHUB_${response.status}`);
  // Next can retain an old successful response after failed revalidation. Its
  // original HTTP Date is retained too; never restamp stale success as current.
  const observedAt = Date.parse(response.headers.get("date") ?? "");
  if (!Number.isFinite(observedAt) || observedAt > now + 60_000) throw new Error("GITHUB_INVALID_RESPONSE");
  if (now - observedAt > 600_000) throw new Error("GITHUB_EVIDENCE_EXPIRED");
  observedTimes.push(observedAt);
  return response.json();
}

// Seven reads per ordinary ten-minute refresh with three recent runs; cache-key
// changes can add calls. Rate limits fail closed. No token, storage, or collector.
export async function loadPublicationEvidence({ fetchImpl = fetch, now = Date.now() } = {}) {
  let headSha = null, intended = null, runs = [];
  const observedTimes = [];
  const read = (suffix) => githubJson(fetchImpl, suffix, now, observedTimes);
  try {
    const [head, listed] = await Promise.all([
      read("/commits/main"),
      read("/actions/workflows/daily-production.yml/runs?branch=main&per_page=3"),
    ]);
    if (!isCommitSha(head?.sha)) throw new Error("GITHUB_INVALID_RESPONSE");
    headSha = head.sha;
    runs = (listed?.workflow_runs ?? []).filter(trustedProductionRun);
    const [file, combined, ...jobLists] = await Promise.all([
      read(`/contents/data/daily-production-status/latest.json?ref=${headSha}`),
      read(`/commits/${headSha}/status`),
      ...runs.map((run) => read(`/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`)),
    ]);
    if (file?.encoding !== "base64" || file.size > 100_000 || typeof file.content !== "string") throw new Error("GITHUB_INVALID_RESPONSE");
    intended = JSON.parse(Buffer.from(file.content, "base64").toString("utf8"));
    if (!validTime(intended?.updatedAt, now) || intended?.snapshotIdentity?.referenceDate > new Date(now + 9 * 3_600_000).toISOString().slice(0, 10)) throw new Error("GITHUB_INVALID_RESPONSE");
    const vercel = (combined?.statuses ?? []).filter((status) => status.context === PRODUCTION_VERCEL_CONTEXT);
    const vercelState = combined?.sha !== headSha || !vercel.length ? "unknown" : vercel.some((status) => ["failure", "error"].includes(status.state)) ? "failure" : vercel.some((status) => status.state === "pending") ? "pending" : vercel.every((status) => status.state === "success") ? "success" : "unknown";
    const latestAttempt = runs[0] ? summarizePublicationAttempt(runs[0], jobLists[0]?.jobs ?? []) : null;
    const evidence = runs.flatMap((run, index) => parsePublicationEvidence(run, jobLists[index]?.jobs ?? [], now)).sort((a, b) => b.checkedAt.localeCompare(a.checkedAt));
    return { availability: "AVAILABLE", headSha, intended, runs, vercelState, evidence, latestAttempt, checkedAt: new Date(Math.min(...observedTimes)).toISOString(), reason: null };
  } catch (error) {
    return { availability: "UNAVAILABLE", headSha, intended: null, runs: [], vercelState: "unknown", evidence: [], checkedAt: new Date(now).toISOString(), reason: metadataError(error) };
  }
}

export function reconcilePublication(localIdentity, remote) {
  const local = safeDataIdentity(localIdentity);
  const intended = safeDataIdentity({ ...remote?.intended?.snapshotIdentity, commitSha: remote?.headSha });
  const records = remote?.evidence ?? [];
  const lastVerified = records.find((item) => item.status === "VERIFIED") ?? null;
  const matching = records.find((item) => sameSnapshot(item, intended) && item.commitSha === intended?.commitSha) ?? null;
  const base = { state: "UNVERIFIED", reason: null, intendedIdentity: intended, localIdentity: local, lastVerified,
    checkedAt: remote?.checkedAt ?? null, verification: matching, metadataAvailability: remote?.availability ?? "UNAVAILABLE" };
  if (remote?.availability !== "AVAILABLE") return { ...base, reason: remote?.reason ?? "EVIDENCE_UNAVAILABLE" };
  if (!intended || !local?.commitSha) return { ...base, reason: "IDENTITY_UNAVAILABLE" };
  if (remote.vercelState === "failure") return { ...base, state: "DEPLOYMENT_FAILED", reason: "VERCEL_DEPLOYMENT_FAILED" };
  if (matching?.status === "FAILED") return { ...base, state: "VERIFICATION_FAILED", reason: matching.reason };
  if (!sameSnapshot(local, intended) || local.commitSha !== intended.commitSha) return { ...base, state: "DEPLOYING", reason: !sameSnapshot(local, intended) ? "SITE_SNAPSHOT_DIFFERS_REPOSITORY" : "SITE_COMMIT_DIFFERS_REPOSITORY" };
  if (matching?.status === "VERIFIED") return { ...base, state: "VERIFIED", reason: null };
  if (remote.vercelState === "pending") return { ...base, state: "DEPLOYING", reason: "VERCEL_DEPLOYMENT_PENDING" };
  return { ...base, reason: "EXACT_DEPLOYMENT_EVIDENCE_MISSING" };
}
