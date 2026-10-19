import { buildIntradayModelTopSignal, validateIntradayModelTopSignal, hashIntradayModelTop as hash } from "../../lib/intraday-model-top-official-signal.mjs";
import { parseKisQuote, attachKisMinuteObservation } from "../../lib/kis-quote-provider-core.mjs";
import { createLiveDelivery, validateLiveDelivery } from "../../lib/private-live-delivery.mjs";
import { kst } from "./core.mjs";
import { buildCloudSwingIntent } from "./cloud-swing.mjs";
export { kst } from "./core.mjs";

export const LIVE_CRONS = Object.freeze(["40,50 4 * * MON-FRI", "6,8,10 5 * * MON-FRI"]);
export const PRODUCTION_BUDGET = Object.freeze({ workflowSteps: 220, workerRequests: 2000, doRequests: 14000,
  durationGbSeconds: 8500, sqlRowsRead: 1000000, sqlRowsWritten: 40000, retainedBytesPerDay: 2000000,
  workflowStorageGbMonths: 0.01, marketCalls: 1400 });
export const OTHER_DAILY_RESERVE = Object.freeze({ workflowSteps: 100, workerRequests: 2000, doRequests: 1000,
  durationGbSeconds: 1000, sqlRowsRead: 500000, sqlRowsWritten: 15000 });
export const versions = Object.freeze(["A-v1", "B-v1", "C-v1", "D-v1"]);
export const bounds = date => ({ start: Date.parse(`${date}T14:00:00+09:00`), end: Date.parse(`${date}T14:05:00+09:00`) });
export function assertProduction(env) {
  if (env.LIVE_PRODUCTION_ENABLED !== "true" || env.LIVE_PRODUCER !== "cloud"
    || !/^[a-f0-9]{64}$/u.test(env.LIVE_CUTOVER_RECEIPT_HASH ?? "")) throw new Error("LIVE_CLOUD_DISABLED");
}
export function activationConfig(base, proof, now = Date.now()) {
  const checked = checkCutover(proof, now);
  return { ...base, vars: { ...base.vars, LIVE_PRODUCTION_ENABLED: "true", LIVE_PRODUCER: "cloud", LIVE_CUTOVER_RECEIPT_HASH: checked.proofHash },
    triggers: { crons: [...LIVE_CRONS] } };
}
export function assertWindow(date, now) {
  const b = bounds(date);
  if (!Number.isFinite(b.start) || kst(now).date !== date || now < b.start || now > b.end) throw new Error("LIVE_CLOUD_WINDOW_EXPIRED");
}
export function checkCutover(proof, now = Date.now()) {
  const required = ["workersFree", "accountUsageVerifiedAfterReset", "otherResourcesInventoried", "storageVerified", "retentionVerified",
    "pcTaskDisabled", "pcHostStopped", "oldLiveTriggersDisabled", "fullEligibleSetVerified", "privateRelayVerified", "authenticatedSiteVerified", "swingRecordingVerified"];
  const missing = required.filter(k => proof?.[k] !== true);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(proof?.utcDay ?? "") || proof.utcDay !== new Date(now).toISOString().slice(0, 10)
    || !Number.isFinite(Date.parse(proof?.checkedAt)) || now < Date.parse(proof.checkedAt) || now - Date.parse(proof.checkedAt) > 900000) missing.push("freshCutoverProof");
  if (missing.length) throw new Error(`LIVE_CUTOVER_BLOCKED_${missing.join("_")}`);
  return { owner: "cloud", checkedAt: proof.checkedAt, proofHash: hash(proof) };
}

// Existing full signal builder + validator applied to one original seed record
// in RAM. No alternative formula, rounding, quote quality rule or raw storage.
export function productionObservation({ quote, minute, code, timing, input, seedContext, signalDate }) {
  const b = bounds(signalDate), stamps = [timing.quoteRequestedAt, timing.quoteReceivedAt, timing.minuteRequestedAt, timing.minuteReceivedAt].map(Date.parse);
  if (stamps.some(x => !Number.isFinite(x) || x < b.start || x > b.end) || stamps[0] > stamps[1] || stamps[1] > stamps[2] || stamps[2] > stamps[3]) throw new Error("LIVE_CLOUD_OBSERVATION_WINDOW");
  let q = parseKisQuote(quote, code, timing.quoteReceivedAt);
  if (q.asOfDate && q.asOfDate !== signalDate) throw new Error("LIVE_CLOUD_QUOTE_DATE");
  q = attachKisMinuteObservation(q, minute, { requestedDate: signalDate, requestedTime: kst(stamps[0]).time });
  if (!input.eligible) return { code, companyName: input.name, status: "EXCLUDED", scores: null, ...timing,
    observedDate: q.asOfDate, observedTime: q.asOfTime, responseHash: hash({ quote, minute }), rawPricesStored: false, modelFormulaUnchanged: true };
  const signal = buildIntradayModelTopSignal({ seed: { ...seedContext, records: [input] }, quotesByCode: new Map([[code, q]]), signalDate,
    collectionStartedAt: timing.quoteRequestedAt, collectionCompletedAt: timing.minuteReceivedAt });
  if (validateIntradayModelTopSignal(signal).length || signal.status !== "READY") throw new Error("LIVE_CLOUD_INPUT_REJECTED");
  const row = signal.records[0];
  return { code, companyName: input.name, status: input.eligible ? "AVAILABLE" : "EXCLUDED", scores: row.scores,
    ...timing, observedDate: q.asOfDate, observedTime: q.asOfTime, responseHash: hash({ quote, minute }),
    originalRecordHash: hash(row), rawPricesStored: false, modelFormulaUnchanged: true };
}

export function aggregateProduction(prepared, observations, exportedAt) {
  if (prepared?.readiness !== "READY" || prepared.universe !== 553 || !Array.isArray(prepared.codes)
    || prepared.codes.length !== 553 || new Set(prepared.codes).size !== 553 || !Array.isArray(prepared.eligibleCodes)
    || prepared.eligibleCodes.length !== prepared.eligible || new Set(prepared.eligibleCodes).size !== prepared.eligible
    || prepared.eligibleCodes.some(c => !prepared.codes.includes(c)) || observations.length !== 553) throw new Error("LIVE_CLOUD_INCOMPLETE");
  const map = new Map(observations.map(r => [r.code, r]));
  if (map.size !== 553 || prepared.codes.some(c => !map.has(c))) throw new Error("LIVE_CLOUD_INCOMPLETE");
  const required = prepared.eligibleCodes.map(c => map.get(c)), b = bounds(prepared.targetDate);
  if (required.length < 5 || required.some(r => r.status !== "AVAILABLE" || r.observedDate !== prepared.targetDate
    || !versions.every(v => Number.isFinite(r.scores?.[v]) && r.scores[v] >= 0 && r.scores[v] <= 100)
    || [r.quoteRequestedAt, r.quoteReceivedAt, r.minuteRequestedAt, r.minuteReceivedAt].some(t => !Number.isFinite(Date.parse(t)) || Date.parse(t) < b.start || Date.parse(t) > b.end)
    || Date.parse(r.quoteRequestedAt) > Date.parse(r.quoteReceivedAt) || Date.parse(r.quoteReceivedAt) > Date.parse(r.minuteRequestedAt)
    || Date.parse(r.minuteRequestedAt) > Date.parse(r.minuteReceivedAt)
    || !/^\d{2}:\d{2}:\d{2}$/u.test(r.observedTime ?? "")
    || !Number.isFinite(Date.parse(`${r.observedDate}T${r.observedTime}+09:00`))
    || Date.parse(`${r.observedDate}T${r.observedTime}+09:00`) < b.start
    || Date.parse(`${r.observedDate}T${r.observedTime}+09:00`) > Date.parse(r.quoteReceivedAt)
    || !/^[a-f0-9]{64}$/u.test(r.originalRecordHash ?? "") || !/^[a-f0-9]{64}$/u.test(r.responseHash ?? "")
    || r.rawPricesStored !== false || r.modelFormulaUnchanged !== true)) throw new Error("LIVE_CLOUD_REQUIRED_INPUT_MISSING");
  const collectionStartedAt = new Date(Math.min(...required.map(r => Date.parse(r.quoteRequestedAt)))).toISOString();
  const collectionCompletedAt = new Date(Math.max(...required.map(r => Date.parse(r.minuteReceivedAt)))).toISOString();
  // New explicit score-only evidence identity, NOT a forged hash of a complete
  // old raw-price artifact. Immutable lineage remains separate from outcomes.
  const evidence = { namespace: "cloud-live-score-evidence-v1", observationPolicyId: "intraday-1400-v1", observationType: "LIVE_OBSERVATION",
    signalDate: prepared.targetDate, prepared, observations: [...observations].sort((a, b) => a.code.localeCompare(b.code)),
    collectionStartedAt, collectionCompletedAt, sourcePricesIncluded: false };
  const contentHash = hash(evidence);
  const models = versions.map((modelVersion, i) => ({ schemaVersion: 2, mode: "live", observationPolicyId: "intraday-1400-v1", observationType: "LIVE_OBSERVATION",
    officialSignalTime: "14:00:00", modelVersion, model: "ABCD"[i], signalDate: prepared.targetDate, seedReferenceDate: prepared.seedReferenceDate,
    contentHash, collectionStartedAt, collectionCompletedAt,
    records: [...required].sort((a, b) => b.scores[modelVersion] - a.scores[modelVersion] || a.code.localeCompare(b.code)).slice(0, 5)
      .map((r, rank) => ({ ticker: r.code, companyName: r.companyName, score: r.scores[modelVersion], rank: rank + 1 })) }));
  const delivery = createLiveDelivery(models, { exportedAt, now: exportedAt }); validateLiveDelivery(delivery, exportedAt);
  const storedEvidence = { ...evidence, contentHash };
  return { evidence: storedEvidence, delivery, swing: buildCloudSwingIntent(storedEvidence, delivery) };
}

// SQL-independent allocator: adjacent quote/minute cells, unchanged220ms grid
// and20ms maximum lateness => at least200ms between actual starts. No market
// cell reserved for token refresh: auth is pinned before14:00;401 fails closed.
export function nextPairSlots({ now, head = 0, date, count = 0, leadMs = 200 }) {
  const b = bounds(date), first = Math.max(head, Math.ceil(Math.max(b.start, now + leadMs) / 220));
  if (count + 2 > PRODUCTION_BUDGET.marketCalls) throw new Error("LIVE_CLOUD_REQUEST_BUDGET");
  if ((first + 1) * 220 + 20 >= b.end) throw new Error("LIVE_CLOUD_WINDOW_EXPIRED");
  return { quoteSlot: { slot: first, notBefore: first * 220 }, minuteSlot: { slot: first + 1, notBefore: (first + 1) * 220 }, head: first + 2 };
}

export function normalDayBudget() {
  const limits = { workflowSteps: 3000, workerRequests: 100000, doRequests: 100000, durationGbSeconds: 13000, sqlRowsRead: 5000000, sqlRowsWritten: 100000 };
  return Object.fromEntries(Object.entries(limits).map(([k, limit]) => [k, { limit, liveIncludingRetry: PRODUCTION_BUDGET[k],
    otherIncludingEod: OTHER_DAILY_RESERVE[k], total: PRODUCTION_BUDGET[k] + OTHER_DAILY_RESERVE[k], headroom: limit - PRODUCTION_BUDGET[k] - OTHER_DAILY_RESERVE[k] }]));
}
