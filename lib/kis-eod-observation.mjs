import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { sha256Canonical } from "./snapshot-quality-pipeline.mjs";
import { getKisEodLocalClock } from "../scripts/run-kis-eod.mjs";

export const KIS_EOD_OBSERVATION_TICKERS = Object.freeze(["005930", "000660", "064290"]);
export const KIS_EOD_OBSERVATION_SLOTS = Object.freeze(["15:40", "16:10", "16:40"]);
export const KIS_EOD_OBSERVATION_START_WINDOW_MS = 5 * 60_000;
export const KIS_EOD_OBSERVATION_STATUSES = Object.freeze(["DRY_RUN_READY", "READY", "OBSERVED", "PARTIAL", "FAILED", "PENDING", "BLOCKED", "SKIPPED"]);
export const KIS_EOD_OBSERVATION_REASONS = Object.freeze(["PLAN_ONLY", "OBSERVATION_NOT_ENABLED", "INVALID_CLI_ARGUMENTS", "INVALID_SLOT", "WEEKEND", "BEFORE_MARKET_CLOSE", "BEFORE_SLOT", "MISSED_SLOT_WINDOW", "REFERENCE_DATE_CHANGED", "MARKET_CLOSED", "CALENDAR_UNKNOWN", "CALENDAR_REQUEST_FAILED", "SLOT_LOCKED", "ALREADY_OBSERVED", "PRIVATE_OBSERVATION_COMPLETE", "PARTIAL_OBSERVATION_RETRY_REQUIRED", "NO_SOURCE_OBSERVATIONS", "PRIVATE_STORAGE_FAILED", "UNEXPECTED_FAILURE"]);
const SOURCE_OPERATION = "inquire-daily-itemchartprice";
const ROW_FIELDS = Object.freeze(["basDt", "srtnCd", "mkp", "hipr", "lopr", "clpr", "trqu", "trPrc", "fltRt", "observationStatus"]);
const OPTIONAL_NUMBER_FIELDS = ["trPrc", "fltRt"];
const SOURCE_REASONS = new Set(["KIS_EOD_REQUEST_FAILED", "KIS_EOD_TIMEOUT", "KIS_EOD_NETWORK_ERROR", "KIS_EOD_RATE_LIMITED", "KIS_EOD_UPSTREAM_FAILURE", "KIS_EOD_AUTHORIZATION_FAILED", "KIS_EOD_HTTP_REJECTED", "KIS_EOD_INVALID_JSON", "KIS_EOD_BUSINESS_FAILED", "KIS_EOD_AUTHENTICATION_FAILED", "KIS_EOD_RESPONSE_INVALID", "KIS_EOD_SYMBOL_MISMATCH", "KIS_EOD_ROW_OUTSIDE_REQUEST_RANGE", "KIS_EOD_DUPLICATE_DATE", "KIS_EOD_REFERENCE_DATE_MISSING", "KIS_EOD_NUMBER_MISSING", "KIS_EOD_NUMBER_INVALID", "KIS_EOD_OHLCV_INVALID", "KIS_EOD_ADJUSTMENT_METADATA_INVALID", "KIS_EOD_DATE_INVALID", "KIS_EOD_DATE_RANGE_INVALID", "KIS_EOD_OBSERVATION_HISTORY_INVALID"]);
const safeCode = (value, fallback = "KIS_EOD_OBSERVATION_SOURCE_FAILED") => SOURCE_REASONS.has(value) ? value : fallback;
const clock = (now) => {
  const instant = new Date(typeof now === "function" ? now() : now);
  if (!Number.isFinite(instant.getTime())) throw new Error("KIS_EOD_OBSERVATION_CLOCK_INVALID");
  return instant;
};
const validTimestamp = (value) => typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const slotInstant = (referenceDate, slot) => new Date(`${referenceDate}T${slot}:00+09:00`);
const safeResult = (local, instant, slot, status, reason, detail = {}) => ({
  status, reason, referenceDate: local.referenceDate, slot, checkedAt: instant.toISOString(), timezone: "Asia/Seoul",
  sourceFinality: "NOT_CONFIRMED", publicationEligible: false, productionChanged: false, ...detail,
});

export function getKisEodObservationWindow(now, slot) {
  const instant = clock(now), local = getKisEodLocalClock(instant);
  if (!KIS_EOD_OBSERVATION_SLOTS.includes(slot)) return safeResult(local, instant, slot, "BLOCKED", "INVALID_SLOT");
  const plannedAt = slotInstant(local.referenceDate, slot), delayMs = instant.getTime() - plannedAt.getTime();
  const details = { plannedAt: plannedAt.toISOString(), startWindowEndsAt: new Date(plannedAt.getTime() + KIS_EOD_OBSERVATION_START_WINDOW_MS).toISOString(), delayMs };
  const reason = local.weekend ? "WEEKEND" : local.time < "15:30:00" ? "BEFORE_MARKET_CLOSE" : delayMs < 0 ? "BEFORE_SLOT" : delayMs >= KIS_EOD_OBSERVATION_START_WINDOW_MS ? "MISSED_SLOT_WINDOW" : null;
  return safeResult(local, instant, slot, reason ? "PENDING" : "READY", reason, details);
}

// Preserve only documented transport diagnostics. No URLs, messages, headers,
// token values or response bodies ever enter operational telemetry.
export function sanitizeKisEodObservationEvent(event) {
  if (event?.component !== "kis-eod-provider" || ![SOURCE_OPERATION, "chk-holiday"].includes(event.operation)
    || !["SUCCESS", "ATTEMPT_FAILURE", "RETRYABLE_FAILURE"].includes(event.status)) return null;
  return {
    component: "kis-eod-provider", operation: event.operation, status: event.status,
    reason: event.status === "SUCCESS" ? null : safeCode(event.reason),
    attempt: Number.isInteger(event.attempt) && event.attempt >= 1 && event.attempt <= 3 ? event.attempt : null,
    requestStartedAt: validTimestamp(event.requestStartedAt) ? event.requestStartedAt : null,
    receivedAt: validTimestamp(event.receivedAt) ? event.receivedAt : null,
    durationMs: Number.isFinite(event.durationMs) && event.durationMs >= 0 ? event.durationMs : null,
    httpStatus: Number.isInteger(event.httpStatus) && event.httpStatus >= 100 && event.httpStatus <= 599 ? event.httpStatus : null,
    businessCode: ["SUCCESS", "EGW00201", "OTHER_BUSINESS_ERROR"].includes(event.businessCode) ? event.businessCode : null,
  };
}

async function privateDirectory(root, ...segments) {
  const base = path.resolve(root, ".runtime", "kis-eod", "observations");
  const target = path.resolve(base, ...segments);
  if (target !== base && !target.startsWith(`${base}${path.sep}`)) throw new Error("KIS_EOD_OBSERVATION_PRIVATE_PATH_INVALID");
  const actualRoot = await fs.realpath(root);
  // Validate each parent before creating anything below it. A redirected private
  // namespace must not cause even a directory write outside the requested root.
  let current = root;
  for (const segment of [".runtime", "kis-eod", "observations", ...segments]) {
    current = path.join(current, segment);
    try { await fs.mkdir(current); } catch (error) { if (error?.code !== "EEXIST") throw error; }
    const info = await fs.lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("KIS_EOD_OBSERVATION_PRIVATE_PATH_INVALID");
  }
  // Reject symlink redirection of the private namespace, including its parents.
  const actualTarget = await fs.realpath(target);
  if (actualTarget !== path.resolve(actualRoot, ".runtime", "kis-eod", "observations", ...segments)) throw new Error("KIS_EOD_OBSERVATION_PRIVATE_PATH_INVALID");
  return target;
}
async function readJson(target) {
  try {
    if ((await fs.lstat(target)).isSymbolicLink()) throw new Error("KIS_EOD_OBSERVATION_SYMLINK_REJECTED");
    return JSON.parse(await fs.readFile(target, "utf8"));
  } catch (error) { if (error?.code === "ENOENT") return null; throw error; }
}
const bodyHash = (artifact) => {
  const { artifactHash: omitted, ...identity } = artifact;
  void omitted;
  return sha256Canonical(identity);
};
async function completedObservation(directory) {
  const marker = await readJson(path.join(directory, "completed.json"));
  if (marker === null) return null;
  if (!/^[0-9TZ.-]+-[a-f0-9]{64}[.]json$/u.test(marker.artifactFile ?? "")) throw new Error("KIS_EOD_OBSERVATION_MARKER_INVALID");
  const artifact = await readJson(path.join(directory, marker.artifactFile));
  if (!artifact || artifact.status !== "OBSERVED" || artifact.artifactHash !== marker.artifactHash || bodyHash(artifact) !== marker.artifactHash) throw new Error("KIS_EOD_OBSERVATION_IMMUTABLE_CONFLICT");
  return artifact;
}

function calendarValid(evidence, referenceDate, checkedAt) {
  const fields = evidence?.sourceFields;
  const flagsValid = fields?.bass_dt === referenceDate.replaceAll("-", "") && ["Y", "N"].includes(fields.opnd_yn) && ["Y", "N"].includes(fields.tr_day_yn);
  const expected = flagsValid && (fields.opnd_yn === "Y" && fields.tr_day_yn === "Y" ? true : fields.opnd_yn === "N" && fields.tr_day_yn === "N" ? false : null);
  return flagsValid && evidence?.source === "KIS" && evidence.operation === "chk-holiday" && evidence.referenceDate === referenceDate
    && evidence.isTradingDay === expected && validTimestamp(evidence.receivedAt) && Date.parse(evidence.receivedAt) <= checkedAt.getTime()
    && getKisEodLocalClock(evidence.receivedAt).referenceDate === referenceDate;
}
async function observationCalendar({ root, provider, referenceDate, now }) {
  const directory = await privateDirectory(root, "calendar"), target = path.join(directory, `${referenceDate}.json`);
  const cached = await readJson(target);
  if (cached !== null) {
    if (!calendarValid(cached, referenceDate, clock(now))) throw new Error("KIS_EOD_OBSERVATION_CALENDAR_INVALID");
    return cached;
  }
  const response = await provider.getTradingDay(referenceDate);
  const evidence = { source: response?.source, operation: response?.operation, referenceDate: response?.referenceDate,
    isTradingDay: response?.isTradingDay, receivedAt: response?.receivedAt,
    sourceFields: { bass_dt: response?.sourceFields?.bass_dt, opnd_yn: response?.sourceFields?.opnd_yn, tr_day_yn: response?.sourceFields?.tr_day_yn },
    finality: "CALENDAR_ONLY_NOT_BAR_FINALITY" };
  if (!calendarValid(evidence, referenceDate, clock(now))) throw new Error("KIS_EOD_OBSERVATION_CALENDAR_INVALID");
  await fs.writeFile(target, `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx" });
  return evidence;
}

function normalizeHistory(response, ticker, referenceDate, collectionRequestedAt, handlerReceivedAt) {
  const invalid = () => { const error = new Error("KIS_EOD_OBSERVATION_HISTORY_INVALID"); error.code = error.message; throw error; };
  if (response?.source !== "KIS" || response.sourceOperation !== SOURCE_OPERATION || response.referenceDate !== referenceDate
    || response.adjustment !== "unadjusted" || response.priceBasis !== "kisDailyBarUnadjusted" || response.marketDivision !== "J"
    || !Array.isArray(response.rows) || response.rows.length < 1 || response.rows.length > 260 || !validTimestamp(response.receivedAt)) invalid();
  const requestedAt = response.requestedAt ?? collectionRequestedAt;
  if (!validTimestamp(requestedAt) || Date.parse(requestedAt) < Date.parse(collectionRequestedAt) || Date.parse(response.receivedAt) < Date.parse(requestedAt)
    || Date.parse(response.receivedAt) > Date.parse(handlerReceivedAt) || getKisEodLocalClock(requestedAt).referenceDate !== referenceDate
    || getKisEodLocalClock(requestedAt).time < "15:30:00" || getKisEodLocalClock(response.receivedAt).referenceDate !== referenceDate) invalid();
  const seen = new Set();
  const rows = response.rows.map((row) => {
    if (!/^[0-9]{8}$/u.test(row?.basDt ?? "") || seen.has(row.basDt) || row.basDt > referenceDate.replaceAll("-", "") || row.srtnCd !== ticker
      || !["mkp", "hipr", "lopr", "clpr", "trqu"].every((key) => Number.isFinite(row[key]) && row[key] >= 0)
      || row.clpr <= 0 || !Number.isSafeInteger(row.trqu) || OPTIONAL_NUMBER_FIELDS.some((key) => row[key] !== null && row[key] !== undefined && !Number.isFinite(row[key]))
      || !["trading", "tradingHaltOrNoTrade"].includes(row.observationStatus)) invalid();
    const iso = `${row.basDt.slice(0, 4)}-${row.basDt.slice(4, 6)}-${row.basDt.slice(6, 8)}`;
    if (new Date(`${iso}T00:00:00Z`).toISOString().slice(0, 10) !== iso) invalid();
    seen.add(row.basDt);
    return Object.fromEntries(ROW_FIELDS.map((key) => [key, row[key] ?? null]));
  }).sort((left, right) => right.basDt.localeCompare(left.basDt));
  if (rows[0].basDt !== referenceDate.replaceAll("-", "")) invalid();
  const metadataEntries = (entries, keys) => (entries ?? []).map((entry) => Object.fromEntries(keys.map((key) => {
    const value = entry[key] ?? null;
    if (value !== null && !(typeof value === "number" && Number.isFinite(value)) && !(typeof value === "string" && /^[0-9A-Z._-]{1,24}$/u.test(value))) invalid();
    return [key, value];
  }))).sort((left, right) => String(right.date).localeCompare(String(left.date)));
  const adjustmentMetadata = metadataEntries(response.adjustmentMetadata, ["date", "exDividendCode", "splitRatio", "changed", "reevaluationReason"]);
  const dailyChangeMetadata = metadataEntries(response.dailyChangeMetadata, ["date", "reportedDifference", "reportedSign"]);
  const metadata = { ticker, referenceDate, source: "KIS", sourceOperation: SOURCE_OPERATION, marketDivision: "J", adjustment: "unadjusted", adjustmentFlag: "1", priceBasis: "kisDailyBarUnadjusted",
    sourceFinality: "NOT_CONFIRMED", dateFieldComplete: true, referenceDatePresent: true, historyRowsAvailable: rows.length, historyComplete: rows.length >= 260,
    referenceFieldsPresent: Object.fromEntries(ROW_FIELDS.map((key) => [key, rows[0][key] !== null])),
    symbolMapping: { requestedCode: ticker, responseCode: response.symbolMapping?.responseCode === ticker ? ticker : null,
      status: response.symbolMapping?.responseCode === ticker ? "VERIFIED_RESPONSE_TICKER" : "UNVERIFIED_RESPONSE_TICKER_ABSENT" } };
  return { ticker, status: "SUCCESS", requestedAt, receivedAt: response.receivedAt, collectionRequestedAt, handlerReceivedAt,
    // Provider invocation precedes throttle/retry. Actual HTTP timestamps are
    // retained separately in each sanitized requestEvent, not invented here.
    requestTimestampBasis: response.requestedAt ? "PROVIDER_HISTORY_INVOCATION" : "CALLER_INVOCATION_ONLY", durationMs: Date.parse(handlerReceivedAt) - Date.parse(collectionRequestedAt),
    metadata, metadataHash: sha256Canonical(metadata), dataHash: sha256Canonical({ rows, adjustmentMetadata, dailyChangeMetadata }), rows, adjustmentMetadata, dailyChangeMetadata };
}

function requestSummary(events) {
  const attempts = events.filter((event) => event.status !== "RETRYABLE_FAILURE");
  return { attempts: attempts.length, successfulAttempts: attempts.filter((event) => event.status === "SUCCESS").length,
    failedAttempts: attempts.filter((event) => event.status === "ATTEMPT_FAILURE").length, retryableFailures: events.filter((event) => event.status === "RETRYABLE_FAILURE").length,
    http429: attempts.filter((event) => event.httpStatus === 429).length,
    rateLimitBusinessFailures: attempts.filter((event) => event.businessCode === "EGW00201").length };
}

export async function collectKisEodObservation({ root = process.cwd(), slot, now = () => new Date(), provider, telemetry = [] } = {}) {
  const start = clock(now), window = getKisEodObservationWindow(start, slot), local = getKisEodLocalClock(start);
  if (KIS_EOD_OBSERVATION_SLOTS.includes(slot)) {
    // Completed slots remain idempotent even when revisited after their window.
    // This precheck never creates a directory for an unobserved/missed slot.
    const existing = path.resolve(root, ".runtime", "kis-eod", "observations", local.referenceDate, slot.replace(":", ""));
    try {
      const actual = await fs.realpath(existing), actualRoot = await fs.realpath(root);
      if (actual !== path.resolve(actualRoot, ".runtime", "kis-eod", "observations", local.referenceDate, slot.replace(":", ""))) throw new Error("KIS_EOD_OBSERVATION_PRIVATE_PATH_INVALID");
      if (await completedObservation(existing)) return safeResult(local, start, slot, "SKIPPED", "ALREADY_OBSERVED", { delayMs: window.delayMs, collectedCount: 3 });
    } catch (error) { if (error?.code !== "ENOENT") return safeResult(local, start, slot, "FAILED", "PRIVATE_STORAGE_FAILED"); }
  }
  if (window.reason) return window;
  const referenceDate = local.referenceDate, slotDirectoryName = slot.replace(":", "");
  let directory, lockHandle;
  try {
    directory = await privateDirectory(root, referenceDate, slotDirectoryName);
    const completed = await completedObservation(directory);
    if (completed) return safeResult(local, start, slot, "SKIPPED", "ALREADY_OBSERVED", { delayMs: window.delayMs, collectedCount: 3 });
    try { lockHandle = await fs.open(path.join(directory, "active.lock"), "wx"); }
    catch (error) { if (error?.code === "EEXIST") return safeResult(local, start, slot, "PENDING", "SLOT_LOCKED", { delayMs: window.delayMs }); throw error; }
    // Recheck after acquiring the lock; another process may have just completed.
    if (await completedObservation(directory)) return safeResult(local, start, slot, "SKIPPED", "ALREADY_OBSERVED", { delayMs: window.delayMs, collectedCount: 3 });
    const attemptId = randomUUID(), attemptTelemetryStart = telemetry.length;
    let calendarEvidence = null, status = "FAILED", reason = "CALENDAR_REQUEST_FAILED";
    const observations = [];
    try { calendarEvidence = await observationCalendar({ root, provider, referenceDate, now }); }
    catch { /* Persist the safe failed attempt; it may be retried within the window. */ }
    if (calendarEvidence) {
      if (calendarEvidence.isTradingDay !== true) {
        status = "PENDING"; reason = calendarEvidence.isTradingDay === false ? "MARKET_CLOSED" : "CALENDAR_UNKNOWN";
      } else {
        for (const ticker of KIS_EOD_OBSERVATION_TICKERS) {
          const current = clock(now), currentWindow = getKisEodObservationWindow(current, slot);
          if (currentWindow.referenceDate !== referenceDate || currentWindow.reason) {
            observations.push({ ticker, status: "PENDING", reason: currentWindow.referenceDate !== referenceDate ? "REFERENCE_DATE_CHANGED" : currentWindow.reason });
            continue;
          }
          const collectionRequestedAt = current.toISOString(), firstEvent = telemetry.length;
          try {
            const response = await provider.getHistory(ticker, referenceDate, { adjustment: "unadjusted", requiredRows: 260, maxPages: 5 });
            observations.push({ ...normalizeHistory(response, ticker, referenceDate, collectionRequestedAt, clock(now).toISOString()),
              requestEvents: telemetry.slice(firstEvent).map(sanitizeKisEodObservationEvent).filter(Boolean) });
          } catch (error) {
            observations.push({ ticker, status: "FAILED", reason: safeCode(error?.code), requestedAt: collectionRequestedAt, receivedAt: clock(now).toISOString(),
              requestEvents: telemetry.slice(firstEvent).map(sanitizeKisEodObservationEvent).filter(Boolean) });
          }
        }
        const successful = observations.filter((entry) => entry.status === "SUCCESS").length;
        status = successful === 3 ? "OBSERVED" : successful ? "PARTIAL" : "FAILED";
        reason = successful === 3 ? "PRIVATE_OBSERVATION_COMPLETE" : successful ? "PARTIAL_OBSERVATION_RETRY_REQUIRED" : "NO_SOURCE_OBSERVATIONS";
      }
    }
    const completedAt = clock(now).toISOString();
    if (getKisEodLocalClock(completedAt).referenceDate !== referenceDate) { status = "FAILED"; reason = "REFERENCE_DATE_CHANGED"; }
    const previousSlot = KIS_EOD_OBSERVATION_SLOTS[KIS_EOD_OBSERVATION_SLOTS.indexOf(slot) - 1];
    let previous = null;
    if (previousSlot) previous = await completedObservation(await privateDirectory(root, referenceDate, previousSlot.replace(":", "")));
    const comparisons = observations.filter((entry) => entry.status === "SUCCESS").map((entry) => {
      const prior = previous?.observations.find((value) => value.ticker === entry.ticker && value.status === "SUCCESS");
      return { ticker: entry.ticker, previousSlot: previousSlot ?? null, previousArtifactHash: previous?.artifactHash ?? null,
        status: prior ? entry.dataHash === prior.dataHash ? "UNCHANGED" : "CHANGED" : "NO_PRIOR_OBSERVATION",
        previousDataHash: prior?.dataHash ?? null, dataHash: entry.dataHash,
        metadataChanged: prior ? entry.metadataHash !== prior.metadataHash : null };
    });
    const requestEvents = telemetry.slice(attemptTelemetryStart).map(sanitizeKisEodObservationEvent).filter(Boolean);
    const artifact = { schemaVersion: 1, namespace: "kis-eod-private-slot-observation", attemptId, referenceDate, slot, status, reason,
      plannedAt: window.plannedAt, startWindowEndsAt: window.startWindowEndsAt, observedStartedAt: start.toISOString(), completedAt, startDelayMs: window.delayMs,
      sourceFinality: "NOT_CONFIRMED", observationType: "ACTUAL_CLOCK_SLOT_COLLECTION", publicationEligible: false, productionChanged: false,
      calendarEvidence, observations, comparisons, requestEvents, requestSummary: requestSummary(requestEvents) };
    artifact.artifactHash = bodyHash(artifact);
    const artifactFile = `${start.toISOString().replaceAll(":", "-")}-${artifact.artifactHash}.json`;
    await fs.writeFile(path.join(directory, artifactFile), `${JSON.stringify(artifact, null, 2)}\n`, { flag: "wx" });
    if (status === "OBSERVED") await fs.writeFile(path.join(directory, "completed.json"), `${JSON.stringify({ artifactFile, artifactHash: artifact.artifactHash }, null, 2)}\n`, { flag: "wx" });
    return safeResult(local, start, slot, status, reason, { observedStartedAt: start.toISOString(), completedAt, delayMs: window.delayMs,
      collectedCount: observations.filter((entry) => entry.status === "SUCCESS").length, failedCount: observations.filter((entry) => entry.status === "FAILED").length,
      pendingCount: observations.filter((entry) => entry.status === "PENDING").length,
      changedCount: comparisons.filter((entry) => entry.status === "CHANGED").length, unchangedCount: comparisons.filter((entry) => entry.status === "UNCHANGED").length,
      missingPriorCount: comparisons.filter((entry) => entry.status === "NO_PRIOR_OBSERVATION").length, requestSummary: artifact.requestSummary });
  } catch { return safeResult(local, start, slot, "FAILED", "PRIVATE_STORAGE_FAILED"); }
  finally {
    if (lockHandle) { await lockHandle.close().catch(() => {}); await fs.unlink(path.join(directory, "active.lock")).catch(() => {}); }
  }
}
