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
export function buildCloudSwingIntent(evidence, delivery, createdAt = delivery.exportedAt) {
  validateLiveDelivery(delivery, delivery.exportedAt);
  if (typeof createdAt !== "string" || !Number.isFinite(Date.parse(createdAt)) || new Date(createdAt).toISOString() !== createdAt || createdAt < delivery.exportedAt)
    throw new Error("LIVE_CLOUD_SWING_ISSUANCE_INVALID");
  if (delivery.publication && delivery.publication.status !== "COMPLETE" || evidence.coverage && evidence.coverage.status !== "COMPLETE")
    throw new Error("LIVE_CLOUD_SWING_REQUIRES_COMPLETE");
  const { contentHash, ...body } = evidence;
  if (hashIntradayModelTop(body) !== contentHash || contentHash !== delivery.sourceHash
    || body.namespace !== "cloud-live-score-evidence-v1" || body.sourcePricesIncluded !== false) throw new Error("LIVE_CLOUD_SWING_SOURCE_INVALID");
  const eligible = new Set(body.prepared.eligibleCodes);
  const available = body.observations.filter(row => eligible.has(row.code) && row.status === "AVAILABLE");
  if (eligible.size !== body.prepared.eligible || available.length !== eligible.size || new Set(available.map(row => row.code)).size !== eligible.size
    || delivery.publication && (body.coverage?.universeHash !== delivery.publication.universeHash || delivery.publication.validCount !== eligible.size))
    throw new Error("LIVE_CLOUD_SWING_REQUIRES_COMPLETE");
  const livePublication = delivery.publication && { status: "COMPLETE", revision: delivery.publication.revision, deliveryHash: delivery.deliveryHash };
  const selected = new Map(), selections = [];
  for (const model of delivery.models) {
    const ranked = [...available]
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
      observation: { symbol: ticker, observedDate: delivery.signalDate, observedAt: new Date(`${original.observedDate}T${original.observedTime}+09:00`).toISOString(),
        referencePrice: null, provenance: livePublication ? { ...provenance, metadata: { livePublication } } : provenance },
      inputs: choices.flatMap(c => [{ name: `observedScore:${c.modelVersion}`, value: c.score }, { name: `selectedRank:${c.modelVersion}`, value: c.rank }]
        .map(input => ({ ...input, ...provenance, observedAt: original.minuteReceivedAt, modelVersion: c.modelVersion,
          formulaHash: FORMULA_HASHES[files[c.modelVersion]], seedHash: evidence.prepared.seedHash }))), blockers });
  });
  if (selections.length !== 20 || records.some(r => !validateForecastRecord(r).valid || r.observation.referencePrice !== null)) throw new Error("LIVE_CLOUD_SWING_CONTRACT_INVALID");
  const intent = { schemaVersion: 1, namespace: "cloud-live-swing-intent-v1", policy: "abcd-v1-top5-union-1400-v1", createdAt,
    sourceHash: contentHash, signalDate: delivery.signalDate, ...(livePublication ? { livePublication } : {}),
    selections, records, sourcePricesIncluded: false, outcomeReady: false };
  return { ...intent, intentHash: hashSwingContent(intent) };
}

export async function persistCloudSwingIntent(store, intent) {
  const { intentHash, ...body } = intent;
  if (hashSwingContent(body) !== intentHash || body.namespace !== "cloud-live-swing-intent-v1" || body.sourcePricesIncluded !== false
    || body.livePublication && body.livePublication.status !== "COMPLETE"
    || body.outcomeReady !== false || body.selections.length !== 20 || body.records.some(r => !validateForecastRecord(r).valid || r.createdAt !== body.createdAt
      || r.observation.referencePrice !== null || hashSwingContent(r.observation.provenance.metadata?.livePublication ?? null) !== hashSwingContent(body.livePublication ?? null)))
    throw new Error("LIVE_CLOUD_SWING_CONTRACT_INVALID");
  const key = `cloud-live-swing-intent-v1/${body.signalDate}/${intentHash}.json`;
  await store.writeImmutable(key, intent);
  const reread = (await store.read(key))?.value;
  if (hashSwingContent(reread) !== hashSwingContent(intent)) throw new Error("LIVE_CLOUD_SWING_READBACK_FAILED");
  return { status: "SWING_INTENT_PRESERVED", intentHash, selectionCount: body.selections.length, uniqueTickerCount: body.records.length, outcomeReady: false };
}
