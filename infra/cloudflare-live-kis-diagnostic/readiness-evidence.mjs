const digest = value => /^[a-f0-9]{64}$/u.test(value ?? "");

// Preserve the original failed benchmark. A separate later actual trial may
// establish full collection, but never upgrades it to a14:00/homepage proof.
export function retainedCloudVerification(original, followup) {
  const candidate = followup?.realCloudBenchmark;
  const required = original?.actualFullUniverseBenchmark?.requiredEligibleModels;
  const laterActualFull = candidate?.observationType === "OFF_HOURS_DIAGNOSTIC" && candidate.syntheticOnly === false
    && candidate.processedSymbols === 553 && candidate.validQuotes === 553
    && Number.isSafeInteger(required) && required >= 5 && candidate.requiredEligibleModels === required
    && candidate.completeModels === required
    && candidate.collectionSucceeded === true && candidate.calculationComplete === true
    && candidate.absolute1400WindowVerified === false && candidate.operationalPointerChanged === false
    && digest(candidate.evidenceHash) && digest(candidate.scoresHash);
  const full = laterActualFull ? candidate : original?.actualFullUniverseBenchmark;
  const native = followup?.nativeProductionFixture;
  const swingRecordingCompatible = native?.status === "complete" && native.syntheticOnly === true && native.kisCalls === 0
    && native.universe === 553 && native.eligible === 508 && native.top5Rows === 20
    && digest(native.deliveryHash) && digest(native.swingHash) && native.operationalPointerChanged === false
    && native.entryPolicy === "NEXT_CONFIRMED_SESSION_OPEN_STRICTLY_AFTER_ISSUANCE"
    && native.exitPolicy === "FIFTH_SESSION_CLOSE_INCLUDING_ENTRY" && native.existingResolver === "BLOCKED_MISSING_REFERENCE_PRICE";
  return { full, laterActualFull: Boolean(laterActualFull), swingRecordingCompatible: Boolean(swingRecordingCompatible),
    // This must come from normal real source-to-site evidence, not the above
    // trial, the PC's retained replay or a native synthetic fixture.
    normalCloudAuthenticatedSiteVerified: original?.verification?.normalProductionRelayAndAuthenticatedHomeReadbackFromCloud === "PASS" };
}
