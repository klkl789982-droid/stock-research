import { aggregateProduction } from "./production-core.mjs";
import { persistCloudSwingIntent } from "./cloud-swing.mjs";
import { hashSwingContent, resolveSwingOutcome, validateForecastRecord } from "../../lib/forecast-swing-contract.mjs";

// Fixed SYNTHETIC metadata only. These are not model calculations, quotes or a
// historical LIVE observation. Every remote key is confined to the test tree.
export function syntheticProductionInputs({ date = "2000-01-03", seedDate = "1999-12-30" } = {}) {
  const at = `${date}T05:00:01.000Z`;
  const codes = Array.from({ length: 553 }, (_, i) => String(900000 + i));
  const prepared = { targetDate: date, seedReferenceDate: seedDate, readiness: "READY", universe: 553, eligible: 508,
    codes, eligibleCodes: codes.slice(0, 508), seedHash: "a".repeat(64) };
  const rows = codes.map((code, i) => ({ code, companyName: `SYNTHETIC-NOT-A-STOCK-${i}`, status: i < 508 ? "AVAILABLE" : "EXCLUDED",
    scores: i < 508 ? Object.fromEntries(["A-v1", "B-v1", "C-v1", "D-v1"].map((v, j) => [v, ((i + j * 31) % 101)])) : null,
    observedDate: date, observedTime: "14:00:01", quoteRequestedAt: at, quoteReceivedAt: at, minuteRequestedAt: at, minuteReceivedAt: at,
    originalRecordHash: "b".repeat(64), responseHash: "c".repeat(64), rawPricesStored: false, modelFormulaUnchanged: true }));
  return { date, prepared, rows };
}
export function cloudSwingFixture() {
  const { date, prepared, rows } = syntheticProductionInputs();
  return aggregateProduction(prepared, rows, `${date}T05:05:01.000Z`).swing;
}

export async function verifyCloudSwingFixture(store, run, phase) {
  if (!/^[A-Za-z0-9_-]{1,48}$/u.test(run ?? "") || !["create", "read"].includes(phase)) throw new Error("DIAG_SWING_FIXTURE_INVALID");
  const intent = cloudSwingFixture(), prefix = `cloud-isolated-tests/swing/${run}`;
  const mapped = key => {
    if (!key.startsWith("cloud-live-swing-intent-v1/")) throw new Error("DIAG_SWING_TEST_PATH_ONLY");
    return `${prefix}/${key}`;
  };
  const isolated = { writeImmutable: (key, value) => store.writeImmutable(mapped(key), { observationType: "SYNTHETIC_FIXTURE", publicationEligible: false, intent: value }),
    async read(key) { const row = await store.read(mapped(key)); return row ? { value: row.value?.intent } : null; } };
  if (phase === "create") {
    await persistCloudSwingIntent(isolated, intent);
    await persistCloudSwingIntent(isolated, intent);
    const key = `cloud-live-swing-intent-v1/${intent.signalDate}/${intent.intentHash}.json`;
    let conflictBlocked = false;
    try { await isolated.writeImmutable(key, { ...intent, createdAt: "DIFFERENT_SYNTHETIC_VALUE" }); }
    catch (e) { if (e.code !== "PRIVATE_STORE_IMMUTABLE_CONFLICT") throw e; conflictBlocked = true; }
    if (!conflictBlocked) throw new Error("DIAG_SWING_CONFLICT_NOT_BLOCKED");
  }
  const stored = await isolated.read(`cloud-live-swing-intent-v1/${intent.signalDate}/${intent.intentHash}.json`);
  if (!stored?.value || hashSwingContent(stored.value) !== hashSwingContent(intent)) throw new Error("DIAG_SWING_READBACK_FAILED");
  const records = stored.value.records;
  const outcomes = records.map(forecast => resolveSwingOutcome({ forecast, resolvedAt: "2000-01-04T05:05:01.000Z" }));
  if (records.some(r => !validateForecastRecord(r).valid || r.createdAt !== intent.createdAt || r.horizonTradingDays !== 5
    || r.entryPolicy !== "NEXT_CONFIRMED_SESSION_OPEN_STRICTLY_AFTER_ISSUANCE" || r.exitPolicy !== "FIFTH_SESSION_CLOSE_INCLUDING_ENTRY")
    || outcomes.some(o => o.status !== "BLOCKED" || o.netReturn !== null || o.grossReturn !== null)) throw new Error("DIAG_SWING_EVALUATION_CONTRACT_CHANGED");
  return { status: "CLOUD_SYNTHETIC_SWING_VERIFIED", phase, syntheticOnly: true, intentHash: intent.intentHash,
    createdAt: intent.createdAt, selections: intent.selections.length, records: records.length, firstIssuancePreserved: true,
    sha256ReadbackVerified: true, duplicateAndConflictChecked: phase === "create", existingFiveSessionResolver: "BLOCKED_MISSING_REFERENCE_PRICE",
    sourcePricesIncluded: false, kisCalls: 0, operationalPointerChanged: false, publicationEligible: false };
}
