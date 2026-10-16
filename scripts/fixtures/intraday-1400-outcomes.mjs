// Synthetic in-memory receipts only. These fixtures are never persisted as LIVE data.
import { buildIntradayModelTopSignal } from "../../lib/intraday-model-top-official-signal.mjs";
import { hashIntradayEvidencePayload, resolveIntradayModelTopOutcomes } from "../../lib/intraday-model-top-outcome-resolver.mjs";
import { sha256Canonical } from "../../lib/snapshot-quality-pipeline.mjs";

export const fixtureDates = ["2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09", "2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16"];
export const fixtureCalendar = (through = fixtureDates.length) => ({ dates: Object.fromEntries(fixtureDates.slice(0, through).map((date) => [date, { status: "tradingDay" }])) });
export const rehash = (value) => { const body = { ...value }; delete body.contentHash; return { ...body, contentHash: sha256Canonical(body) }; };
export const receipt = (sourceHash, availableAt) => ({ source: "SYNTHETIC_TEST_FIXTURE", sourceHash, availableAt, observedAt: availableAt, availabilityEvidence: "SYSTEM_OBSERVED" });
export function priceLedger(date, openPrice = 100, closePrice = 107) {
  const body = { schemaVersion: 3, date, source: "SYNTHETIC_TEST_FIXTURE", records: [{ code: "000001", date, openPrice, closePrice, executable: true }] };
  const contentHash = hashIntradayEvidencePayload(body);
  return { ...body, contentHash, availability: receipt(contentHash, `${date}T08:00:00Z`) };
}
export function executionProof(entryDate, exitDate) {
  const body = { status: "CONFIRMED", ticker: "000001", entryDate, exitDate, entryExecutable: true, exitExecutable: true, adjustmentBasis: "UNADJUSTED_NO_CORPORATE_ACTIONS" };
  const contentHash = hashIntradayEvidencePayload(body);
  return { ...body, contentHash, availability: receipt(contentHash, `${exitDate}T08:00:00Z`) };
}
export function currentSignal(count = 1) {
  const rows = Array.from({ length: 260 }, (_, index) => {
    const date = new Date("2026-10-02T00:00:00Z"); date.setUTCDate(date.getUTCDate() - index);
    return [date.toISOString().slice(0, 10).replaceAll("-", ""), 100 + index / 10, 102 + index / 10, 98 + index / 10, 100 + index / 10, 1000 + index];
  });
  const normalizedInputHash = sha256Canonical({ fixture: "daily-prices" });
  const seed = { requestedDate: "2026-10-02", generatedAt: "2026-10-06T03:00:00Z", contentHash: sha256Canonical({ fixture: "seed" }),
    sourceManifest: { modelFormulaHashes: Object.fromEntries(["A", "B", "C", "D"].map((model) => [`${model}-v1`, sha256Canonical({ model })])), sources: { officialDailyPrice: { normalizedInputHash, availability: { requestedAt: "2026-10-06T02:59:00Z", observedAt: "2026-10-06T02:59:30Z", availabilityStatus: "OBSERVED", availabilityEvidence: "SYSTEM_OBSERVED_BATCH_COLLECTION", outcome: "success", referenceDate: "2026-10-02", normalizedInputHash } } } },
    records: Array.from({ length: count }, (_, i) => ({ code: String(i + 1).padStart(6, "0"), name: `종목 ${i + 1}`, market: "KOSPI", eligible: true, rows })) };
  const quote = { code: "000001", source: "SYNTHETIC_TEST_FIXTURE", asOfDate: "2026-10-06", asOfTime: "14:00:10", receivedAt: "2026-10-06T05:00:11Z", open: 99, high: 102, low: 98, price: 100, volume: 1000, change: 1, rate: 1 };
  return buildIntradayModelTopSignal({ seed, quotesByCode: new Map(seed.records.map(row => [row.code, { ...quote, code: row.code }])), signalDate: "2026-10-06", collectionStartedAt: "2026-10-06T05:00:00Z", collectionCompletedAt: "2026-10-06T05:01:00Z" });
}
export function currentOutcomeInput() {
  const signal = currentSignal();
  return { signal, signalAvailability: receipt(signal.contentHash, "2026-10-06T05:02:00Z"), priceLedgers: fixtureDates.map((date) => priceLedger(date)), tradingCalendar: fixtureCalendar(), resolvedAt: "2026-10-16T12:00:00Z", executionEvidence: [executionProof("2026-10-07", "2026-10-07"), executionProof("2026-10-07", "2026-10-13")] };
}
export const currentOutcome = () => resolveIntradayModelTopOutcomes(currentOutcomeInput());
export function legacyOutcomeFixture(value = currentOutcome()) {
  // This constructs a separate synthetic archive fixture, never converts a stored artifact.
  return rehash({ ...structuredClone(value), schemaVersion: 1, layer: "INTRADAY_1430_LIVE", signalTime: "14:30:00", executionPolicy: { ...value.executionPolicy, policyId: "intraday-1430-t1-open-v1" } });
}
