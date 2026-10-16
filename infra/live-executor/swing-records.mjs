import { createLocalExecutionStore } from "./store.mjs";
import { appendSwingPreparation, isSavedSwingObservation, prepareSwingRecordFromSignal, readSwingLedger } from "../../lib/forecast-swing-store.mjs";
import { validateForecastRecord } from "../../lib/forecast-swing-contract.mjs";

export const SWING_SELECTION_POLICY = "abcd-v1-top5-union-1400-v1";

/** Runs only after durable LIVE success. No collection, ranking, or publication.
 * An immutable intent pins first issuance before any ledger entry is installed.
 * Resuming later cannot extend the original five-session horizon.
 */
export async function recordTop5SwingBatch({ stateDir, signal, now = () => new Date().toISOString(), repositoryRoot = process.cwd() }) {
  if (!isSavedSwingObservation(signal)) throw new Error("SWING_CURRENT_LIVE_REQUIRED");
  const store = createLocalExecutionStore(stateDir, { repositoryRoot });
  return store.withLock("swing-top5", async () => {
    const key = `live/swing/${signal.signalDate}/${signal.contentHash}.json`;
    let intent = await store.read(key);
    if (!intent) {
      const selected = new Map(), selections = [];
      for (const version of ["A-v1", "B-v1", "C-v1", "D-v1"]) {
        const top = signal.top5[version];
        if (!Array.isArray(top) || top.length !== Math.min(5, signal.collection.successful)) throw new Error("SWING_TOP5_INVALID");
        for (const item of top) {
          const row = signal.records.find(record => record.ticker === item.ticker && record.dataStatus === "AVAILABLE");
          if (!row || row.ranks[version] !== item.rank || row.scores[version] !== item.score) throw new Error("SWING_TOP5_INVALID");
          selected.set(row, [...(selected.get(row) ?? []), version]);
          selections.push({ ticker: row.ticker, modelVersion: version, rank: item.rank, score: item.score });
        }
      }
      const createdAt = now();
      intent = { schemaVersion: 1, policy: SWING_SELECTION_POLICY, signalDate: signal.signalDate, signalHash: signal.contentHash, createdAt, selections,
        records: [...selected].map(([row, selectedVersions]) => prepareSwingRecordFromSignal({ signal, row, createdAt, selectedVersions })) };
      await store.writeImmutable(key, intent);
    }
    if (intent.policy !== SWING_SELECTION_POLICY || intent.signalHash !== signal.contentHash
      || !intent.records.every(record => validateForecastRecord(record).valid && record.createdAt === intent.createdAt)) throw new Error("SWING_INTENT_INVALID");
    for (const record of intent.records) await appendSwingPreparation({ root: stateDir, record });
    const readback = await readSwingLedger({ root: stateDir });
    if (!intent.records.every(record => readback.records.some(saved => saved.forecastHash === record.forecastHash))) throw new Error("SWING_READBACK_FAILED");
    return { status: "RECORDED", policy: intent.policy, signalHash: intent.signalHash, createdAt: intent.createdAt,
      selectionCount: intent.selections.length, uniqueTickerCount: intent.records.length, predictionCreated: false };
  });
}
