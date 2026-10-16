// Synthetic fixtures only; never persisted as actual LIVE observations.
import { buildIntradayModelTopSignal } from "../../lib/intraday-model-top-official-signal.mjs";
import { sha256Canonical } from "../../lib/snapshot-quality-pipeline.mjs";
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
