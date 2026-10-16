import { isCommitSha, isSnapshotHash, isReferenceDate, sameSnapshot } from "./publication-identity-format.mjs";
import { CURRENT_LIVE_PROFILE } from "./intraday-model-top-time-policy.mjs";
const trimSlash = (value) => value.replace(/\/+$/u, "");

export async function inspectLiveProductionDeployment({ siteUrl, expectedSignalDate, expectedContentHash, fetchImpl = fetch, automationToken = process.env.TB_AUTOMATION_READ_TOKEN }) {
  if (!isReferenceDate(expectedSignalDate) || !isSnapshotHash(expectedContentHash)) return false;
  const result = await readJson(fetchImpl, `${trimSlash(siteUrl)}/api/intraday-model-top?model=B&limit=1`, automationToken);
  const start = Date.parse(`${expectedSignalDate}T${CURRENT_LIVE_PROFILE.signalTime}+09:00`), end = Date.parse(`${expectedSignalDate}T${CURRENT_LIVE_PROFILE.windowEnd}+09:00`);
  const began = Date.parse(result?.collectionStartedAt), completed = Date.parse(result?.collectionCompletedAt);
  return result?.signalDate === expectedSignalDate && result?.observationType === "LIVE_OBSERVATION" && result.archived === false
    && result.officialSignalTime === CURRENT_LIVE_PROFILE.signalTime && result.signalVersion === CURRENT_LIVE_PROFILE.signalVersion
    && result.observationPolicyId === CURRENT_LIVE_PROFILE.policyId && result.contentHash === expectedContentHash
    && result.signalPath === `data/intraday-signals/model-top/${expectedSignalDate}/${CURRENT_LIVE_PROFILE.slot}.json`
    && Number.isFinite(began) && began >= start && Number.isFinite(completed) && completed >= began && completed <= end;
}

async function readJson(fetchImpl, url, token) {
  const response = await fetchImpl(url, { headers: { Accept: "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`HTTP_${response.status}`);
  const contentType = response.headers?.get?.("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) throw new Error("NON_JSON_RESPONSE");
  return response.json();
}

export const VERIFICATION_REASONS = Object.freeze(["NONE", "EXPECTED_IDENTITY_MISSING", "REFERENCE_DATE_NOT_DEPLOYED", "SNAPSHOT_HASH_MISMATCH", "SITE_COMMIT_MISMATCH", "SITE_SUMMARY_UNAVAILABLE", "HTTP_401", "HTTP_403", "HTTP_ERROR", "NON_JSON_RESPONSE", "REQUEST_TIMEOUT", "NETWORK_ERROR", "DEPLOYMENT_VERIFICATION_TIMEOUT"]);
export function verificationErrorReason(error) {
  if (["AbortError", "TimeoutError"].includes(error?.name)) return "REQUEST_TIMEOUT";
  if (VERIFICATION_REASONS.includes(error?.message)) return error.message;
  if (/^HTTP_\d{3}$/u.test(error?.message ?? "")) return "HTTP_ERROR";
  return "NETWORK_ERROR";
}

export async function inspectDailyProductionDeployment({ siteUrl, expectedReferenceDate, expectedSnapshotHash, expectedCommitSha, fetchImpl = fetch, automationToken = process.env.TB_AUTOMATION_READ_TOKEN }) {
  if (!isReferenceDate(expectedReferenceDate) || expectedReferenceDate > new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10) || !isSnapshotHash(expectedSnapshotHash) || !isCommitSha(expectedCommitSha)) return { matches: false, reason: "EXPECTED_IDENTITY_MISSING", actual: null };
  const base = trimSlash(siteUrl);
  const [top, performance, home, operations] = await Promise.all([
    readJson(fetchImpl, `${base}/api/top-stocks?model=A&limit=1`, automationToken),
    readJson(fetchImpl, `${base}/api/model-performance`, automationToken),
    readJson(fetchImpl, `${base}/api/home-dashboard?topN=5`, automationToken),
    readJson(fetchImpl, `${base}/api/daily-production-status`, automationToken),
  ]);
  const values = { top, performance, home, operations };
  const actual = {
    topReferenceDate: top?.rankingAsOfDate ?? null,
    performanceReferenceDate: performance?.latestEodReferenceDate ?? null,
    homeReferenceDate: home?.referenceDate ?? null,
    operationsReferenceDate: operations?.siteApiReferenceDate ?? null,
    identities: Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value?.dataIdentity ?? null])),
    ready: Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value?.publicationReady === true])),
  };
  const identities = Object.values(actual.identities);
  const expected = { referenceDate: expectedReferenceDate, snapshotHash: expectedSnapshotHash };
  const reason = [actual.topReferenceDate, actual.performanceReferenceDate, actual.homeReferenceDate, actual.operationsReferenceDate].some((date) => date !== expectedReferenceDate) ? "REFERENCE_DATE_NOT_DEPLOYED"
    : identities.some((identity) => !sameSnapshot(identity, expected)) ? "SNAPSHOT_HASH_MISMATCH"
    : identities.some((identity) => identity.commitSha !== expectedCommitSha) ? "SITE_COMMIT_MISMATCH"
    : Object.values(actual.ready).some((ready) => !ready) ? "SITE_SUMMARY_UNAVAILABLE" : null;
  return { matches: reason === null, actual, reason };
}

export async function waitForDailyProductionDeployment({ siteUrl, expectedReferenceDate, expectedSnapshotHash, expectedCommitSha, fetchImpl = fetch, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), maxAttempts = 36, delayMs = 20_000, now = () => new Date().toISOString() }) {
  let lastError = null, lastActual = null;
  const finish = (status, attemptCount, reason) => ({ status, expectedReferenceDate, expectedSnapshotHash, expectedCommitSha, attemptCount, checkedAt: now(), verifiedAt: status === "VERIFIED" ? now() : null, actual: lastActual, reason });
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const inspected = await inspectDailyProductionDeployment({ siteUrl, expectedReferenceDate, expectedSnapshotHash, expectedCommitSha, fetchImpl });
      lastActual = inspected.actual;
      if (inspected.matches) return finish("VERIFIED", attempt, null);
      lastError = inspected.reason;
      if (lastError === "EXPECTED_IDENTITY_MISSING") return finish("FAILED", attempt, lastError);
    } catch (error) {
      lastError = verificationErrorReason(error);
      if (["HTTP_401", "HTTP_403"].includes(lastError)) return finish("FAILED", attempt, lastError);
    }
    if (attempt < maxAttempts) await sleep(delayMs);
  }
  return finish("FAILED", maxAttempts, lastError ?? "DEPLOYMENT_VERIFICATION_TIMEOUT");
}
