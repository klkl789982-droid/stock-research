import { sha256Canonical } from "./snapshot-quality-pipeline.mjs";
import { normalizeStockCode } from "./stock-code.mjs";
import { locateExecutionTradingDay } from "./execution-return-resolver.mjs";
import { isCurrentIntradayModelTopSignal } from "./intraday-model-top-official-signal.mjs";

export const INTRADAY_MODEL_TOP_EXECUTION_POLICY_ID = "intraday-1400-t1-open-v1";
export const INTRADAY_MODEL_TOP_OUTCOME_DIRECTORY = "data/intraday-outcomes/model-top/1400";
export const INTRADAY_MODEL_TOP_OUTCOME_PROFILES = Object.freeze({
  current: Object.freeze({ schemaVersion: 2, layer: "INTRADAY_1400_LIVE", signalTime: "14:00:00", executionPolicyId: INTRADAY_MODEL_TOP_EXECUTION_POLICY_ID }),
  legacy1430: Object.freeze({ schemaVersion: 1, layer: "INTRADAY_1430_LIVE", signalTime: "14:30:00", executionPolicyId: "intraday-1430-t1-open-v1" }),
});
export const INTRADAY_MODEL_TOP_HORIZONS = Object.freeze({
  "1DAY": { holdingTradingDays: 1, offsetFromEntry: 0 },
  "5DAY": { holdingTradingDays: 5, offsetFromEntry: 4 },
  "20DAY": { holdingTradingDays: 20, offsetFromEntry: 19 },
  "60DAY": { holdingTradingDays: 60, offsetFromEntry: 59 },
});

const HASH = /^[a-f0-9]{64}$/u;
const MODELS = ["A-v1", "B-v1", "C-v1", "D-v1"];
const STATUSES = ["PENDING", "MATURE", "DATA_MISSING"];
const finitePrice = (value) => typeof value === "number" && Number.isFinite(value) && value > 0;
const roundReturn = (value) => Number(value.toFixed(6));
const targetStatus = (target) => target.status === "pendingFutureTradingDay" ? "PENDING" : "DATA_MISSING";
const timestamp = (value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)
  && dateOnly(value.slice(0, 10)) && Number(value.slice(11, 13)) < 24 && Number(value.slice(14, 16)) < 60 && Number(value.slice(17, 19)) < 60 && Number.isFinite(Date.parse(value));
const dateOnly = (value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const marketTime = (date, time) => `${date}T${time}+09:00`;
const observedBy = (resolvedAt, date, time) => Date.parse(resolvedAt) >= Date.parse(marketTime(date, time));

export function matchesIntradayOutcomeProfile(value, profile = INTRADAY_MODEL_TOP_OUTCOME_PROFILES.current) {
  return value?.schemaVersion === profile.schemaVersion && value?.dataset === "intraday-model-top-execution-outcomes"
    && value?.layer === profile.layer && value?.signalTime === profile.signalTime
    && value?.executionPolicy?.policyId === profile.executionPolicyId && dateOnly(value?.signalDate);
}

// Hash only source contents. Availability is a separate receipt bound to that hash,
// never a timestamp inferred from market close, nominal publication policy, or a file name.
export function hashIntradayEvidencePayload(value) {
  return sha256Canonical(Object.fromEntries(Object.entries(value ?? {}).filter(([key]) => !["contentHash", "availability", "recordsByCode"].includes(key))));
}

function availabilityFailure(proof, expectedHash, resolvedAt, earliestAt = null) {
  if (!proof || typeof proof.source !== "string" || !proof.source.trim() || !HASH.test(expectedHash ?? "") || proof.sourceHash !== expectedHash) return "availabilitySourceUnproven";
  if (!timestamp(proof.availableAt)) return "actualAvailabilityUnknown";
  const observedAt = proof.observedAt ?? proof.receivedAt;
  const proofAt = proof.availabilityEvidence === "SYSTEM_OBSERVED" ? observedAt
    : proof.availabilityEvidence === "PROVIDER_PUBLISHED" ? proof.publishedAt : null;
  if (!timestamp(proofAt) || Date.parse(proofAt) !== Date.parse(proof.availableAt)) return "availabilityProofUnproven";
  if (proof.observedAt && proof.receivedAt && Date.parse(proof.observedAt) !== Date.parse(proof.receivedAt)) return "availabilityProofConflict";
  if (Date.parse(proof.availableAt) > Date.parse(resolvedAt)) return "notYetAvailable";
  if (earliestAt && Date.parse(proof.availableAt) < Date.parse(earliestAt)) return "availabilityPrecedesObservation";
  return null;
}

function priceEvidence(ledgers, date, ticker, resolvedAt) {
  const candidates = ledgers.filter((ledger) => ledger?.date === date);
  if (candidates.length !== 1) return { reason: candidates.length ? "duplicatePriceLedger" : "missingPriceLedger" };
  const ledger = candidates[0];
  // The raw rows must be retained, rather than trusting a Map that silently erased duplicates.
  if (!Array.isArray(ledger.records)) return { reason: "unverifiablePriceRows" };
  if (!HASH.test(ledger.contentHash ?? "") || ledger.contentHash !== hashIntradayEvidencePayload(ledger)) return { reason: "priceContentHashUnproven" };
  const availability = availabilityFailure(ledger.availability, ledger.contentHash, resolvedAt, marketTime(date, "15:30:00"));
  if (availability) return { reason: availability };
  const rows = ledger.records.filter((record) => normalizeStockCode(record?.code) === normalizeStockCode(ticker));
  if (rows.length !== 1) return { reason: rows.length ? "duplicatePriceTicker" : "missingPriceTicker" };
  const price = rows[0];
  if (price.date !== date) return { reason: "priceDateMismatch" };
  if (price.executable !== true) return { reason: price.executable === false ? "notExecutable" : "executabilityUnknown" };
  return { price, provenance: { contentHash: ledger.contentHash, availability: structuredClone(ledger.availability) } };
}

function executionProof(evidence, ticker, entryDate, exitDate, resolvedAt) {
  const scoped = evidence.filter((item) => item && normalizeStockCode(item.ticker) === normalizeStockCode(ticker) && item.entryDate === entryDate && item.exitDate === exitDate);
  if (scoped.length !== 1) return { reason: scoped.length ? "duplicateExecutionEvidence" : "executionEvidenceMissing" };
  const proof = scoped[0];
  if (proof.status !== "CONFIRMED" || proof.entryExecutable !== true || proof.exitExecutable !== true || proof.adjustmentBasis !== "UNADJUSTED_NO_CORPORATE_ACTIONS") return { reason: "securityOrAdjustmentUnproven" };
  if (!HASH.test(proof.contentHash ?? "") || proof.contentHash !== hashIntradayEvidencePayload(proof)) return { reason: "executionEvidenceHashUnproven" };
  const failure = availabilityFailure(proof.availability, proof.contentHash, resolvedAt, marketTime(exitDate, "15:30:00"));
  if (failure) return { reason: `execution:${failure}` };
  return { proof: structuredClone(proof) };
}

function createObservationRecords(signal) {
  return (signal.records ?? []).flatMap((record) => record.dataStatus !== "AVAILABLE" ? [] : Object.entries(record.ranks ?? {}).flatMap(([modelVersion, rank]) => {
    if (!MODELS.includes(modelVersion) || !Number.isInteger(rank) || rank < 1 || rank > 20) return [];
    return [{
      observationId: record.observationIds?.[modelVersion] ?? null, modelVersion, ticker: record.ticker, companyName: record.companyName, rank,
      topNs: [5, 10, 20].filter((topN) => rank <= topN),
      entry: { status: "PENDING", tradingDate: null, timestamp: null, price: null, priceBasis: "nextTradingDayOfficialOpen", reason: "futureTradingDayPending", provenance: null, executionEvidence: null },
      horizons: Object.fromEntries(Object.keys(INTRADAY_MODEL_TOP_HORIZONS).map((horizon) => [horizon, { status: "PENDING", targetTradingDate: null, closePrice: null, returnPercent: null, reason: "futureTradingDayPending", resolvedAt: null, provenance: null, executionEvidence: null }])),
    }];
  })).sort((left, right) => left.modelVersion.localeCompare(right.modelVersion) || left.rank - right.rank || left.ticker.localeCompare(right.ticker));
}

/** Current 14:00 only. Legacy outcomes are read-only archives, never resolution inputs.
 * Evidence adapters must supply actual hash-bound receipts and scoped execution proof.
 * Today's collector/price ledgers do not manufacture these missing proofs.
 */
export function resolveIntradayModelTopOutcomes({ signal, existing = null, priceLedgers = [], tradingCalendar, resolvedAt, signalAvailability = null, executionEvidence = [] }) {
  if (!isCurrentIntradayModelTopSignal(signal) || signal.observationType !== "LIVE_OBSERVATION" || signal.status !== "READY") throw new Error("INTRADAY_1400_LIVE_SIGNAL_INVALID");
  if (!timestamp(resolvedAt)) throw new Error("RESOLVED_AT_INVALID");
  if (!Array.isArray(priceLedgers) || !Array.isArray(executionEvidence)) throw new Error("OUTCOME_EVIDENCE_INVALID");
  if (existing && (!matchesIntradayOutcomeProfile(existing) || existing.signalDate !== signal.signalDate || existing.signalContentHash !== signal.contentHash || validateIntradayModelTopOutcomes(existing).length)) throw new Error("INTRADAY_OUTCOME_COHORT_OR_SIGNAL_CONFLICT");
  if (existing && Date.parse(existing.generatedAt) > Date.parse(resolvedAt)) throw new Error("RESOLUTION_BEFORE_EXISTING_OUTCOME");
  const records = createObservationRecords(signal);
  const priorById = new Map((existing?.records ?? []).map((record) => [record.observationId, record]));
  const entryTarget = locateExecutionTradingDay(tradingCalendar, signal.signalDate, 1);
  const signalProofFailure = availabilityFailure(signalAvailability, signal.contentHash, resolvedAt, signal.collectionCompletedAt);
  for (const record of records) {
    const setEntryFailure = (status, reason) => { record.entry = { ...record.entry, status, tradingDate: entryTarget.date, reason }; };
    if (entryTarget.status !== "resolved") setEntryFailure(targetStatus(entryTarget), entryTarget.status);
    else if (!observedBy(resolvedAt, entryTarget.date, "09:00:00")) setEntryFailure("PENDING", "entryOpenNotYetObserved");
    else if (signalProofFailure) setEntryFailure(signalProofFailure === "notYetAvailable" ? "PENDING" : "DATA_MISSING", `signal:${signalProofFailure}`);
    else if (Date.parse(signalAvailability.availableAt) >= Date.parse(marketTime(entryTarget.date, "09:00:00"))) setEntryFailure("DATA_MISSING", "signalNotAvailableBeforeEntry");
    else {
      const entry = priceEvidence(priceLedgers, entryTarget.date, record.ticker, resolvedAt);
      if (entry.reason) setEntryFailure(entry.reason === "notYetAvailable" ? "PENDING" : "DATA_MISSING", `entry:${entry.reason}`);
      else if (!finitePrice(entry.price.openPrice)) setEntryFailure("DATA_MISSING", "missingEntryOpenPrice");
      else {
        const execution = executionProof(executionEvidence, record.ticker, entryTarget.date, entryTarget.date, resolvedAt);
        if (execution.reason) setEntryFailure(execution.reason === "execution:notYetAvailable" ? "PENDING" : "DATA_MISSING", execution.reason);
        else record.entry = { status: "MATURE", tradingDate: entryTarget.date, timestamp: marketTime(entryTarget.date, "09:00:00"), price: entry.price.openPrice, priceBasis: "nextTradingDayOfficialOpen", reason: null, provenance: entry.provenance, executionEvidence: execution.proof };
      }
    }
    for (const [horizon, policy] of Object.entries(INTRADAY_MODEL_TOP_HORIZONS)) {
      const setFailure = (status, reason, targetTradingDate = null) => { record.horizons[horizon] = { ...record.horizons[horizon], status, reason, targetTradingDate }; };
      if (record.entry.status !== "MATURE") { setFailure(record.entry.status, `entry:${record.entry.reason}`); continue; }
      const target = policy.offsetFromEntry === 0 ? { status: "resolved", date: record.entry.tradingDate } : locateExecutionTradingDay(tradingCalendar, record.entry.tradingDate, policy.offsetFromEntry);
      if (target.status !== "resolved") { setFailure(targetStatus(target), target.status, target.date); continue; }
      if (!observedBy(resolvedAt, target.date, "15:30:00")) { setFailure("PENDING", "targetCloseNotYetObserved", target.date); continue; }
      const exit = priceEvidence(priceLedgers, target.date, record.ticker, resolvedAt);
      if (exit.reason) { setFailure(exit.reason === "notYetAvailable" ? "PENDING" : "DATA_MISSING", `exit:${exit.reason}`, target.date); continue; }
      if (!finitePrice(exit.price.closePrice)) { setFailure("DATA_MISSING", "missingExitClosePrice", target.date); continue; }
      const execution = executionProof(executionEvidence, record.ticker, record.entry.tradingDate, target.date, resolvedAt);
      if (execution.reason) { setFailure(execution.reason === "execution:notYetAvailable" ? "PENDING" : "DATA_MISSING", execution.reason, target.date); continue; }
      const returnPercent = roundReturn((exit.price.closePrice / record.entry.price - 1) * 100);
      if (!Number.isFinite(returnPercent)) { setFailure("DATA_MISSING", "returnNotFinite", target.date); continue; }
      const candidate = { status: "MATURE", targetTradingDate: target.date, closePrice: exit.price.closePrice, returnPercent, reason: null, resolvedAt, provenance: exit.provenance, executionEvidence: execution.proof };
      const prior = priorById.get(record.observationId)?.horizons?.[horizon];
      // Reuse only the first resolution timestamp after recomputing and verifying all evidence.
      if (prior?.status === "MATURE" && Date.parse(prior.resolvedAt) <= Date.parse(resolvedAt)
        && !availabilityFailure(signalAvailability, signal.contentHash, prior.resolvedAt, signal.collectionCompletedAt)
        && !availabilityFailure(record.entry.provenance.availability, record.entry.provenance.contentHash, prior.resolvedAt)
        && !executionProof([record.entry.executionEvidence], record.ticker, record.entry.tradingDate, record.entry.tradingDate, prior.resolvedAt).reason
        && sha256Canonical({ ...prior, resolvedAt: null }) === sha256Canonical({ ...candidate, resolvedAt: null })) candidate.resolvedAt = prior.resolvedAt;
      record.horizons[horizon] = candidate;
    }
  }
  const summary = Object.fromEntries(Object.keys(INTRADAY_MODEL_TOP_HORIZONS).map((horizon) => [horizon, {
    sampleCount: records.filter((record) => record.horizons[horizon].status === "MATURE").length,
    maturity: Object.fromEntries(STATUSES.map((status) => [status, records.filter((record) => record.horizons[horizon].status === status).length])),
  }]));
  const base = {
    schemaVersion: 2, dataset: "intraday-model-top-execution-outcomes", layer: "INTRADAY_1400_LIVE", signalDate: signal.signalDate, signalTime: "14:00:00", signalContentHash: signal.contentHash,
    executionPolicy: { policyId: INTRADAY_MODEL_TOP_EXECUTION_POLICY_ID, entryTradingDayOffset: 1, entryPriceBasis: "officialDailyOpen", rationale: "official-price benchmark after a verified available 14:00 signal; actual fills are not recorded", grossReturn: true, transactionCostsIncluded: false, slippageIncluded: false, interpretation: "OBSERVATIONAL_OFFICIAL_PRICE_BENCHMARK_NOT_REALIZED_PNL" },
    horizons: INTRADAY_MODEL_TOP_HORIZONS, generatedAt: existing?.generatedAt ?? resolvedAt, updatedAt: resolvedAt,
    source: { signalDataset: signal.artifactType, signalHash: signal.contentHash, signalCollectionCompletedAt: signal.collectionCompletedAt, signalAvailability: signalAvailability ? structuredClone(signalAvailability) : null, marketPriceLedger: "data/market-prices/YYYY-MM-DD.json", tradingCalendar: "data/trading-calendar/status.json", tradingCalendarHash: sha256Canonical(tradingCalendar ?? {}) },
    evidenceAdapterStatus: "EXTERNAL_VERIFIED_RECEIPTS_REQUIRED_NOT_YET_PROVIDED_BY_PRODUCTION", records, summary,
  };
  const artifact = { ...base, contentHash: sha256Canonical(base) };
  const errors = validateIntradayModelTopOutcomes(artifact);
  if (errors.length) throw new Error(`INTRADAY_OUTCOME_CONTRACT_INVALID:${errors.join(",")}`);
  return artifact;
}

/** Legacy validation is only for archive reads. It cannot certify or upgrade v1 returns. */
export function validateLegacyIntradayModelTopOutcomes(value) {
  const errors = [];
  if (!matchesIntradayOutcomeProfile(value, INTRADAY_MODEL_TOP_OUTCOME_PROFILES.legacy1430)) errors.push("legacySchema");
  if (!Array.isArray(value?.records) || value.records.some((record) => !record || typeof record !== "object" || !MODELS.includes(record.modelVersion) || !normalizeStockCode(record.ticker))) errors.push("records");
  const { contentHash, ...base } = value ?? {};
  if (contentHash !== sha256Canonical(base)) errors.push("contentHash");
  return errors;
}

export function validateIntradayModelTopOutcomes(value) {
  const errors = [];
  if (!matchesIntradayOutcomeProfile(value)) errors.push("schema");
  if (!timestamp(value?.generatedAt) || !timestamp(value?.updatedAt) || Date.parse(value.generatedAt) > Date.parse(value.updatedAt)) errors.push("timestamps");
  if (!HASH.test(value?.signalContentHash ?? "") || value?.source?.signalHash !== value?.signalContentHash) errors.push("signalHash");
  if (!timestamp(value?.source?.signalCollectionCompletedAt)) errors.push("signalCollectionCompletedAt");
  if (value?.executionPolicy?.interpretation !== "OBSERVATIONAL_OFFICIAL_PRICE_BENCHMARK_NOT_REALIZED_PNL") errors.push("interpretation");
  const records = Array.isArray(value?.records) ? value.records : [];
  if (!Array.isArray(value?.records) || new Set(records.map((record) => record?.observationId)).size !== records.length) errors.push("records");
  if (new Set(records.map((record) => `${record?.modelVersion}:${record?.ticker}`)).size !== records.length) errors.push("duplicateModelTicker");
  for (const record of records) {
    if (!record || typeof record !== "object") { errors.push("recordIdentity"); continue; }
    if (!HASH.test(record?.observationId ?? "") || !MODELS.includes(record.modelVersion) || !normalizeStockCode(record.ticker) || !Number.isInteger(record.rank) || record.rank < 1 || record.rank > 20) errors.push("recordIdentity");
    const entry = record.entry;
    if (!STATUSES.includes(entry?.status)) errors.push("entryStatus");
    if (entry?.status === "MATURE") {
      if (!finitePrice(entry.price) || !dateOnly(entry.tradingDate) || entry.timestamp !== marketTime(entry.tradingDate, "09:00:00") || entry.tradingDate <= value.signalDate || entry.reason !== null) errors.push("entry");
      if (availabilityFailure(value.source?.signalAvailability, value.signalContentHash, value.updatedAt, value.source?.signalCollectionCompletedAt) || Date.parse(value.source?.signalAvailability?.availableAt) >= Date.parse(entry.timestamp)) errors.push("signalAvailability");
      if (availabilityFailure(entry.provenance?.availability, entry.provenance?.contentHash, value.updatedAt, marketTime(entry.tradingDate, "15:30:00"))) errors.push("entryAvailability");
      if (executionProof(entry.executionEvidence ? [entry.executionEvidence] : [], record.ticker, entry.tradingDate, entry.tradingDate, value.updatedAt).reason) errors.push("entryExecutionEvidence");
    } else if (entry?.price !== null || entry?.timestamp !== null || entry?.provenance !== null || entry?.executionEvidence !== null || !entry?.reason) errors.push("unresolvedEntry");
    for (const horizon of Object.keys(INTRADAY_MODEL_TOP_HORIZONS)) {
      const result = record.horizons?.[horizon];
      if (!STATUSES.includes(result?.status)) { errors.push("horizonStatus"); continue; }
      if (result.status === "MATURE") {
        if (entry?.status !== "MATURE" || !dateOnly(result.targetTradingDate) || result.targetTradingDate < entry.tradingDate || !finitePrice(result.closePrice) || !Number.isFinite(result.returnPercent) || result.returnPercent !== roundReturn((result.closePrice / entry.price - 1) * 100) || result.reason !== null || !timestamp(result.resolvedAt) || Date.parse(result.resolvedAt) > Date.parse(value.updatedAt) || !observedBy(result.resolvedAt, result.targetTradingDate, "15:30:00")) errors.push("matureReturn");
        if ((horizon === "1DAY" && result.targetTradingDate !== entry?.tradingDate) || (horizon !== "1DAY" && result.targetTradingDate <= entry?.tradingDate)) errors.push("horizonWindow");
        if (availabilityFailure(value.source?.signalAvailability, value.signalContentHash, result.resolvedAt, value.source?.signalCollectionCompletedAt)
          || availabilityFailure(entry?.provenance?.availability, entry?.provenance?.contentHash, result.resolvedAt)
          || executionProof(entry?.executionEvidence ? [entry.executionEvidence] : [], record.ticker, entry?.tradingDate, entry?.tradingDate, result.resolvedAt).reason) errors.push("entryEvidenceAfterResolution");
        if (availabilityFailure(result.provenance?.availability, result.provenance?.contentHash, result.resolvedAt, marketTime(result.targetTradingDate, "15:30:00"))) errors.push("exitAvailability");
        if (executionProof(result.executionEvidence ? [result.executionEvidence] : [], record.ticker, entry?.tradingDate, result.targetTradingDate, result.resolvedAt).reason) errors.push("executionEvidence");
      } else if (result.returnPercent !== null || result.closePrice !== null || result.resolvedAt !== null || result.provenance !== null || result.executionEvidence !== null || !result.reason) errors.push("unresolvedReturn");
    }
  }
  const { contentHash, ...base } = value ?? {};
  if (contentHash !== sha256Canonical(base)) errors.push("contentHash");
  return [...new Set(errors)];
}
