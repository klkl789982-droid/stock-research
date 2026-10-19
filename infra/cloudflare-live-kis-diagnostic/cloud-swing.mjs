import { createPreparingForecast, validateForecastRecord, hashSwingContent } from "../../lib/forecast-swing-contract.mjs";
import { validateLiveDelivery } from "../../lib/private-live-delivery.mjs";
import { hashIntradayModelTop } from "../../lib/intraday-model-top-official-signal.mjs";
import { FORMULA_HASHES } from "./formula-manifest.mjs";

const files = { "A-v1": "lib/technical-strength.mjs", "B-v1": "lib/trend-strength.mjs", "C-v1": "lib/entry-strength.mjs", "D-v1": "lib/combined-technical-score.mjs" };
const blockers = ["MODEL_NOT_TRAINED", "INPUT_PROVENANCE_NOT_CERTIFIED", "EXECUTION_EVIDENCE_MISSING", "COST_MODEL_UNSPECIFIED", "REFERENCE_PRICE_NOT_RELAYED"];

// Preserve the existing five-session contract, not a new performance definition.
// Price transmission is NOT authorized by score-only delivery. A null reference
// price deliberately remains BLOCKED under the unchanged contract; never invent
// an entry price or weaken inputTimingEligible to make this ledger look ready.
export function buildCloudSwingIntent(evidence, delivery) {
  validateLiveDelivery(delivery, delivery.exportedAt);
  const { contentHash, ...body } = evidence;
  if (hashIntradayModelTop(body) !== contentHash || contentHash !== delivery.sourceHash
    || body.namespace !== "cloud-live-score-evidence-v1" || body.sourcePricesIncluded !== false) throw new Error("LIVE_CLOUD_SWING_SOURCE_INVALID");
  const createdAt = delivery.exportedAt, selected = new Map(), selections = [];
  for (const model of delivery.models) {
    const ranked = evidence.observations.filter(r => evidence.prepared.eligibleCodes.includes(r.code) && r.status === "AVAILABLE")
      .sort((a, b) => b.scores[model.modelVersion] - a.scores[model.modelVersion] || a.code.localeCompare(b.code)).slice(0, 5);
    if (ranked.length !== 5 || model.records.some((r, i) => r.ticker !== ranked[i].code || r.rank !== i + 1 || r.score !== ranked[i].scores[model.modelVersion])) throw new Error("LIVE_CLOUD_SWING_SELECTION_INVALID");
    for (const row of model.records) {
      const original = evidence.observations.find(r => r.code === row.ticker);
      if (!original || original.companyName !== row.companyName || original.status !== "AVAILABLE" || original.scores?.[model.modelVersion] !== row.score) throw new Error("LIVE_CLOUD_SWING_SELECTION_INVALID");
      const item = { ticker: row.ticker, modelVersion: model.modelVersion, rank: row.rank, score: row.score };
      selections.push(item); selected.set(row.ticker, [...(selected.get(row.ticker) ?? []), item]);
    }
  }
  const records = [...selected].sort(([a], [b]) => a.localeCompare(b)).map(([ticker, choices]) => {
    const original = evidence.observations.find(r => r.code === ticker);
    const provenance = { source: "cloud-live-score-evidence-v1", sourceHash: contentHash, availableAt: createdAt,
      receivedAt: createdAt, availabilityEvidence: "SYSTEM_OBSERVED", sourceArtifact: `cloud-live-score-evidence-v1/${delivery.signalDate}/${contentHash}.json` };
    return createPreparingForecast({ createdAt, observationPolicyId: "intraday-1400-v1",
      observation: { symbol: ticker, observedDate: delivery.signalDate, observedAt: new Date(`${original.observedDate}T${original.observedTime}+09:00`).toISOString(), referencePrice: null, provenance },
      inputs: choices.flatMap(c => [{ name: `observedScore:${c.modelVersion}`, value: c.score }, { name: `selectedRank:${c.modelVersion}`, value: c.rank }]
        .map(input => ({ ...input, ...provenance, observedAt: original.minuteReceivedAt, modelVersion: c.modelVersion,
          formulaHash: FORMULA_HASHES[files[c.modelVersion]], seedHash: evidence.prepared.seedHash }))), blockers });
  });
  if (selections.length !== 20 || records.some(r => !validateForecastRecord(r).valid || r.observation.referencePrice !== null)) throw new Error("LIVE_CLOUD_SWING_CONTRACT_INVALID");
  const intent = { schemaVersion: 1, namespace: "cloud-live-swing-intent-v1", policy: "abcd-v1-top5-union-1400-v1", createdAt,
    sourceHash: contentHash, signalDate: delivery.signalDate, selections, records, sourcePricesIncluded: false, outcomeReady: false };
  return { ...intent, intentHash: hashSwingContent(intent) };
}

export async function persistCloudSwingIntent(store, intent) {
  const { intentHash, ...body } = intent;
  if (hashSwingContent(body) !== intentHash || body.namespace !== "cloud-live-swing-intent-v1" || body.sourcePricesIncluded !== false
    || body.outcomeReady !== false || body.selections.length !== 20 || body.records.some(r => !validateForecastRecord(r).valid || r.createdAt !== body.createdAt || r.observation.referencePrice !== null)) throw new Error("LIVE_CLOUD_SWING_CONTRACT_INVALID");
  const key = `cloud-live-swing-intent-v1/${body.signalDate}/${intentHash}.json`;
  await store.writeImmutable(key, intent);
  const reread = (await store.read(key))?.value;
  if (hashSwingContent(reread) !== hashSwingContent(intent)) throw new Error("LIVE_CLOUD_SWING_READBACK_FAILED");
  return { status: "SWING_INTENT_PRESERVED", intentHash, selectionCount: body.selections.length, uniqueTickerCount: body.records.length, outcomeReady: false };
}
