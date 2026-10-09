import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { loadKisEodInputs, getKisEodLocalClock } from "./run-kis-eod.mjs";
import { createKisTokenManager } from "../lib/kis-token-manager-core.mjs";
import { createKisApiClient } from "../lib/kis-api-client-core.mjs";
import { createKisEodProvider } from "../lib/kis-eod-provider.mjs";
import { validateKisEodInputHistory, deriveKisEodInputChangeRate, KIS_EOD_MODEL_VERSIONS } from "../lib/kis-eod-pipeline.mjs";
import { normalizeModelInputRows, MODEL_HISTORY_REQUIREMENTS } from "../lib/market-data-quality-validator.mjs";
import { calculateEligibleSnapshotModels } from "../lib/model-score-engine.mjs";
import { sha256Canonical } from "../lib/snapshot-quality-pipeline.mjs";

const fail = (code) => { throw Object.assign(new Error(code), { code }); };
const safeReason = (error) => /^KIS_[A-Z0-9_]{1,80}$/u.test(error?.code ?? "") ? error.code : "KIS_EOD_AUDIT_FAILURE";
const clock = (now) => {
  const value = new Date(now());
  if (!Number.isFinite(value.getTime())) fail("KIS_EOD_AUDIT_CLOCK_INVALID");
  return value;
};
function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/u.test(value ?? "") && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}
const scoresOf = (models) => ({ "A-v1": models.modelA?.finalTechnicalScore ?? null, "A-v2": models.modelAV2?.finalScore ?? null,
  "B-v1": models.modelB?.trendStrength ?? null, "C-v1": models.modelC?.entryStrength ?? null, "D-v1": models.modelD ?? null });
const isQuarantined = (record) => record?.qualityEligibility?.status === "quarantined" || Boolean(record?.qualityEligibility?.exclusions?.length);
const summaryTimes = (values) => ({ count: values.length, meanMs: values.length ? Math.round(values.reduce((total, value) => total + value, 0) / values.length) : null, maxMs: values.length ? Math.max(...values) : null });
const counts = (values) => values.reduce((result, value) => { result[value] = (result[value] ?? 0) + 1; return result; }, {});
export const KIS_EOD_AUDIT_VALIDATION_VERSION = "kis-eod-private-audit-v1";

// Reuses the existing provisional checks and the unchanged score engine. A later
// historical request is RESEARCH, never a simulated close-time LIVE observation.
export function evaluateKisEodAuditHistory(history, referenceDate, quarantined = false, expectedCode = history?.code) {
  const rows = history?.rows ?? [];
  const inputFailure = validateKisEodInputHistory(rows, referenceDate, history, "unadjusted");
  const proofFailure = history?.source !== "KIS" || history?.adjustment !== "unadjusted" || history?.priceBasis !== "kisDailyBarUnadjusted"
    || history?.sourceOperation !== "inquire-daily-itemchartprice" || history?.marketDivision !== "J" || history?.referenceDate !== referenceDate
    || !Number.isFinite(Date.parse(history?.requestedAt)) || !Number.isFinite(Date.parse(history?.receivedAt)) || Date.parse(history.requestedAt) > Date.parse(history.receivedAt)
    || history?.code !== expectedCode || rows.some((row) => row.srtnCd !== expectedCode)
    || history?.symbolMapping?.status !== "VERIFIED_RESPONSE_TICKER" || history.symbolMapping.requestedCode !== expectedCode || history.symbolMapping.responseCode !== expectedCode
    ? "sourceProvenanceUnverified" : null;
  const normalized = inputFailure ? [] : normalizeModelInputRows(rows);
  const rate = deriveKisEodInputChangeRate(normalized);
  if (normalized.length && Number.isFinite(rate.value)) normalized[0] = { ...normalized[0], fltRt: rate.value };
  const commonReason = quarantined ? "officialQuarantinePreserved" : inputFailure ?? proofFailure ?? (normalized.length >= 34 && !Number.isFinite(rate.value) ? "dailyChangeRateMissing" : null);
  const eligibility = Object.fromEntries(KIS_EOD_MODEL_VERSIONS.map((version) => [version, !commonReason && normalized.length >= MODEL_HISTORY_REQUIREMENTS[version]]));
  const exclusions = Object.fromEntries(KIS_EOD_MODEL_VERSIONS.map((version) => [version, eligibility[version] ? null : commonReason ?? "insufficientHistory"]));
  let scores = Object.fromEntries(KIS_EOD_MODEL_VERSIONS.map((version) => [version, null]));
  let rawAV2Score = null;
  let deterministic = null;
  if (Object.values(eligibility).some(Boolean)) {
    try {
      const first = calculateEligibleSnapshotModels(normalized.slice(0, 260), eligibility);
      const second = calculateEligibleSnapshotModels(normalized.slice(0, 260), eligibility);
      deterministic = sha256Canonical(first) === sha256Canonical(second);
      scores = scoresOf(first);
      rawAV2Score = first.modelAV2?.rawScore ?? null;
      for (const version of KIS_EOD_MODEL_VERSIONS) if (eligibility[version] && (!deterministic || !Number.isFinite(scores[version]))) {
        eligibility[version] = false; scores[version] = null; exclusions[version] = deterministic ? "modelResultNotFinite" : "nonDeterministicModelResult";
      }
    } catch {
      for (const version of KIS_EOD_MODEL_VERSIONS) { eligibility[version] = false; exclusions[version] = "modelCalculationFailed"; }
      scores = Object.fromEntries(KIS_EOD_MODEL_VERSIONS.map((version) => [version, null]));
      deterministic = false;
    }
  }
  return { rowsAvailable: rows.length, validTradingDays: normalized.length, fullHistoryAvailable: normalized.length >= 260,
    exactDate: rows[0]?.basDt === referenceDate.replaceAll("-", ""), duplicateDates: rows.length - new Set(rows.map((row) => row.basDt)).size,
    currentNonTrading: rows[0]?.observationStatus === "tradingHaltOrNoTrade", nonTradingRows: rows.filter((row) => row.observationStatus === "tradingHaltOrNoTrade").length,
    shortHistoryCandidateNotConfirmedIpo: rows.length < 260, adjustment: history?.adjustment ?? null, inputFailure, proofFailure,
    fieldCompleteness: Object.fromEntries(["mkp", "hipr", "lopr", "clpr", "trqu", "trPrc"].map((field) => [field, rows.length > 0 && rows.every((row) => Number.isFinite(row[field]))])),
    dailyChangeRateBasis: rate.basis, officialQuarantinePreserved: quarantined, eligibility, exclusions, scores, rawScores: { "A-v2": eligibility["A-v2"] ? rawAV2Score : null }, deterministic };
}

async function privateDirectory(root, parts) {
  const base = path.resolve(root, ".runtime", "kis-eod");
  const target = path.resolve(base, ...parts);
  if (!target.startsWith(`${base}${path.sep}`)) fail("KIS_EOD_AUDIT_PRIVATE_PATH_INVALID");
  // Reject a symlink/junction at any existing ancestor before writing raw data.
  let cursor = path.resolve(root);
  for (const segment of path.relative(cursor, target).split(path.sep)) {
    cursor = path.join(cursor, segment);
    try { if ((await fs.lstat(cursor)).isSymbolicLink()) fail("KIS_EOD_AUDIT_PRIVATE_SYMLINK_FORBIDDEN"); }
    catch (error) { if (error?.code !== "ENOENT") throw error; }
  }
  await fs.mkdir(target, { recursive: true });
  const resolved = await fs.realpath(target), resolvedRoot = await fs.realpath(root);
  if (!resolved.startsWith(`${resolvedRoot}${path.sep}.runtime${path.sep}kis-eod${path.sep}`)) fail("KIS_EOD_AUDIT_PRIVATE_PATH_INVALID");
  return target;
}
async function writeImmutable(target, value) {
  const body = { ...value, artifactHash: sha256Canonical(value) };
  try { await fs.writeFile(target, `${JSON.stringify(body)}\n`, { flag: "wx" }); return body; }
  catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const existing = JSON.parse(await fs.readFile(target, "utf8"));
    const { artifactHash, ...identity } = existing;
    if (artifactHash !== sha256Canonical(identity) || artifactHash !== body.artifactHash) fail("KIS_EOD_AUDIT_IMMUTABLE_CONFLICT");
    return existing;
  }
}
function recordTelemetry(event, events) {
  if (!["SUCCESS", "ATTEMPT_FAILURE"].includes(event?.status)) return;
  events.push(Object.fromEntries(["operation", "status", "reason", "attempt", "requestStartedAt", "receivedAt", "durationMs", "httpStatus", "businessCode"].map((key) => [key, event[key] ?? null])));
}
export function describeRejectedKisEodResponse(context) {
  const numeric = (value) => value === null || value === undefined || value === "" || !Number.isFinite(Number(value)) ? null : Number(value);
  const rawFields = ["stck_bsop_date", "stck_oprc", "stck_hgpr", "stck_lwpr", "stck_clpr", "acml_vol", "acml_tr_pbmn", "prdy_ctrt", "flng_cls_code", "prtt_rate", "mod_yn", "prdy_vrss", "prdy_vrss_sign", "revl_issu_reas"];
  const rows = (Array.isArray(context?.payload?.output2) ? context.payload.output2 : []).map((row) => Object.fromEntries(rawFields.map((field) => {
    const value = row?.[field];
    return [field, value === null || value === undefined || value === "" ? null : typeof value === "number" && Number.isFinite(value) ? value
      : typeof value === "string" && /^[+-]?[0-9A-Z._-]{1,32}$/u.test(value) ? value : "UNRECOGNIZED_FIELD_FORMAT"];
  })));
  const violations = [];
  for (const row of rows) {
    const open = numeric(row.stck_oprc), high = numeric(row.stck_hgpr), low = numeric(row.stck_lwpr), close = numeric(row.stck_clpr), volume = numeric(row.acml_vol);
    const issues = [];
    if ([open, high, low, close, volume].some((value) => value === null)) issues.push("missingOrInvalidOhlcvNumber");
    else {
      const nonTrading = volume === 0 && open === 0 && high === 0 && low === 0;
      if (close <= 0) issues.push("nonPositiveClose");
      if (volume < 0 || !Number.isSafeInteger(volume)) issues.push("invalidVolume");
      if (!nonTrading && volume === 0) issues.push("zeroVolumeWithExecutableOhlc");
      if (!nonTrading && [open, high, low].some((value) => value <= 0)) issues.push("nonPositiveOhl");
      if (!nonTrading && (high < Math.max(open, close) || low > Math.min(open, close) || high < low)) issues.push("invalidOhlcRelationship");
    }
    if (issues.length) violations.push({ date: /^[0-9]{8}$/u.test(row.stck_bsop_date ?? "") ? row.stck_bsop_date : null, reasons: issues });
  }
  return { namespace: "kis-eod-private-rejected-response", code: context.code, referenceDate: context.referenceDate, adjustment: context.adjustment,
    requestedAt: context.requestedAt, receivedAt: context.receivedAt, reason: context.reason, rows, violations, publicationEligible: false };
}
async function defaultSource(now, events, rejectedDirectory) {
  const getCredentials = () => ({ appKey: process.env.KIS_APP_KEY, appSecret: process.env.KIS_APP_SECRET });
  if (!getCredentials().appKey || !getCredentials().appSecret) fail("KIS_EOD_CREDENTIALS_MISSING");
  const fetchImpl = (input, init = {}) => fetch(input, { ...init, redirect: "error", signal: init.signal ?? AbortSignal.timeout(15_000) });
  const tokenManager = createKisTokenManager({ fetchImpl, getCredentials, now: () => clock(now).getTime() });
  const client = createKisApiClient({ fetchImpl, tokenManager, getCredentials });
  return createKisEodProvider({ client, now: () => clock(now).getTime(), delayMs: 350, maxAttempts: 3, timeoutMs: 15_000, logger: (event) => recordTelemetry(event, events),
    onRejectedResponse: async (context) => {
      const raw = describeRejectedKisEodResponse(context);
      await writeImmutable(path.join(rejectedDirectory, `${context.code}-${sha256Canonical(raw)}.json`), raw);
    } });
}
function compareSavedOfficial(histories, seed) {
  const fields = ["mkp", "hipr", "lopr", "clpr", "trqu"];
  const matches = Object.fromEntries(fields.map((field) => [field, 0]));
  let comparedCount = 0, allFieldsEqualCount = 0;
  const referenceDate = seed?.requestedDate ?? seed?.referenceDate ?? seed?.asOfDate ?? null;
  for (const { code, history } of histories) {
    const saved = seed?.records?.find((record) => record.code === code)?.rows?.find((row) => row[0] === referenceDate?.replaceAll("-", ""));
    if (!saved) continue;
    const row = history.rows.find((value) => value.basDt === saved[0]);
    if (!row) continue;
    comparedCount += 1;
    let allEqual = true;
    fields.forEach((field, index) => { if (row[field] === saved[index + 1]) matches[field] += 1; else allEqual = false; });
    if (allEqual) allFieldsEqualCount += 1;
  }
  return { referenceDate, comparedCount, allFieldsEqualCount, fieldEqualCounts: matches,
    tradingValue: "NOT_STORED_IN_SAVED_SEED", source: "EXISTING_OFFICIAL_SEED_ONLY", noSourceMixing: true };
}

export async function auditKisEodPrivate({ root = process.cwd(), referenceDate, collectPrivate = false, now = () => new Date(),
  expectedUniverseCount = 553, loadInputs = loadKisEodInputs, provider = null, onProgress = () => {}, telemetryEvents = [] } = {}) {
  const startedAt = clock(now).toISOString(), local = getKisEodLocalClock(startedAt);
  const safeBase = { namespace: "kis-eod-private-audit", observationType: "HISTORICAL_RESEARCH_REQUEST", referenceDate, requestedAt: startedAt,
    sourceFinality: "NOT_CONFIRMED", publicationEligible: false, productionChanged: false };
  if (!validDate(referenceDate) || referenceDate >= local.referenceDate) return { ...safeBase, status: "BLOCKED", reason: "PAST_DATE_ONLY_NOT_CLOSE_TIME_OBSERVATION" };
  const inputs = await loadInputs({ root, referenceDate, expectedUniverseCount });
  const formulaHashesVerified = KIS_EOD_MODEL_VERSIONS.every((version) => inputs.formulaHashes[version] === inputs.expectedFormulaHashes[version]);
  if (!formulaHashesVerified) return { ...safeBase, status: "BLOCKED", reason: "FORMULA_HASH_MISMATCH" };
  const quarantined = new Set(inputs.officialSnapshot.records.filter(isQuarantined).map((record) => record.code));
  const manifest = { schemaVersion: 1, namespace: safeBase.namespace, referenceDate, adjustment: "unadjusted", requiredRows: 260,
    universe: inputs.universeRecords.map(({ code, name, market }) => ({ code, name, market })), universeHash: sha256Canonical(inputs.universeRecords.map(({ code }) => code)),
    officialBaselineDate: inputs.officialSnapshot.asOfDate, officialSnapshotHash: inputs.officialSnapshotHash ?? sha256Canonical(inputs.officialSnapshot),
    formulaHashes: inputs.formulaHashes, formulaHashScope: inputs.formulaHashScope, quarantineCodes: [...quarantined].sort() };
  const manifestHash = sha256Canonical(manifest);
  if (!collectPrivate) return { ...safeBase, status: "DRY_RUN_READY", requestedCount: inputs.universeRecords.length, quarantineCount: quarantined.size, manifestHash, formulaHashesVerified, networkRequests: 0, filesWritten: 0 };
  const directory = await privateDirectory(root, ["audits", referenceDate, manifestHash]);
  await writeImmutable(path.join(directory, "manifest.json"), manifest);
  const successDirectory = await privateDirectory(root, ["audits", referenceDate, manifestHash, "success"]);
  const attempt = `${startedAt.replaceAll(/[:.]/gu, "-")}-${randomUUID()}`;
  const attemptDirectory = await privateDirectory(root, ["audits", referenceDate, manifestHash, "attempts", attempt]);
  const rejectedDirectory = await privateDirectory(root, ["audits", referenceDate, manifestHash, "attempts", attempt, "rejected-responses"]);
  const lock = path.join(directory, "collection.lock");
  let handle;
  try { handle = await fs.open(lock, "wx"); }
  catch (error) { if (error?.code === "EEXIST") return { ...safeBase, status: "BLOCKED", reason: "AUDIT_ALREADY_RUNNING", manifestHash }; throw error; }
  try {
    const source = provider ?? await defaultSource(now, telemetryEvents, rejectedDirectory);
    let calendar;
    const calendarPath = path.join(directory, "calendar.json");
    try {
      calendar = JSON.parse(await fs.readFile(calendarPath, "utf8"));
      const { artifactHash, ...identity } = calendar;
      if (artifactHash !== sha256Canonical(identity)) fail("KIS_EOD_AUDIT_CALENDAR_HASH_INVALID");
    }
    catch (error) { if (error?.code !== "ENOENT") throw error; calendar = await source.getTradingDay(referenceDate); await writeImmutable(calendarPath, calendar); }
    if (calendar.referenceDate !== referenceDate || calendar.source !== "KIS" || calendar.operation !== "chk-holiday" || calendar.sourceFields?.bass_dt !== referenceDate.replaceAll("-", "") || calendar.sourceFields.opnd_yn !== "Y" || calendar.sourceFields.tr_day_yn !== "Y" || calendar.isTradingDay !== true) {
      const blocked = { ...safeBase, status: "PENDING", reason: "TRADING_DAY_NOT_CONFIRMED", manifestHash, calendarStatus: calendar.status ?? "unknown" };
      await writeImmutable(path.join(attemptDirectory, "report.json"), blocked); return blocked;
    }
    const items = [], histories = [];
    let reusedCount = 0, authenticationFailures = 0;
    for (const stock of inputs.universeRecords) {
      const ticker = stock.code, tickerStartedAt = clock(now).toISOString(), requestBegin = telemetryEvents.length;
      let artifact;
      try {
        const cachedPath = path.join(successDirectory, `${ticker}.json`);
        try {
          const cached = JSON.parse(await fs.readFile(cachedPath, "utf8")), { artifactHash, ...identity } = cached;
          if (artifactHash !== sha256Canonical(identity) || cached.manifestHash !== manifestHash || cached.code !== ticker) fail("KIS_EOD_AUDIT_CACHED_HASH_INVALID");
          artifact = cached; reusedCount += 1;
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
          const history = await source.getHistory(ticker, referenceDate, { adjustment: "unadjusted", requiredRows: 260, maxPages: 5 });
          const validation = evaluateKisEodAuditHistory(history, referenceDate, quarantined.has(ticker), ticker);
          artifact = await writeImmutable(cachedPath, { schemaVersion: 1, namespace: safeBase.namespace, observationType: safeBase.observationType, manifestHash,
            code: ticker, requestedDate: referenceDate, requestedAt: tickerStartedAt, receivedAt: clock(now).toISOString(),
            durationMs: clock(now).getTime() - Date.parse(tickerStartedAt), history, validation, telemetry: telemetryEvents.slice(requestBegin), publicationEligible: false });
        }
        histories.push({ code: ticker, history: artifact.history });
        // Raw hashes are immutable; validation belongs to the CURRENT evaluator,
        // not to a cached earlier verdict (which may predate a diagnostic fix).
        const validation = evaluateKisEodAuditHistory(artifact.history, referenceDate, quarantined.has(ticker), ticker);
        items.push({ code: ticker, status: "COLLECTED", durationMs: artifact.durationMs, pages: artifact.history.pageCount, rawHash: artifact.artifactHash, ...validation });
      } catch (error) {
        const reason = safeReason(error);
        const item = { code: ticker, status: "FAILED", reason, durationMs: clock(now).getTime() - Date.parse(tickerStartedAt), officialQuarantinePreserved: quarantined.has(ticker) };
        items.push(item); await writeImmutable(path.join(attemptDirectory, `${ticker}-failure.json`), item);
        if (["KIS_EOD_AUTHENTICATION_FAILED", "KIS_EOD_AUTHORIZATION_FAILED", "KIS_EOD_CREDENTIALS_MISSING"].includes(reason)) authenticationFailures += 1;
        // No hundreds of repeated token/auth failures when a credential is unusable.
        if (authenticationFailures >= 3) break;
      }
      if (items.length % 25 === 0 || items.length === inputs.universeRecords.length) onProgress({ completedCount: items.length, requestedCount: inputs.universeRecords.length,
        collectedCount: items.filter((item) => item.status === "COLLECTED").length, failedCount: items.filter((item) => item.status === "FAILED").length,
        elapsedSeconds: Math.round((clock(now).getTime() - Date.parse(startedAt)) / 1_000) });
    }
    const completedAt = clock(now).toISOString(), collected = items.filter((item) => item.status === "COLLECTED"), failed = items.filter((item) => item.status === "FAILED");
    let seed = null;
    try { seed = JSON.parse(await fs.readFile(path.join(root, "data", "analysis", "market-seeds", `${inputs.officialSnapshot.asOfDate}.json`), "utf8")); }
    catch (error) { if (error?.code !== "ENOENT") throw error; }
    const modelCoverage = Object.fromEntries(KIS_EOD_MODEL_VERSIONS.map((version) => [version, { eligibleCount: collected.filter((item) => item.eligibility[version]).length,
      exclusionCounts: counts(items.map((item) => item.status === "FAILED" ? item.reason : item.exclusions[version]).filter(Boolean)),
      deterministicChecks: collected.filter((item) => item.eligibility[version] && item.deterministic === true).length }]));
    const histogram = counts(telemetryEvents.filter((event) => event.status === "ATTEMPT_FAILURE").map((event) => event.reason ?? "UNKNOWN"));
    const rejected = await Promise.all((await fs.readdir(rejectedDirectory)).map(async (file) => JSON.parse(await fs.readFile(path.join(rejectedDirectory, file), "utf8"))));
    const report = { ...safeBase, schemaVersion: 1, validationVersion: KIS_EOD_AUDIT_VALIDATION_VERSION,
      status: failed.length || items.length !== inputs.universeRecords.length ? "PARTIAL" : "COMPLETED", completedAt, manifestHash,
      requestedCount: inputs.universeRecords.length, attemptedCount: items.length, collectedCount: collected.length, failedCount: failed.length, unattemptedCount: inputs.universeRecords.length - items.length,
      reusedCount, freshCollectedCount: collected.length - reusedCount, quarantineCount: quarantined.size,
      modelExcludedCount: items.filter((item) => item.status === "FAILED" || !Object.values(item.eligibility).some(Boolean)).length,
      exactDateCount: collected.filter((item) => item.exactDate).length, fieldCompleteCounts: Object.fromEntries(["mkp", "hipr", "lopr", "clpr", "trqu", "trPrc"].map((field) => [field, collected.filter((item) => item.fieldCompleteness[field]).length])),
      inputValidationFailures: collected.filter((item) => item.inputFailure).map(({ code, inputFailure }) => ({ code, reason: inputFailure })),
      inputValidationFailureCounts: counts(collected.map((item) => item.inputFailure).filter(Boolean)),
      sourceProvenanceFailures: collected.filter((item) => item.proofFailure).map(({ code, proofFailure }) => ({ code, reason: proofFailure })),
      rejectedResponseCount: rejected.length, rejectedRowViolationCounts: counts(rejected.flatMap((record) => record.violations.flatMap((row) => row.reasons))),
      full260ValidTradingDayCount: collected.filter((item) => item.fullHistoryAvailable).length, shortHistoryCandidateCount: collected.filter((item) => item.shortHistoryCandidateNotConfirmedIpo).length,
      shortHistoryCandidates: collected.filter((item) => item.shortHistoryCandidateNotConfirmedIpo).map(({ code, rowsAvailable, validTradingDays }) => ({ code, rowsAvailable, validTradingDays })),
      currentNonTradingCodes: collected.filter((item) => item.currentNonTrading).map((item) => item.code), historiesWithNonTradingRows: collected.filter((item) => item.nonTradingRows > 0).length,
      duplicateTickerCount: inputs.universeRecords.length - new Set(inputs.universeRecords.map((stock) => stock.code)).size, duplicateDateCount: collected.reduce((total, item) => total + item.duplicateDates, 0),
      adjustmentBasis: "kisDailyBarUnadjusted", totalElapsedMs: Date.parse(completedAt) - Date.parse(startedAt), symbolCollectionTimes: summaryTimes(collected.map((item) => item.durationMs)),
      api: { attemptCount: telemetryEvents.length, successfulAttempts: telemetryEvents.filter((event) => event.status === "SUCCESS").length,
        failedAttempts: telemetryEvents.filter((event) => event.status === "ATTEMPT_FAILURE").length, retries: telemetryEvents.filter((event) => event.attempt > 1).length,
        rateLimitedAttempts: telemetryEvents.filter((event) => event.reason === "KIS_EOD_RATE_LIMITED").length, failureReasons: histogram,
        requestTimes: summaryTimes(telemetryEvents.map((event) => event.durationMs).filter(Number.isFinite)),
        includesTokenRoundtripInFirstAttempt: true, telemetryScope: "KIS_CLIENT_REQUEST_ATTEMPTS_NOT_HIDDEN_AUTH_REFRESH_ROUNDTRIPS" },
      totalRetainedHistoryRows: collected.reduce((total, item) => total + item.rowsAvailable, 0), historicalPageCount: collected.reduce((total, item) => total + item.pages, 0),
      modelCoverage, formulaHashesVerified, officialComparison: compareSavedOfficial(histories, seed), failures: failed.map(({ code, reason }) => ({ code, reason })),
      privateStorageBytes: (await Promise.all((await fs.readdir(successDirectory)).map(async (file) => (await fs.stat(path.join(successDirectory, file))).size))).reduce((total, size) => total + size, 0),
      privateReportPath: path.relative(root, path.join(attemptDirectory, "report.json")).replaceAll("\\", "/") };
    await writeImmutable(path.join(attemptDirectory, "report.json"), { ...report, records: items, telemetry: telemetryEvents });
    return report;
  } finally { await handle.close(); await fs.unlink(lock); }
}

async function cli() {
  const args = process.argv.slice(2), dateArgs = args.filter((argument) => argument.startsWith("--date="));
  let result;
  if (dateArgs.length !== 1 || args.some((argument) => !["--collect-private", "--dry-run"].includes(argument) && !argument.startsWith("--date=")) || (args.includes("--collect-private") && args.includes("--dry-run"))) {
    result = { status: "BLOCKED", reason: "INVALID_CLI_ARGUMENTS", productionChanged: false };
  } else {
    try { result = await auditKisEodPrivate({ referenceDate: dateArgs[0].slice(7), collectPrivate: args.includes("--collect-private"),
      onProgress: (progress) => console.log(`KIS_EOD_AUDIT_PROGRESS=${JSON.stringify(progress)}`) }); }
    catch (error) { result = { status: "FAILED", reason: safeReason(error), productionChanged: false }; }
  }
  console.log(`KIS_EOD_AUDIT_RESULT_JSON=${JSON.stringify(result)}`);
  if (!["COMPLETED", "DRY_RUN_READY"].includes(result.status)) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await cli();
