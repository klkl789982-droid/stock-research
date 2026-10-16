import { createHash } from "node:crypto";

/** Preparation and observational labels only. This module does not train or predict. */
export const SWING_FORECAST_VERSION = "swing5-1400-preparing-v2";
export const SWING_HORIZON_TRADING_DAYS = 5;
const HASH = /^[a-f0-9]{64}$/u;
const EVIDENCE = ["SYSTEM_OBSERVED", "PROVIDER_PUBLISHED"];
const ENTRY_POLICY = "NEXT_CONFIRMED_SESSION_OPEN_STRICTLY_AFTER_ISSUANCE";
const EXIT_POLICY = "FIFTH_SESSION_CLOSE_INCLUDING_ENTRY";

function plainCopy(value, seen = new Set(), depth = 0) {
  if (depth > 30) throw new TypeError("JSON_DEPTH_EXCEEDED");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "object" || seen.has(value)) throw new TypeError("NON_JSON_VALUE");
  if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError("NON_PLAIN_OBJECT");
  seen.add(value);
  const copy = Array.isArray(value) ? [] : {};
  for (const key of Object.keys(value).sort()) {
    if (["__proto__", "constructor", "prototype"].includes(key)) throw new TypeError("UNSAFE_OBJECT_KEY");
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) throw new TypeError("ACCESSOR_NOT_ALLOWED");
    copy[key] = plainCopy(descriptor.value, seen, depth + 1);
  }
  if (Array.isArray(value) && Object.keys(copy).length !== value.length) throw new TypeError("SPARSE_ARRAY");
  if (Object.getOwnPropertySymbols(value).length) throw new TypeError("SYMBOL_KEY_NOT_ALLOWED");
  seen.delete(value);
  return copy;
}

export function hashSwingContent(value) {
  return createHash("sha256").update(JSON.stringify(plainCopy(value))).digest("hex");
}

function freeze(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function dateOnly(value, field, nullable = false) {
  if (nullable && (value === null || value === undefined)) return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) throw new TypeError(`${field}:INVALID_DATE`);
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw new TypeError(`${field}:INVALID_DATE`);
  return value;
}

function timestamp(value, field, nullable = false) {
  if (nullable && (value === null || value === undefined)) return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)) throw new TypeError(`${field}:INVALID_TIMESTAMP`);
  dateOnly(value.slice(0, 10), field);
  const [hours, minutes, seconds] = value.slice(11, 19).split(":").map(Number);
  const offset = value.endsWith("Z") ? [0, 0] : value.slice(-5).split(":").map(Number);
  if (hours > 23 || minutes > 59 || seconds > 59 || offset[0] > 14 || offset[1] > 59 || (offset[0] === 14 && offset[1] !== 0)) throw new TypeError(`${field}:INVALID_TIMESTAMP`);
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new TypeError(`${field}:INVALID_TIMESTAMP`);
  return new Date(time).toISOString();
}

function positive(value, field, nullable = false) {
  if (nullable && (value === null || value === undefined)) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new TypeError(`${field}:INVALID_POSITIVE_NUMBER`);
  return value;
}

function hash(value, field, nullable = false) {
  if (nullable && (value === undefined || value === null)) return null;
  if (typeof value !== "string" || !HASH.test(value)) throw new TypeError(`${field}:INVALID_SOURCE_HASH`);
  return value;
}

function text(value, field, nullable = false) {
  if (nullable && (value === undefined || value === null)) return null;
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${field}:INVALID_TEXT`);
  return value;
}

function normalizeProvenance(raw = {}) {
  if (raw === null) raw = {};
  return {
    source: text(raw.source, "source", true),
    sourceHash: hash(raw.sourceHash, "sourceHash", true),
    availableAt: timestamp(raw.availableAt, "availableAt", true),
    availabilityEvidence: text(raw.availabilityEvidence, "availabilityEvidence", true),
    receivedAt: timestamp(raw.receivedAt, "receivedAt", true),
    publishedAt: timestamp(raw.publishedAt, "publishedAt", true),
    publicationLowerBoundAt: timestamp(raw.publicationLowerBoundAt, "publicationLowerBoundAt", true),
    sourceArtifact: text(raw.sourceArtifact, "sourceArtifact", true),
    metadata: raw.metadata ?? null,
  };
}

function provenanceReasons(provenance, boundary, prefix) {
  const reasons = [];
  const add = (reason) => reasons.push(`${prefix}:${reason}`);
  if (!provenance.source) add("MISSING_SOURCE");
  if (!provenance.sourceHash) add("MISSING_SOURCE_HASH");
  if (!provenance.availableAt) add("MISSING_AVAILABLE_AT");
  if (!EVIDENCE.includes(provenance.availabilityEvidence)) add("UNPROVEN_AVAILABILITY");
  // Market open/close and a publication-policy lower bound are never availability evidence.
  const proofAt = provenance.availabilityEvidence === "SYSTEM_OBSERVED" ? provenance.receivedAt
    : provenance.availabilityEvidence === "PROVIDER_PUBLISHED" ? provenance.publishedAt : null;
  if (!proofAt || proofAt !== provenance.availableAt) add("MISSING_MATCHING_AVAILABILITY_PROOF");
  if (provenance.availableAt && provenance.availableAt > boundary) add("AVAILABLE_AFTER_BOUNDARY");
  if (provenance.publicationLowerBoundAt && provenance.availableAt && provenance.availableAt < provenance.publicationLowerBoundAt) add("BEFORE_PUBLICATION_LOWER_BOUND");
  return reasons;
}

function unique(values) { return [...new Set(values)].sort(); }

/** The caller must capture actual issuance time, never reuse an historical observation time. */
export function createPreparingForecast(options) {
  const safe = plainCopy(options);
  const createdAt = timestamp(safe.createdAt, "createdAt");
  const issuanceMarketDate = dateInZone(createdAt, "Asia/Seoul");
  const rawObservation = safe.observation ?? {};
  const symbol = text(rawObservation.symbol, "observation.symbol");
  if (!/^[A-Za-z0-9._-]{1,40}$/u.test(symbol)) throw new TypeError("observation.symbol:INVALID_SYMBOL");
  const observation = {
    symbol,
    observedDate: dateOnly(rawObservation.observedDate, "observation.observedDate", true),
    observedAt: timestamp(rawObservation.observedAt, "observation.observedAt", true),
    referencePrice: positive(rawObservation.referencePrice, "observation.referencePrice", true),
    provenance: normalizeProvenance(rawObservation.provenance),
  };
  if (!Array.isArray(safe.inputs ?? [])) throw new TypeError("INPUTS_MUST_BE_ARRAY");
  const names = new Set();
  const inputs = (safe.inputs ?? []).map((raw) => {
    const name = text(raw.name, "input.name");
    if (names.has(name)) throw new TypeError("DUPLICATE_INPUT_NAME");
    names.add(name);
    const provenance = { ...(raw.provenance ?? {}), ...raw };
    return {
      name, value: raw.value ?? null, observedAt: timestamp(raw.observedAt, `${name}.observedAt`, true),
      ...normalizeProvenance(provenance),
      modelVersion: text(provenance.modelVersion, `${name}.modelVersion`, true),
      formulaHash: hash(provenance.formulaHash, `${name}.formulaHash`, true),
      seedHash: hash(provenance.seedHash, `${name}.seedHash`, true),
    };
  }).sort((a, b) => a.name.localeCompare(b.name, "en"));
  const additionalBlockers = unique((safe.blockers ?? []).map((reason) => text(reason, "blocker")));
  const blockers = [...provenanceReasons(observation.provenance, createdAt, "OBSERVATION")];
  if (!observation.observedDate) blockers.push("OBSERVATION:MISSING_DATE");
  if (!observation.observedAt) blockers.push("OBSERVATION:MISSING_OBSERVED_AT");
  if (!observation.referencePrice) blockers.push("OBSERVATION:MISSING_REFERENCE_PRICE");
  if (observation.observedDate && observation.observedDate > issuanceMarketDate) blockers.push("OBSERVATION:FUTURE_DATE");
  if (observation.observedAt && observation.observedAt > createdAt) blockers.push("OBSERVATION:OBSERVED_AFTER_ISSUANCE");
  if (observation.observedAt && observation.provenance.availableAt && observation.observedAt > observation.provenance.availableAt) blockers.push("OBSERVATION:OBSERVED_AFTER_AVAILABILITY");
  if (!inputs.length) blockers.push("INPUTS:MISSING");
  for (const input of inputs) {
    const prefix = `INPUT:${input.name}`;
    blockers.push(...provenanceReasons(input, createdAt, prefix));
    if (input.value === null) blockers.push(`${prefix}:MISSING_VALUE`);
    if (!input.observedAt) blockers.push(`${prefix}:MISSING_OBSERVED_AT`);
    if (input.observedAt && input.observedAt > createdAt) blockers.push(`${prefix}:OBSERVED_AFTER_ISSUANCE`);
    if (input.observedAt && input.availableAt && input.observedAt > input.availableAt) blockers.push(`${prefix}:OBSERVED_AFTER_AVAILABILITY`);
  }
  const timingBlockers = unique(blockers);
  const uniqueBlockers = unique([...blockers, ...additionalBlockers]);
  const record = {
    schemaVersion: SWING_FORECAST_VERSION,
    modelVersion: SWING_FORECAST_VERSION,
    status: "PREPARING",
    observationPolicyId: text(safe.observationPolicyId, "observationPolicyId", true),
    horizonTradingDays: SWING_HORIZON_TRADING_DAYS,
    createdAt,
    marketTimeZone: "Asia/Seoul",
    issuanceSemantics: "ACTUAL_PREPARATION_TIME_NOT_HISTORICAL_PREDICTION",
    observationMode: observation.observedDate && observation.observedDate < issuanceMarketDate ? "RETROSPECTIVE_OBSERVATION" : "CURRENT_OBSERVATION",
    observation,
    inputs,
    inputSemantics: "OBSERVED_FEATURES_NOT_PROBABILITIES",
    entryPolicy: ENTRY_POLICY,
    exitPolicy: EXIT_POLICY,
    predictions: { probabilityUp: null, expectedReturn: null, confidence: null },
    actualFill: null,
    netReturn: null,
    costs: { status: "UNRESOLVED", fees: null, taxes: null, slippage: null },
    additionalBlockers,
    eligibility: { eligible: false, forTraining: false, inputEligible: uniqueBlockers.length === 0, inputTimingEligible: timingBlockers.length === 0, timingBlockers, blockers: uniqueBlockers },
  };
  return freeze({ ...record, forecastHash: hashSwingContent(record) });
}

export function validateForecastRecord(record) {
  try {
    const safe = plainCopy(record);
    if (safe.schemaVersion !== SWING_FORECAST_VERSION || safe.modelVersion !== SWING_FORECAST_VERSION) return { valid: false, reasons: ["UNSUPPORTED_FORECAST_SCHEMA"] };
    hash(safe.forecastHash, "forecastHash");
    const expected = createPreparingForecast({ createdAt: safe.createdAt, observationPolicyId: safe.observationPolicyId, observation: safe.observation, inputs: safe.inputs, blockers: safe.additionalBlockers });
    if (hashSwingContent(safe) !== hashSwingContent(expected)) return { valid: false, reasons: ["FORECAST_HASH_OR_CONTRACT_MISMATCH"] };
    return { valid: true, reasons: [] };
  } catch (error) { return { valid: false, reasons: [error.message] }; }
}

function nextDate(date) {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + 1);
  return value.toISOString().slice(0, 10);
}

function dateInZone(instant, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(instant));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function calendarWindow(calendar, forecast, resolvedAt) {
  if (!calendar || calendar.status !== "CONFIRMED" || calendar.evidence !== "OFFICIAL_CALENDAR") return { reasons: ["CALENDAR:UNCONFIRMED"] };
  const provenance = normalizeProvenance(calendar);
  const reasons = provenanceReasons(provenance, resolvedAt, "CALENDAR");
  if (reasons.length) return { reasons };
  const timeZone = text(calendar.timeZone, "calendar.timeZone");
  if (timeZone !== forecast.marketTimeZone) return { reasons: ["CALENDAR:MARKET_TIME_ZONE_MISMATCH"] };
  const issueDate = dateInZone(forecast.createdAt, timeZone);
  const start = dateOnly(calendar.coverageStartDate, "calendar.coverageStartDate");
  const end = dateOnly(calendar.coverageEndDate, "calendar.coverageEndDate");
  if (start > issueDate || end < issueDate || start > end) return { reasons: ["CALENDAR:ISSUANCE_NOT_COVERED"] };
  if (!Array.isArray(calendar.dates)) return { reasons: ["CALENDAR:MISSING_DATES"] };
  const byDate = new Map();
  for (const raw of calendar.dates) {
    const date = dateOnly(raw.date, "calendar.date");
    if (byDate.has(date)) return { reasons: ["CALENDAR:DUPLICATE_DATE"] };
    byDate.set(date, raw);
  }
  const sessions = [];
  let previousClose = null;
  for (let date = issueDate; date <= end; date = nextDate(date)) {
    const day = byDate.get(date);
    if (!day || !["TRADING", "CLOSED"].includes(day.status)) return { reasons: [`CALENDAR:UNKNOWN_DATE:${date}`] };
    if (day.status === "CLOSED") continue;
    const openAt = timestamp(day.openAt, "calendar.openAt");
    const closeAt = timestamp(day.closeAt, "calendar.closeAt");
    if (openAt >= closeAt || dateInZone(openAt, timeZone) !== date || dateInZone(closeAt, timeZone) !== date || (previousClose && openAt <= previousClose)) return { reasons: ["CALENDAR:INVALID_SESSION_ORDER"] };
    previousClose = closeAt;
    if (openAt > forecast.createdAt) sessions.push({ date, openAt, closeAt });
    if (sessions.length === SWING_HORIZON_TRADING_DAYS) return { reasons: [], sessions, provenance };
  }
  return { reasons: ["CALENDAR:INSUFFICIENT_CONFIRMED_HORIZON"] };
}

/** Resolves a separate benchmark outcome; never edits or upgrades the forecast. */
export function resolveSwingOutcome(options) {
  const safe = plainCopy(options);
  const resolvedAt = timestamp(safe.resolvedAt, "resolvedAt");
  const forecast = safe.forecast;
  const validation = validateForecastRecord(forecast);
  let sessions = null;
  let usedPriceHashes = [];
  let calendarHash = null;
  let executionEvidenceHash = null;
  const result = (status, reasons, grossReturn = null, entryOpen = null, exitClose = null) => {
    const body = {
      schemaVersion: "swing5-outcome-v1", forecastHash: HASH.test(forecast?.forecastHash ?? "") ? forecast.forecastHash : null,
      resolvedAt, status, reasons: unique(reasons), horizonTradingDays: SWING_HORIZON_TRADING_DAYS,
      interpretation: "OBSERVATIONAL_OFFICIAL_PRICE_BENCHMARK_NOT_REALIZED_PNL", returnUnit: "DECIMAL",
      entryDate: sessions?.[0].date ?? null, entryAt: sessions?.[0].openAt ?? null,
      exitDate: sessions?.[4].date ?? null, exitAt: sessions?.[4].closeAt ?? null,
      officialEntryOpen: entryOpen, officialExitClose: exitClose, grossReturn,
      actualFill: null, executableReturn: null, netReturn: null,
      costs: { status: "UNRESOLVED", fees: null, taxes: null, slippage: null },
      forTraining: false, calendarHash, priceSourceHashes: unique(usedPriceHashes), executionEvidenceHash,
    };
    return freeze({ ...body, outcomeHash: hashSwingContent(body) });
  };
  if (!validation.valid) return result("BLOCKED", validation.reasons);
  if (resolvedAt < forecast.createdAt) return result("BLOCKED", ["RESOLUTION_BEFORE_ISSUANCE"]);
  if (!forecast.eligibility.inputTimingEligible) return result("BLOCKED", ["FORECAST_INPUTS_INELIGIBLE", ...forecast.eligibility.blockers]);
  try {
    const window = calendarWindow(safe.calendar, forecast, resolvedAt);
    if (window.reasons.length) return result("BLOCKED", window.reasons);
    sessions = window.sessions;
    calendarHash = hashSwingContent(safe.calendar);
    // No input whose availability follows entry is allowed, even in a tampered caller record.
    if ([forecast.observation.provenance, ...forecast.inputs].some((input) => !input.availableAt || input.availableAt >= sessions[0].openAt)) return result("BLOCKED", ["INPUT_NOT_AVAILABLE_BEFORE_ENTRY"]);
    if (resolvedAt < sessions[4].closeAt) return result("PENDING", ["HORIZON_NOT_MATURE"]);
    const execution = safe.executionEvidence;
    if (!execution || execution.status !== "CONFIRMED" || execution.entryExecutable !== true || execution.exitExecutable !== true || execution.adjustmentBasis !== "UNADJUSTED_NO_CORPORATE_ACTIONS") return result("BLOCKED", ["EXECUTION_OR_ADJUSTMENT_UNCONFIRMED"]);
    const executionProvenance = normalizeProvenance(execution);
    const executionReasons = provenanceReasons(executionProvenance, resolvedAt, "EXECUTION");
    if (executionReasons.length) return result("BLOCKED", executionReasons);
    if (execution.symbol !== forecast.observation.symbol || execution.entryDate !== sessions[0].date || execution.exitDate !== sessions[4].date) return result("BLOCKED", ["EXECUTION_EVIDENCE_SCOPE_MISMATCH"]);
    if (executionProvenance.availableAt < sessions[4].closeAt) return result("BLOCKED", ["EXECUTION_EVIDENCE_PRECEDES_EXIT"]);
    executionEvidenceHash = hashSwingContent(execution);
    if (!Array.isArray(safe.prices)) return result("BLOCKED", ["PRICES:MISSING"]);
    const selected = [];
    for (const session of sessions) {
      const rows = safe.prices.filter((row) => row.symbol === forecast.observation.symbol && row.date === session.date);
      if (rows.length !== 1) return result("BLOCKED", [`PRICE:${session.date}:${rows.length ? "DUPLICATE" : "MISSING"}`]);
      const row = rows[0];
      if (row.tradingStatus !== "TRADABLE") return result("BLOCKED", [`PRICE:${session.date}:NOT_CONFIRMED_TRADABLE`]);
      if (row.priceKind !== "OFFICIAL_DAILY_OHLC" || row.adjustmentBasis !== execution.adjustmentBasis) return result("BLOCKED", [`PRICE:${session.date}:UNCONFIRMED_PRICE_BASIS`]);
      const provenance = normalizeProvenance(row);
      const reasons = provenanceReasons(provenance, resolvedAt, `PRICE:${session.date}`);
      if (reasons.length) return result("BLOCKED", reasons);
      if (provenance.availableAt < session.closeAt) return result("BLOCKED", [`PRICE:${session.date}:AVAILABILITY_PRECEDES_CLOSE`]);
      positive(row.officialOpen, "price.officialOpen");
      positive(row.officialClose, "price.officialClose");
      usedPriceHashes.push(provenance.sourceHash);
      selected.push(row);
    }
    const entryOpen = selected[0].officialOpen;
    const exitClose = selected[4].officialClose;
    const grossReturn = (exitClose - entryOpen) / entryOpen;
    if (!Number.isFinite(grossReturn)) return result("BLOCKED", ["RETURN_NOT_FINITE"]);
    return result("OBSERVED", [], grossReturn, entryOpen, exitClose);
  } catch (error) { return result("BLOCKED", [error.message]); }
}

/** Integrity/contract validation. Re-supply original evidence for full deterministic verification. */
export function validateSwingOutcome(record, { forecast = null, evidence = null } = {}) {
  try {
    const safe = plainCopy(record);
    const keys = ["schemaVersion", "forecastHash", "resolvedAt", "status", "reasons", "horizonTradingDays", "interpretation", "returnUnit", "entryDate", "entryAt", "exitDate", "exitAt", "officialEntryOpen", "officialExitClose", "grossReturn", "actualFill", "executableReturn", "netReturn", "costs", "forTraining", "calendarHash", "priceSourceHashes", "executionEvidenceHash", "outcomeHash"];
    if (Object.keys(safe).sort().join("|") !== keys.sort().join("|")) throw new TypeError("OUTCOME_SCHEMA_FIELDS_MISMATCH");
    if (safe.schemaVersion !== "swing5-outcome-v1" || !["PENDING", "BLOCKED", "OBSERVED"].includes(safe.status) || safe.horizonTradingDays !== 5) throw new TypeError("UNSUPPORTED_OUTCOME_SCHEMA");
    const resolvedAt = timestamp(safe.resolvedAt, "resolvedAt");
    if (resolvedAt !== safe.resolvedAt) throw new TypeError("OUTCOME_NON_CANONICAL_TIMESTAMP");
    hash(safe.outcomeHash, "outcomeHash");
    hash(safe.forecastHash, "forecastHash");
    const body = { ...safe };
    delete body.outcomeHash;
    if (hashSwingContent(body) !== safe.outcomeHash) throw new TypeError("OUTCOME_HASH_MISMATCH");
    if (safe.interpretation !== "OBSERVATIONAL_OFFICIAL_PRICE_BENCHMARK_NOT_REALIZED_PNL" || safe.returnUnit !== "DECIMAL" || safe.forTraining !== false || safe.actualFill !== null || safe.executableReturn !== null || safe.netReturn !== null || hashSwingContent(safe.costs) !== hashSwingContent({ status: "UNRESOLVED", fees: null, taxes: null, slippage: null })) throw new TypeError("OUTCOME_CLAIM_NOT_ALLOWED");
    if (!Array.isArray(safe.reasons) || safe.reasons.some((reason) => typeof reason !== "string" || !reason) || !Array.isArray(safe.priceSourceHashes)) throw new TypeError("OUTCOME_INVALID_EVIDENCE");
    for (const value of safe.priceSourceHashes) hash(value, "priceSourceHash");
    hash(safe.calendarHash, "calendarHash", true);
    hash(safe.executionEvidenceHash, "executionEvidenceHash", true);
    const entryAt = timestamp(safe.entryAt, "entryAt", true), exitAt = timestamp(safe.exitAt, "exitAt", true);
    const entryDate = dateOnly(safe.entryDate, "entryDate", true), exitDate = dateOnly(safe.exitDate, "exitDate", true);
    if ([entryAt, exitAt, entryDate, exitDate].some((value) => value !== null) && (!entryAt || !exitAt || !entryDate || !exitDate || entryAt >= exitAt || entryDate >= exitDate)) throw new TypeError("OUTCOME_INVALID_WINDOW");
    if (entryAt && (dateInZone(entryAt, "Asia/Seoul") !== entryDate || dateInZone(exitAt, "Asia/Seoul") !== exitDate)) throw new TypeError("OUTCOME_SESSION_DATE_MISMATCH");
    if (safe.status === "OBSERVED") {
      positive(safe.officialEntryOpen, "officialEntryOpen");
      positive(safe.officialExitClose, "officialExitClose");
      if (!exitAt || resolvedAt < exitAt || safe.reasons.length || !safe.calendarHash || !safe.executionEvidenceHash || !safe.priceSourceHashes.length || safe.grossReturn !== (safe.officialExitClose - safe.officialEntryOpen) / safe.officialEntryOpen) throw new TypeError("OUTCOME_INVALID_OBSERVATION");
    } else if (safe.grossReturn !== null || safe.officialEntryOpen !== null || safe.officialExitClose !== null || !safe.reasons.length) throw new TypeError("UNRESOLVED_OUTCOME_HAS_RETURN");
    if (safe.status === "PENDING" && (!exitAt || resolvedAt >= exitAt)) throw new TypeError("OUTCOME_INVALID_PENDING");
    if (forecast) {
      if (!validateForecastRecord(forecast).valid || forecast.forecastHash !== safe.forecastHash || resolvedAt < forecast.createdAt || (entryAt && entryAt <= forecast.createdAt)) throw new TypeError("OUTCOME_FORECAST_MISMATCH");
      if (safe.status === "OBSERVED" && !forecast.eligibility.inputTimingEligible) throw new TypeError("OUTCOME_INELIGIBLE_FORECAST");
    }
    if (evidence) {
      if (!forecast) throw new TypeError("FORECAST_REQUIRED_FOR_EVIDENCE_VERIFICATION");
      const rebuilt = resolveSwingOutcome({ ...plainCopy(evidence), forecast, resolvedAt });
      if (hashSwingContent(rebuilt) !== hashSwingContent(safe)) throw new TypeError("OUTCOME_EVIDENCE_MISMATCH");
    }
    return { valid: true, reasons: [], evidenceVerified: evidence !== null && forecast !== null };
  } catch (error) { return { valid: false, reasons: [error.message], evidenceVerified: false }; }
}

/**
 * Whole-observation-date chronological groups. Unsafe training groups are purged,
 * never split by ticker. No model fitting occurs here. Intervals are inclusive.
 * Rows require id, observedDate, labelStartAt, labelEndAt, labelAvailableAt,
 * inputsAvailableAt, and createdAt. Test labels may become available later.
 */
export function createPurgedChronologicalSplit(options) {
  const safe = plainCopy(options);
  const cutoff = timestamp(safe.trainingCutoff, "trainingCutoff");
  const testStartDate = dateOnly(safe.testStartDate, "testStartDate");
  const testEndDate = dateOnly(safe.testEndDate, "testEndDate");
  if (testStartDate > testEndDate || dateInZone(cutoff, "Asia/Seoul") >= testStartDate) throw new TypeError("NON_CHRONOLOGICAL_SPLIT");
  if (!Array.isArray(safe.rows)) throw new TypeError("ROWS_MUST_BE_ARRAY");
  const groups = new Map(), ids = new Set();
  for (const input of safe.rows) {
    const id = text(input.id, "row.id");
    if (ids.has(id)) throw new TypeError("DUPLICATE_ROW_ID");
    ids.add(id);
    const row = { ...input, id,
      observedDate: dateOnly(input.observedDate, "row.observedDate"),
      createdAt: timestamp(input.createdAt, "row.createdAt"),
      labelStartAt: timestamp(input.labelStartAt, "row.labelStartAt"),
      labelEndAt: timestamp(input.labelEndAt, "row.labelEndAt"),
      labelAvailableAt: timestamp(input.labelAvailableAt, "row.labelAvailableAt"),
      inputsAvailableAt: timestamp(input.inputsAvailableAt, "row.inputsAvailableAt"),
    };
    if (row.inputsAvailableAt > row.createdAt || row.labelStartAt <= row.createdAt || row.labelStartAt <= row.inputsAvailableAt || row.labelEndAt < row.labelStartAt || row.labelAvailableAt < row.labelEndAt) throw new TypeError("INVALID_LABEL_WINDOW_OR_AVAILABILITY");
    if (row.observedDate > dateInZone(row.createdAt, "Asia/Seoul")) throw new TypeError("OBSERVATION_AFTER_ISSUANCE");
    groups.set(row.observedDate, [...(groups.get(row.observedDate) ?? []), row]);
  }
  const ordered = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  const testGroups = ordered.filter(([date]) => date >= testStartDate && date <= testEndDate);
  const test = testGroups.flatMap(([, rows]) => rows.sort((a, b) => a.id.localeCompare(b.id)));
  if (!test.length) throw new TypeError("EMPTY_TEST_SET");
  if (test.some((row) => row.createdAt <= cutoff || row.labelStartAt <= cutoff)) throw new TypeError("TEST_PRECEDES_TRAINING_CUTOFF");
  const train = [], purged = [], excluded = [];
  for (const [date, rows] of ordered) {
    rows.sort((a, b) => a.id.localeCompare(b.id));
    if (date >= testStartDate) {
      if (date > testEndDate) excluded.push(...rows.map((row) => ({ id: row.id, observedDate: date, reasons: ["OUTSIDE_TEST_WINDOW"] })));
      continue;
    }
    const reasons = [];
    if (rows.some((row) => row.createdAt > cutoff || row.inputsAvailableAt > cutoff || row.labelAvailableAt > cutoff || row.labelEndAt > cutoff)) reasons.push("AVAILABLE_AFTER_TRAINING_CUTOFF");
    if (rows.some((row) => test.some((heldOut) => row.labelStartAt <= heldOut.labelEndAt && row.labelEndAt >= heldOut.labelStartAt))) reasons.push("OVERLAPPING_TRAIN_TEST_LABEL_WINDOW");
    if (reasons.length) purged.push(...rows.map((row) => ({ id: row.id, observedDate: date, reasons: unique(reasons) })));
    else train.push(...rows.sort((a, b) => a.id.localeCompare(b.id)));
  }
  return freeze({ strategy: "PURGED_CHRONOLOGICAL_WHOLE_DATE_GROUPS", trainingCutoff: cutoff, testStartDate, testEndDate, train, test, purged, excluded, trainingDateGroups: unique(train.map((row) => row.observedDate)), testDateGroups: unique(test.map((row) => row.observedDate)), independentUnit: "OBSERVATION_DATE_NOT_TICKER_ROW", forTraining: false });
}
