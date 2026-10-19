import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { retainedCloudVerification } from "./readiness-evidence.mjs";

test("separate later actual553/508 success does not overwrite the old507 failure or certify real14:00/homepage operation", async () => {
  const original = JSON.parse(await fs.readFile(new URL("./actual-evidence.json", import.meta.url), "utf8"));
  const followup = JSON.parse(await fs.readFile(new URL("./operational-followup-20261019.json", import.meta.url), "utf8"));
  const result = retainedCloudVerification(original, followup);
  assert.equal(result.laterActualFull, true); assert.equal(result.full.completeModels, 508);
  assert.equal(original.actualFullUniverseBenchmark.completeModels, 507);
  assert.equal(result.normalCloudAuthenticatedSiteVerified, false);
  assert.equal(result.swingRecordingCompatible, true);
});

test("a synthetic, partial or tampered full-trial claim cannot close the actual-collection gate", () => {
  const candidate = { observationType: "OFF_HOURS_DIAGNOSTIC", syntheticOnly: false, processedSymbols: 553, validQuotes: 553,
    completeModels: 508, requiredEligibleModels: 508, collectionSucceeded: true, calculationComplete: true,
    absolute1400WindowVerified: false, operationalPointerChanged: false, evidenceHash: "a".repeat(64), scoresHash: "b".repeat(64) };
  const original = { actualFullUniverseBenchmark: { requiredEligibleModels: 508 } };
  assert.equal(retainedCloudVerification(original, { realCloudBenchmark: candidate }).laterActualFull, true);
  for (const change of [{ syntheticOnly: true }, { processedSymbols: 552 }, { completeModels: 507 }, { completeModels: 507, requiredEligibleModels: 507 }, { evidenceHash: "bad" }, { absolute1400WindowVerified: true }]) {
    assert.equal(retainedCloudVerification(original, { realCloudBenchmark: { ...candidate, ...change } }).laterActualFull, false);
  }
});
