import { buildIntradayModelTopSignal, validateIntradayModelTopSignal, hashIntradayModelTop as hash } from "../../lib/intraday-model-top-official-signal.mjs";
import { parseKisQuote, attachKisMinuteObservation } from "../../lib/kis-quote-provider-core.mjs";
import { createLiveDelivery, validateLiveDelivery } from "../../lib/private-live-delivery.mjs";
import { kst, safeCode } from "./core.mjs";
import { buildCloudSwingIntent } from "./cloud-swing.mjs";
import { liveScoreBounds, validLiveScore } from "../../lib/live-model-score-contract.mjs";
import { STOCK_CODE_PATTERN } from "../../lib/stock-code.mjs";
import { isLiveMissingReason } from "../../lib/live-collection-reason.mjs";
export { isLiveMissingReason };
export { kst } from "./core.mjs";

export const WATCH_CRON="0,5,15,25,30,35,40,45,59 4-6 * * MON-FRI";
export const LIVE_CRONS = Object.freeze(["40,50 4 * * MON-FRI", "6,8,10 5 * * MON-FRI", "31,33,35 6 * * MON-FRI",WATCH_CRON]);
export const LIVE_BATCH_SIZE = 4;
export const PRODUCTION_BUDGET = Object.freeze({ workflowSteps: 520, workerRequests: 2000, doRequests: 14000,
  durationGbSeconds: 8500, sqlRowsRead: 1000000, sqlRowsWritten: 40000, retainedBytesPerDay: 8000000,
  // Scale the measured71-instance footprint to140 instances (139 children
  // plus parent), three retained days and2x headroom: ~0.0632GB-month.
  // this is engineering headroom, NOT certification of a full run's billing.
  workflowStorageGbMonths: 0.08, marketCalls: 1400 });
export const OTHER_DAILY_RESERVE = Object.freeze({ workflowSteps: 100, workerRequests: 2000, doRequests: 1000,
  durationGbSeconds: 1000, sqlRowsRead: 500000, sqlRowsWritten: 15000 });
//27 filtered Cron invocations,12 actual watches, two bounded frozen relays.
// Duration pessimistically reserves12 whole15-minute scheduled events at128MB.
// No new Workflow instances/state except ensuring a missing canonical day ID.
export const WATCH_DAILY_RESERVE=Object.freeze({workflowSteps:0,workerRequests:500,doRequests:200,durationGbSeconds:1500,sqlRowsRead:20000,sqlRowsWritten:2000});
export const versions = Object.freeze(["A-v1", "B-v1", "C-v1", "D-v1"]);
// 14:00 remains the signal anchor. A delayed recovery may observe until the
// Korean cash-market close, while every actual request/response timestamp is
// retained. Nothing collected after 15:30 KST is eligible.
export const bounds = date => ({ start: Date.parse(`${date}T14:00:00+09:00`), end: Date.parse(`${date}T15:30:00+09:00`) });
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
export function productionPinnedExclusion({ code, input, seedReferenceDate, seedContext, signalDate }) {
  if (input?.code !== code || typeof input.eligible !== "boolean") throw new Error("LIVE_CLOUD_INPUT_REJECTED");
  if (input.eligible) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(seedReferenceDate ?? "") || seedContext?.requestedDate !== seedReferenceDate
    || seedReferenceDate >= signalDate || !/^[a-f0-9]{64}$/u.test(seedContext?.contentHash ?? "")) throw new Error("LIVE_CLOUD_PIN_INVALID");
  // Eligibility was fixed before collection. An excluded row needs no quote,
  // minute timestamp or fabricated observation; preserve its pinned identity.
  return { code, companyName: input.name, status: "EXCLUDED", scores: null, exclusionBasis: "PINNED_EOD_INELIGIBLE",
    seedReferenceDate, seedHash: seedContext.contentHash, inputHash: hash(input), rawPricesStored: false, modelFormulaUnchanged: true };
}
export function productionObservation({ quote, minute, code, timing, input, seedContext, signalDate }) {
  const excluded = productionPinnedExclusion({ code, input, seedReferenceDate: seedContext?.requestedDate, seedContext, signalDate });
  if (excluded) return excluded;
  const b = bounds(signalDate), stamps = [timing.quoteRequestedAt, timing.quoteReceivedAt, timing.minuteRequestedAt, timing.minuteReceivedAt].map(Date.parse);
  if (stamps.some(x => !Number.isFinite(x) || x < b.start || x > b.end) || stamps[0] > stamps[1] || stamps[1] > stamps[2] || stamps[2] > stamps[3]) throw new Error("LIVE_CLOUD_OBSERVATION_WINDOW");
  let q = parseKisQuote(quote, code, timing.quoteReceivedAt);
  if (q.asOfDate && q.asOfDate !== signalDate) throw new Error("LIVE_CLOUD_QUOTE_DATE");
  q = attachKisMinuteObservation(q, minute, { requestedDate: signalDate, requestedTime: kst(stamps[0]).time });
  const signal = buildIntradayModelTopSignal({ seed: { ...seedContext, records: [input] }, quotesByCode: new Map([[code, q]]), signalDate,
    collectionStartedAt: timing.quoteRequestedAt, collectionCompletedAt: timing.minuteReceivedAt });
  if (validateIntradayModelTopSignal(signal).length || signal.status !== "READY") throw new Error("LIVE_CLOUD_INPUT_REJECTED");
  const row = signal.records[0];
  return { code, companyName: input.name, status: input.eligible ? "AVAILABLE" : "EXCLUDED", scores: row.scores,
    ...timing, observedDate: q.asOfDate, observedTime: q.asOfTime, responseHash: hash({ quote, minute }),
    originalRecordHash: hash(row), rawPricesStored: false, modelFormulaUnchanged: true };
}

// Same predicate for publishing and for the restricted, management-only quality audit.
// Never copy a quote, price, candidate list, full observation or credentials into the report.
export function requiredRowIssues(r, day) {
  const issues=[], b=bounds(day);
  const issue=(field, value, rule)=>issues.push({field, value, rule});
  if(r?.status!=="AVAILABLE") issue("status",r?.status??null,"AVAILABLE");
  if(!r)return issues;
  if(r.observedDate!==day)issue("observedDate",r.observedDate??null,day);
  for(const v of versions){const s=r.scores?.[v];if(!validLiveScore(v,s))issue("scores."+v,Number.isFinite(s)?s:null,"finite "+liveScoreBounds(v).join(".."));}
  const keys=["quoteRequestedAt","quoteReceivedAt","minuteRequestedAt","minuteReceivedAt"];
  keys.forEach((k,i)=>{const t=Date.parse(r[k]);if(!Number.isFinite(t)||t<b.start||t>b.end)issue(k,r[k]??null,"inside session");
    if(i&&Date.parse(r[keys[i-1]])>t)issue(k,r[k],"not before "+r[keys[i-1]]);});
  const local=Date.parse(r.observedDate+"T"+r.observedTime+"+09:00");
  if(!/^\d{2}:\d{2}:\d{2}$/u.test(r.observedTime??"")||!Number.isFinite(local))issue("observedTime",r.observedTime??null,"valid KST HH:mm:ss");
  else if(local<b.start)issue("observedTime",r.observedTime,"at or after 14:00:00 KST");
  else if(local>Date.parse(r.quoteReceivedAt))issue("observedTime",r.observedTime,"not after "+r.quoteReceivedAt);
  for(const k of ["originalRecordHash","responseHash"])if(!/^[a-f0-9]{64}$/u.test(r[k]??""))issue(k,r[k]==null?null:"invalid digest","SHA256");
  for(const [k,want] of [["rawPricesStored",false],["modelFormulaUnchanged",true]])if(r[k]!==want)issue(k,r[k]??null,String(want));
  return issues;
}
function pinnedUniverse(prepared) {
  if (prepared?.readiness !== "READY" || prepared.universe !== 553 || !Array.isArray(prepared.codes)
    || prepared.codes.length !== 553 || new Set(prepared.codes).size !== 553 || !Array.isArray(prepared.eligibleCodes)
    || prepared.eligibleCodes.length !== prepared.eligible || new Set(prepared.eligibleCodes).size !== prepared.eligible
    || prepared.eligibleCodes.some(c => !prepared.codes.includes(c))) throw new Error("LIVE_CLOUD_INCOMPLETE");
  return new Set(prepared.codes);
}

function validDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(value) && Number.isFinite(Date.parse(value))
    && new Date(Date.parse(value)).toISOString().slice(0,10) === value;
}

export function observationFailureReasons(row) {
  if ([401,403].includes(Number(row.httpStatus))) throw new Error(`KIS_HTTP_${Number(row.httpStatus)}`);
  const reasons=[row.sourceFailure,row.providerFailureCode==="KIS_BUSINESS_EGW00201"?"KIS_RATE_LIMITED":row.providerFailureCode,row.reason].filter(Boolean);
  for(const reason of reasons)if(!isLiveMissingReason(reason))throw new Error(safeCode({code:reason}));
  return reasons;
}
export function evaluateCollectionPolicy(prepared, observations, { failures = [], globalFailure = null } = {}) {
  const universe = pinnedUniverse(prepared), eligible = new Set(prepared.eligibleCodes);
  const checked = Date.parse(prepared.remoteCheckedAt), ready = Date.parse(prepared.readyAt);
  if (!validDate(prepared.targetDate) || !validDate(prepared.seedReferenceDate) || prepared.seedReferenceDate >= prepared.targetDate
    || prepared.formulaHashesVerified !== true || !/^[a-f0-9]{64}$/u.test(prepared.seedHash ?? "") || !/^[a-f0-9]{40}$/u.test(prepared.inputCommit ?? "")
    || !Number.isFinite(checked) || !Number.isFinite(ready) || new Date(checked).toISOString() !== prepared.remoteCheckedAt
    || new Date(ready).toISOString() !== prepared.readyAt || checked > ready || ready >= bounds(prepared.targetDate).start || kst(checked).date !== prepared.targetDate
    || prepared.codes.some(code => typeof code !== "string" || !STOCK_CODE_PATTERN.test(code)) || eligible.size < 5)
    throw new Error("LIVE_CLOUD_PIN_INVALID");
  if (!Array.isArray(observations) || observations.length > universe.size || !Array.isArray(failures) || failures.length > 2 * universe.size)
    throw new Error("LIVE_CLOUD_CHILD_RESULTS_INVALID");
  const byCode = new Map(), byFailure = new Map(), rejectedByReceipt = new Set(), scopedReasons = new Set();
  function checkReason(reason) {
    if (!isLiveMissingReason(reason)) throw new Error(safeCode({ code: reason }));
    scopedReasons.add(reason);
  }
  for (const failure of failures) {
    if (!universe.has(failure?.code)) throw new Error("LIVE_CLOUD_CHILD_RESULTS_INVALID");
    checkReason(failure.reason);
    byFailure.set(failure.code, failure.reason);
    if (failure.evidenceSource === "RATE_REJECTION" && failure.reason === "LIVE_CLOUD_RATE_EVIDENCE_INVALID") rejectedByReceipt.add(failure.code);
  }
  for (const row of observations) {
    if (row === null) continue;
    if (!universe.has(row?.code) || byCode.has(row.code)) throw new Error("LIVE_CLOUD_COMPLETION_MISMATCH");
    for(const reason of observationFailureReasons(row))scopedReasons.add(reason);
    if (row.status === "EXCLUDED" && eligible.has(row.code) || row.status === "AVAILABLE" && !eligible.has(row.code))
      throw new Error("LIVE_CLOUD_PIN_INVALID");
    if (row.status !== "EXCLUDED" && row.status !== "AVAILABLE" && !row.reason) throw new Error("LIVE_CLOUD_METADATA_INVALID");
    byCode.set(row.code, row);
  }
  if (globalFailure) {
    const code = typeof globalFailure === "string" ? globalFailure : globalFailure.code;
    if (!scopedReasons.has(code) || globalFailure.stage && globalFailure.stage !== "BATCH_COLLECTION") throw new Error(safeCode({ code }));
  }
  const missing = [];
  for (const ticker of eligible) {
    const row = byCode.get(ticker);
    if (rejectedByReceipt.has(ticker)) { missing.push({ticker, reason:"LIVE_CLOUD_RATE_EVIDENCE_INVALID"}); continue; }
    if (row?.status === "AVAILABLE" && !row.reason && !requiredRowIssues(row, prepared.targetDate).length) continue;
    const reason = row ? row.reason ?? "LIVE_CLOUD_OBSERVATION_INVALID" : byFailure.get(ticker) ?? "LIVE_CLOUD_OBSERVATION_MISSING";
    missing.push({ ticker, reason });
  }
  missing.sort((a, b) => a.ticker.localeCompare(b.ticker));
  const validCount = eligible.size - missing.length;
  return { status: missing.length === 0 ? "COMPLETE" : missing.length <= 4 ? "PARTIAL" : "WITHHELD",
    targetCount: eligible.size, validCount, missing,
    universeHash: hash({ targetDate: prepared.targetDate, seedReferenceDate: prepared.seedReferenceDate, seedHash: prepared.seedHash,
      codes: prepared.codes, eligibleCodes: prepared.eligibleCodes }) };
}

export function aggregateProduction(prepared, observations, exportedAt, issuance) {
  const policy = issuance ? evaluateCollectionPolicy(prepared, observations, issuance) : null;
  if (policy && (policy.status === "WITHHELD" || policy.validCount < 5)) throw new Error("LIVE_CLOUD_REQUIRED_INPUT_MISSING");
  if (!policy) pinnedUniverse(prepared);
  const present = policy ? observations.filter(Boolean) : observations;
  const map = new Map(present.map(r => [r.code, r]));
  if (!policy && (present.length !== 553 || map.size !== 553 || prepared.codes.some(c => !map.has(c)))) throw new Error("LIVE_CLOUD_INCOMPLETE");
  const unavailable = new Set(policy?.missing.map(row => row.ticker));
  const required = prepared.eligibleCodes.filter(code => !unavailable.has(code)).map(code => map.get(code));
  if (!policy && (required.length < 5 || required.some(r => requiredRowIssues(r, prepared.targetDate).length))) throw new Error("LIVE_CLOUD_REQUIRED_INPUT_MISSING");
  const collectionStartedAt = new Date(Math.min(...required.map(r => Date.parse(r.quoteRequestedAt)))).toISOString();
  const collectionCompletedAt = new Date(Math.max(...required.map(r => Date.parse(r.minuteReceivedAt)))).toISOString();
  // New explicit score-only evidence identity, NOT a forged hash of a complete
  // old raw-price artifact. Immutable lineage remains separate from outcomes.
  const evidence = { namespace: "cloud-live-score-evidence-v1", observationPolicyId: "intraday-1400-v1", observationType: "LIVE_OBSERVATION",
    signalDate: prepared.targetDate, prepared, observations: [...(policy ? required : present)].sort((a, b) => a.code.localeCompare(b.code)),
    ...(policy ? { coverage: policy } : {}),
    collectionStartedAt, collectionCompletedAt, sourcePricesIncluded: false };
  const contentHash = hash(evidence);
  const models = versions.map((modelVersion, i) => ({ schemaVersion: 2, mode: "live", observationPolicyId: "intraday-1400-v1", observationType: "LIVE_OBSERVATION",
    officialSignalTime: "14:00:00", modelVersion, model: "ABCD"[i], signalDate: prepared.targetDate, seedReferenceDate: prepared.seedReferenceDate,
    contentHash, collectionStartedAt, collectionCompletedAt,
    records: [...required].sort((a, b) => b.scores[modelVersion] - a.scores[modelVersion] || a.code.localeCompare(b.code)).slice(0, 5)
      .map((r, rank) => ({ ticker: r.code, companyName: r.companyName, score: r.scores[modelVersion], rank: rank + 1 })) }));
  const publication = policy && { ...policy, revision: issuance.revision, previousDeliveryHash: issuance.previousDeliveryHash,
    firstIssuedAt: issuance.firstIssuedAt };
  const delivery = createLiveDelivery(models, { exportedAt, now: exportedAt, ...(publication ? { publication } : {}) });
  validateLiveDelivery(delivery, exportedAt);
  const storedEvidence = { ...evidence, contentHash };
  return { evidence: storedEvidence, delivery, swing: policy ? null : buildCloudSwingIntent(storedEvidence, delivery) };
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
    otherIncludingEod: OTHER_DAILY_RESERVE[k],watchIncludingRetry:WATCH_DAILY_RESERVE[k],total: PRODUCTION_BUDGET[k] + OTHER_DAILY_RESERVE[k]+WATCH_DAILY_RESERVE[k], headroom: limit - PRODUCTION_BUDGET[k] - OTHER_DAILY_RESERVE[k]-WATCH_DAILY_RESERVE[k] }]));
}
