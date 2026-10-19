import { createKisEodPrivateStore } from "./kis-eod-private-store.mjs";

// A pinned, read-only receipt. Never consult or mutate operational LIVE heads.
export const CLOUD_VERIFICATION = Object.freeze({
  key: "cloud-isolated-tests/reports/actual553-20261019j.json",
  run: "actual553-20261019j",
  sha256: "a77d942b35162df7fc83ffbb594ac8f3eae91d0ea24257aeca53a35be641ee9f",
});
const versions = ["A-v1", "B-v1", "C-v1", "D-v1"];
export function cloudVerificationDto(stored) {
  const v = stored?.value;
  if (stored?.contentHash !== CLOUD_VERIFICATION.sha256 || v?.run !== CLOUD_VERIFICATION.run
    || v.namespace !== "cloud-kis-off-hours-diagnostic-v1" || v.observationType !== "OFF_HOURS_DIAGNOSTIC"
    || v.symbols !== 553 || v.validQuotes !== 553 || v.modelsCalculated !== 508
    || v.collectionSucceeded !== true || v.calculationComplete !== true
    || v.publicationEligible !== false || v.eligibleForLive !== false || v.operationalPointerChanged !== false
    || v.rawPricesStored !== false || v.sourcePricesIncluded !== false
    || v.inputEvidence?.readiness !== "READY" || v.inputEvidence?.formulaHashesVerified !== true
    || !Number.isFinite(v.collectionFirstAt) || !Number.isFinite(v.collectionLastReceivedAt)
    || v.collectionFirstAt > v.collectionLastReceivedAt) throw new Error("CLOUD_RECEIPT_INVALID");
  const models = versions.map((version, i) => {
    const rows = v.top5?.[version];
    if (!Array.isArray(rows) || rows.length !== 5 || new Set(rows.map(r => r.ticker)).size !== 5
      || rows.some((r, j) => !/^[0-9A-Z]{6}$/u.test(r.ticker) || typeof r.companyName !== "string"
        || r.companyName.length > 120 || r.rank !== j + 1 || !Number.isFinite(r.score) || r.score < 0 || r.score > 100)) throw new Error("CLOUD_RECEIPT_INVALID");
    return { model: "ABCD"[i], modelVersion: version,
      records: rows.map(({ ticker, companyName, rank, score }) => ({ ticker, companyName, rank, score })) };
  });
  return { status: "VERIFIED_OFF_HOURS", observationType: v.observationType, run: v.run,
    sha256: stored.contentHash, hashVerified: true, universe: 553, calculated: 508,
    collectionStartedAt: new Date(v.collectionFirstAt).toISOString(),
    collectionCompletedAt: new Date(v.collectionLastReceivedAt).toISOString(),
    seedReferenceDate: v.inputEvidence.seedReferenceDate, models,
    publicationEligible: false, operationalPointerChanged: false, sourcePricesIncluded: false };
}

// Call ONLY behind withAdminAccess. The existing distinct Vercel reader token
// is reused; no writer credentials, arbitrary path/query or write probe here.
export async function privateCloudVerificationResponse(request, { env = process.env, fetchImpl = fetch } = {}) {
  const response = (status, body) => Response.json(body, { status, headers: { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
  if (env.PRIVATE_LIVE_DELIVERY_READ_ENABLED !== "true") return response(404, { error: "NOT_FOUND" });
  if (request.method !== "GET" || new URL(request.url).search) return response(400, { error: "INVALID_QUERY" });
  try {
    const store = createKisEodPrivateStore({ repository: env.PRIVATE_LIVE_DELIVERY_REPOSITORY,
      token: env.PRIVATE_LIVE_DELIVERY_READ_TOKEN, fetchImpl });
    return response(200, cloudVerificationDto(await store.read(CLOUD_VERIFICATION.key)));
  } catch { return response(503, { error: "CLOUD_VERIFICATION_UNAVAILABLE" }); }
}
