import test from "node:test";
import assert from "node:assert/strict";
import { cloudVerificationDto, CLOUD_VERIFICATION, privateCloudVerificationResponse } from "../lib/private-cloud-verification.mjs";
function syntheticReceipt() {
  return { contentHash: CLOUD_VERIFICATION.sha256, value: { namespace: "cloud-kis-off-hours-diagnostic-v1", run: CLOUD_VERIFICATION.run,
    observationType: "OFF_HOURS_DIAGNOSTIC", symbols: 553, validQuotes: 553, modelsCalculated: 508, collectionSucceeded: true,
    calculationComplete: true, publicationEligible: false, eligibleForLive: false, operationalPointerChanged: false,
    rawPricesStored: false, sourcePricesIncluded: false, inputEvidence: { readiness: "READY", formulaHashesVerified: true, seedReferenceDate: "2026-10-16" },
    collectionFirstAt: Date.parse("2026-10-19T09:11:30.480Z"), collectionLastReceivedAt: Date.parse("2026-10-19T09:15:49.431Z"),
    top5: Object.fromEntries(["A-v1", "B-v1", "C-v1", "D-v1"].map(v => [v, Array.from({ length: 5 }, (_, i) => ({ ticker: String(i + 1).padStart(6, "0"), companyName: "SYNTHETIC", rank: i + 1, score: 90 - i }))])) } };
}
test("synthetic contract fixture: explicit off-hours DTO retains original timestamps, only twenty score fields", () => {
  const receipt = syntheticReceipt(); receipt.value.unapprovedField = { close: 100, credential: "not-propagated" };
  const dto = cloudVerificationDto(receipt);
  assert.equal(dto.status, "VERIFIED_OFF_HOURS"); assert.equal(dto.collectionStartedAt, "2026-10-19T09:11:30.480Z");
  assert.equal(dto.models.flatMap(m => m.records).length, 20); assert.equal(dto.publicationEligible, false);
  assert.equal(dto.operationalPointerChanged, false); assert.doesNotMatch(JSON.stringify(dto), /close|credential|not-propagated/u);
});
test("hash mismatch, partial set, non-diagnostic identity and live promotion fail closed", () => {
  for (const mutate of [r => r.contentHash = "0".repeat(64), r => r.value.modelsCalculated = 507,
    r => r.value.observationType = "LIVE_OBSERVATION", r => r.value.publicationEligible = true,
    r => r.value.top5["B-v1"].pop(), r => r.value.inputEvidence.formulaHashesVerified = false]) {
    const r = syntheticReceipt(); mutate(r); assert.throws(() => cloudVerificationDto(r), /CLOUD_RECEIPT_INVALID/u);
  }
});
test("read-only endpoint refuses queries before I/O, disabled config, authorization outage sanitized", async () => {
  const req = new Request("https://site.test/api/private-cloud-verification"), env = { PRIVATE_LIVE_DELIVERY_READ_ENABLED: "true",
    PRIVATE_LIVE_DELIVERY_REPOSITORY: "klkl789982-droid/tight-budget-private-data", PRIVATE_LIVE_DELIVERY_READ_TOKEN: "synthetic-reader" };
  assert.equal((await privateCloudVerificationResponse(req, { env: {} })).status, 404);
  assert.equal((await privateCloudVerificationResponse(new Request(req.url + "?path=arbitrary"), { env, fetchImpl() { throw new Error("must-not-call"); } })).status, 400);
  let calls = 0;
  const r = await privateCloudVerificationResponse(req, { env, async fetchImpl(url, init) {
    calls++; assert.equal(init.method, "GET"); assert.equal(init.cache, "no-store"); return Response.json({}, { status: 403 });
  } });
  assert.equal(r.status, 503); assert.equal(calls, 1); assert.equal(r.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(await r.json(), { error: "CLOUD_VERIFICATION_UNAVAILABLE" });
});
