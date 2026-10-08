const trimSlash = (value) => value.replace(/\/+$/u, "");

async function readJson(fetchImpl, url) {
  const response = await fetchImpl(url, { headers: { Accept: "application/json" }, cache: "no-store" });
  if (!response.ok) throw new Error(`HTTP_${response.status}`);
  const contentType = response.headers?.get?.("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) throw new Error("NON_JSON_RESPONSE");
  return response.json();
}

export async function inspectDailyProductionDeployment({ siteUrl, expectedReferenceDate, fetchImpl = fetch }) {
  const base = trimSlash(siteUrl);
  const [top, performance, operations] = await Promise.all([
    readJson(fetchImpl, `${base}/api/top-stocks?model=A&limit=1`),
    readJson(fetchImpl, `${base}/api/model-performance`),
    readJson(fetchImpl, `${base}/api/daily-production-status`),
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
    && actual.publicationStatus === "published";
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
    }
    if (attempt < maxAttempts) await sleep(delayMs);
  }
  return { status: "FAILED", expectedReferenceDate, attemptCount: maxAttempts, verifiedAt: now(), actual: lastActual, reason: lastError ?? "DEPLOYMENT_VERIFICATION_TIMEOUT" };
}
