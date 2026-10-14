import assert from "node:assert/strict";
import { dataIdentity, snapshotIdentity, sameSnapshot } from "../lib/publication-identity.mjs";
import { loadPublicationEvidence, parsePublicationEvidence, reconcilePublication, summarizePublicationAttempt, PUBLICATION_REPOSITORY } from "../lib/daily-publication-status.mjs";
import { dailyOperationState, calendarContext } from "../lib/home-dashboard.mjs";

const now = Date.parse("2026-10-14T05:00:00Z"), sha = "a".repeat(40), previousSha = "b".repeat(40);
const snapshot = { asOfDate: "2026-10-13", records: [{ code: "005930", score: 1 }], contentHash: "declared-untrusted" };
const identity = dataIdentity(snapshot, sha);
assert.deepEqual(snapshotIdentity({ records: snapshot.records, contentHash: snapshot.contentHash, asOfDate: snapshot.asOfDate }), snapshotIdentity(snapshot));
assert.notEqual(snapshotIdentity({ ...snapshot, records: [{ code: "005930", score: 2 }] }).snapshotHash, identity.snapshotHash, "Same date / declared hash cannot conceal wrong actual bytes");
assert.equal(dataIdentity(snapshot, "missing").commitSha, null);
assert.equal(snapshotIdentity({ ...snapshot, asOfDate: "2026-02-30" }), null);
const run = { id: 42, run_attempt: 2, run_started_at: "2026-10-14T04:00:00Z", repository: { full_name: PUBLICATION_REPOSITORY }, head_repository: { full_name: PUBLICATION_REPOSITORY }, path: ".github/workflows/daily-production.yml", head_branch: "main", event: "workflow_dispatch", actor: { login: "klkl789982-droid" }, head_sha: previousSha };
const marker = (status = "VERIFIED", reason = "NONE") => `Publication evidence v1 | ${status} | ${identity.referenceDate} | ${identity.snapshotHash} | ${sha} | ${reason}`;
const job = { name: "publish", run_id: run.id, run_attempt: run.run_attempt, head_sha: run.head_sha, steps: [
  { name: "Verify Vercel deployment and production APIs", status: "completed", conclusion: "success", completed_at: "2026-10-14T04:40:00Z" },
  { name: marker(), status: "completed", conclusion: "success", completed_at: "2026-10-14T04:40:01Z" },
] };
const evidence = parsePublicationEvidence(run, [job], now);
assert.equal(evidence.length, 1);
assert.equal(evidence[0].sourceCommitSha, previousSha, "Workflow head is pre-push; target is post-push SHA");
assert.equal(evidence[0].commitSha, sha);
for (const altered of [
  { ...run, path: ".github/workflows/other.yml" }, { ...run, head_branch: "preview" }, { ...run, event: "pull_request" },
  { ...run, actor: { login: "outsider" } }, { ...run, repository: { full_name: "other/repo" } }, { ...run, head_repository: { full_name: "fork/repo" } },
  { ...run, run_attempt: 1 }, { ...run, head_sha: sha }, { ...run, run_started_at: "2026-10-14T06:00:00Z" },
]) assert.deepEqual(parsePublicationEvidence(altered, [job], now), []);
for (const conclusion of ["failure", "cancelled", "skipped", null]) {
  const altered = structuredClone(job); altered.steps[0].conclusion = conclusion;
  assert.deepEqual(parsePublicationEvidence(run, [altered], now), []);
}
for (const mutate of [
  j => { j.steps[1].name = "Publication evidence v1 | ${{ steps.verify.outputs.status }}"; },
  j => { j.steps.push({ ...j.steps[1] }); }, j => { j.steps[1].conclusion = "skipped"; },
  j => { j.steps[1].name = marker("FAILED", "SECRET_VALUE"); },
  j => { j.steps[0].completed_at = "2026-10-14T06:00:00Z"; },
  j => { j.steps[1].completed_at = "2026-10-14T04:39:00Z"; },
]) { const altered = structuredClone(job); mutate(altered); assert.deepEqual(parsePublicationEvidence(run, [altered], now), []); }
const failedJob = structuredClone(job); failedJob.steps[0].conclusion = "failure"; failedJob.steps[1].name = marker("FAILED", "HTTP_401");
assert.equal(parsePublicationEvidence(run, [failedJob], now)[0].reason, "HTTP_401");
const remote = { availability: "AVAILABLE", headSha: sha, intended: { snapshotIdentity: snapshotIdentity(snapshot) }, vercelState: "success", evidence, checkedAt: "2026-10-14T04:41:00Z" };
assert.equal(reconcilePublication(identity, remote).state, "VERIFIED");
assert.equal(reconcilePublication(identity, { ...remote, evidence: [] }).state, "UNVERIFIED", "Git and Vercel success without actual API proof never verify");
assert.equal(reconcilePublication(identity, { ...remote, availability: "UNAVAILABLE", reason: "GITHUB_403" }).state, "UNVERIFIED");
assert.equal(reconcilePublication(identity, { ...remote, vercelState: "failure" }).state, "DEPLOYMENT_FAILED", "Git push success / deploy failure");
assert.equal(reconcilePublication({ ...identity, commitSha: previousSha }, remote).state, "DEPLOYING");
assert.equal(reconcilePublication({ ...identity, snapshotHash: "0".repeat(64) }, remote).state, "DEPLOYING");
assert.equal(reconcilePublication(identity, { ...remote, evidence: [{ ...evidence[0], commitSha: previousSha }] }).state, "UNVERIFIED", "Stale commit evidence is historical only");
assert.equal(reconcilePublication(identity, { ...remote, evidence: [{ ...evidence[0], snapshotHash: "0".repeat(64) }] }).state, "UNVERIFIED");
const failed = reconcilePublication(identity, { ...remote, evidence: parsePublicationEvidence(run, [failedJob], now) });
assert.equal(failed.state, "VERIFICATION_FAILED");
assert.equal(failed.reason, "HTTP_401");
assert.ok(sameSnapshot(failed.localIdentity, identity), "Failure preserves old data identity");
const good = { sourceStatus: "NO_NEW_DATA", runStatus: "NO_NEW_OFFICIAL_EOD", siteApiReferenceDate: identity.referenceDate, deployment: reconcilePublication(identity, remote) };
for (const day of ["2026-10-14T09:00:00Z", "2026-10-14T11:30:00Z", "2026-10-17T14:00:00Z", "2026-10-18T23:00:00Z"]) assert.equal(dailyOperationState(good, calendarContext({}, new Date(day))), "SOURCE_WAITING", "No calendar guess or 20:30 cutoff changes successful no-new-data into failure");
assert.equal(dailyOperationState({ ...good, deployment: failed }, {}), "VERIFICATION_FAILED");
assert.equal(dailyOperationState({ ...good, runStatus: "FAILED", recentFailureReason: "LATEST_PROBE_NETWORK_TIMEOUT" }, {}), "FAILED");
assert.equal(dailyOperationState({ ...good, siteApiReferenceDate: "2026-12-01" }, { today: "2026-10-14" }), "UNKNOWN");
assert.equal(dailyOperationState({ ...good, deployment: { state: "UNVERIFIED" } }, {}), "UNVERIFIED");
const holiday = calendarContext({ dates: { "2026-10-08": { status: "tradingDay" }, "2026-10-09": { status: "marketClosed" } } }, new Date("2026-10-10T10:00:00Z"));
assert.equal(holiday.expectedTradingDate, "2026-10-08");
assert.equal(calendarContext({}, new Date("2026-10-10T10:00:00Z")).expectedTradingDate, null);

const pushFailureJob = { ...job, completed_at: "2026-10-14T04:45:00Z", steps: [{ name: "Commit and push atomic promotion", conclusion: "failure" }] };
const attempt = summarizePublicationAttempt({ ...run, status: "completed", conclusion: "failure" }, [pushFailureJob]);
assert.equal(attempt.stage, "REPOSITORY");
assert.equal(dailyOperationState({ ...good, latestAttempt: attempt, repositoryCommitSha: previousSha }, {}), "PUBLICATION_FAILED", "A failed post-validation Git push cannot be hidden by last-good site success");
assert.equal(good.deployment.lastVerified.verifiedAt, evidence[0].verifiedAt);
let calls = [];
const currentResponse = (value) => Response.json(value, { headers: { date: new Date(now - 1000).toUTCString() } });
const intended = { snapshotIdentity: snapshotIdentity(snapshot), updatedAt: "2026-10-14T04:00:00Z" };
const fetchImpl = async (url, options) => {
  calls.push(url); assert.equal(options.next.revalidate, 600); assert.equal(options.redirect, "error"); assert.equal(options.headers.Authorization, undefined);
  if (url.endsWith("/commits/main")) return currentResponse({ sha });
  if (url.includes("/runs?")) return currentResponse({ workflow_runs: [run] });
  if (url.includes("/contents/")) return currentResponse({ encoding: "base64", size: 200, content: Buffer.from(JSON.stringify(intended)).toString("base64") });
  if (url.endsWith("/status")) return currentResponse({ sha, statuses: [{ context: "Vercel – stock-research", state: "success" }, { context: "Vercel – stock-research-agr3", state: "failure" }] });
  if (url.includes("/attempts/2/jobs?")) return currentResponse({ jobs: [job] });
  throw new Error("unexpected");
};
const loaded = await loadPublicationEvidence({ fetchImpl, now });
assert.equal(loaded.checkedAt, new Date(now - 1000).toISOString());
assert.equal(loaded.availability, "AVAILABLE"); assert.equal(loaded.evidence.length, 1); assert.equal(calls.length, 5);
assert.equal(reconcilePublication(identity, loaded).state, "VERIFIED", "Unrelated Vercel project failure must not override canonical-site evidence");
for (const code of [401, 403, 429]) {
  const result = await loadPublicationEvidence({ fetchImpl: async () => Response.json({}, { status: code }), now });
  assert.equal(result.reason, `GITHUB_${code}`); assert.equal(result.availability, "UNAVAILABLE"); assert.deepEqual(result.evidence, []);
}
const staleSuccess = await loadPublicationEvidence({ fetchImpl: async (url, options) => {
  const response = await fetchImpl(url, options); response.headers.set("date", new Date(now - 601_000).toUTCString()); return response;
}, now });
assert.equal(staleSuccess.availability, "UNAVAILABLE"); assert.equal(staleSuccess.reason, "GITHUB_EVIDENCE_EXPIRED");
assert.equal(reconcilePublication(identity, staleSuccess).state, "UNVERIFIED", "Stale cached successes cannot remain green during failed revalidation");
const timeout = await loadPublicationEvidence({ fetchImpl: async () => { throw new DOMException("test", "TimeoutError"); }, now });
assert.equal(timeout.reason, "GITHUB_TIMEOUT");
console.log("publication truth: identity, exact-commit evidence, workflow trust, fault matrix, source/calendar, metadata quota and failure tests passed");
