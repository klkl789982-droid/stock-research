const trimSlash = (value) => value.replace(/\/+$/u, "");

export async function inspectLiveProductionDeployment({ siteUrl, expectedSignalDate, fetchImpl = fetch, automationToken = process.env.TB_AUTOMATION_READ_TOKEN }) {
  const result = await readJson(fetchImpl, `${trimSlash(siteUrl)}/api/intraday-model-top?model=B&limit=1`, automationToken);
  return result?.signalDate === expectedSignalDate && result?.observationType === "LIVE_OBSERVATION" && Number.isFinite(Date.parse(result?.collectionCompletedAt));
}

async function readJson(fetchImpl, url, token) {
  const response = await fetchImpl(url, { headers: { Accept: "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`HTTP_${response.status}`);
  const contentType = response.headers?.get?.("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) throw new Error("NON_JSON_RESPONSE");
  return response.json();
}

export async function inspectDailyProductionDeployment({ siteUrl, expectedReferenceDate, fetchImpl = fetch, automationToken = process.env.TB_AUTOMATION_READ_TOKEN }) {
  const base = trimSlash(siteUrl);
  const [top, performance, operations] = await Promise.all([
    readJson(fetchImpl, `${base}/api/top-stocks?model=A&limit=1`, automationToken),
    readJson(fetchImpl, `${base}/api/model-performance`, automationToken),
    readJson(fetchImpl, `${base}/api/daily-production-status`, automationToken),
  ]);
  const actual = {
    topReferenceDate: top?.rankingAsOfDate ?? null,
    topFreshness: top?.freshness?.freshnessStatus ?? null,
    performanceReferenceDate: performance?.latestEodReferenceDate ?? null,
    operationsReferenceDate: operations?.siteApiReferenceDate ?? null,
    publicationStatus: operations?.publicationStatus ?? null,
  };
  const matches = actual.topReferenceDate === expectedReferenceDate
    && actual.performanceReferenceDate === expectedReferenceDate
    && actual.operationsReferenceDate === expectedReferenceDate
    && ["published", "unchanged", "lastGoodPreserved"].includes(actual.publicationStatus);
  return { matches, actual };
}

export async function waitForDailyProductionDeployment({ siteUrl, expectedReferenceDate, fetchImpl = fetch, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), maxAttempts = 36, delayMs = 20_000, now = () => new Date().toISOString() }) {
  let lastError = null;
  let lastActual = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const inspected = await inspectDailyProductionDeployment({ siteUrl, expectedReferenceDate, fetchImpl });
      lastActual = inspected.actual;
      if (inspected.matches) return { status: "VERIFIED", expectedReferenceDate, attemptCount: attempt, verifiedAt: now(), actual: inspected.actual, reason: null };
      lastError = "REFERENCE_DATE_NOT_DEPLOYED";
    } catch (error) {
      lastError = error instanceof Error ? error.message.slice(0, 120) : "UNKNOWN_DEPLOYMENT_ERROR";
      if (["HTTP_401", "HTTP_403"].includes(lastError)) return { status: "FAILED", expectedReferenceDate, attemptCount: attempt, verifiedAt: now(), actual: lastActual, reason: lastError };
    }
    if (attempt < maxAttempts) await sleep(delayMs);
  }
  return { status: "FAILED", expectedReferenceDate, attemptCount: maxAttempts, verifiedAt: now(), actual: lastActual, reason: lastError ?? "DEPLOYMENT_VERIFICATION_TIMEOUT" };
}
