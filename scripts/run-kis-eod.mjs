import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { validateSnapshot } from "../lib/model-history-schema.mjs";
import { validateCompactModelHistory } from "../lib/daily-production.mjs";
import { sha256Canonical } from "../lib/snapshot-quality-pipeline.mjs";
import { normalizeStockCode } from "../lib/stock-code.mjs";
import { createKisTokenManager } from "../lib/kis-token-manager-core.mjs";
import { createKisApiClient } from "../lib/kis-api-client-core.mjs";
import { createKisEodProvider } from "../lib/kis-eod-provider.mjs";
import { buildKisEodCandidate, validateKisEodCandidate, writeImmutableKisEodCandidate, KIS_EOD_MODEL_VERSIONS } from "../lib/kis-eod-pipeline.mjs";

const execute = promisify(execFile);
const FORMULA_FILES = Object.freeze({ "A-v1": "lib/technical-strength.mjs", "A-v2": "lib/technical-strength-v2.mjs", "B-v1": "lib/trend-strength.mjs", "C-v1": "lib/entry-strength.mjs", "D-v1": "lib/combined-technical-score.mjs" });
export const KIS_EOD_RUNNER_STATUSES = Object.freeze(["DRY_RUN_READY", "BLOCKED", "PENDING", "VALIDATED", "COLLECTED", "FAILED"]);
export const KIS_EOD_RUNNER_REASONS = Object.freeze(["PLAN_ONLY", "PUBLICATION_POLICY_UNAPPROVED", "COLLECTION_NOT_ENABLED", "BEFORE_MARKET_CLOSE", "WEEKEND", "MARKET_CLOSED", "CALENDAR_UNKNOWN", "PRIVATE_CANDIDATE_READY", "PARTIAL_COLLECTION_RETRY_REQUIRED", "NO_VALID_MODEL_INPUTS", "REFERENCE_DATE_CHANGED", "INPUT_VALIDATION_FAILED", "CALENDAR_REQUEST_FAILED", "PRIVATE_STORAGE_FAILED", "CANDIDATE_VALIDATION_FAILED", "UNEXPECTED_FAILURE", "INVALID_CLI_ARGUMENTS"]);
const hashPattern = /^[a-f0-9]{64}$/u;
const isoDatePattern = /^\d{4}-\d{2}-\d{2}$/u;
const sourceHash = (source) => createHash("sha256").update(source.replaceAll("\r\n", "\n")).digest("hex");
const reasonCode = (error) => typeof error?.code === "string" && /^KIS_[A-Z0-9_]{1,70}$/u.test(error.code) ? error.code : "KIS_EOD_UNCLASSIFIED_FAILURE";
const inputFailureCode = (error) => typeof error?.message === "string" && /^KIS_EOD_[A-Z0-9_]{1,70}$/u.test(error.message) ? error.message : "KIS_EOD_INPUT_READ_FAILED";
const clockDate = (clock) => {
  const value = new Date(typeof clock === "function" ? clock() : clock);
  if (!Number.isFinite(value.getTime())) throw new Error("KIS_EOD_NOW_INVALID");
  return value;
};

export function getKisEodLocalClock(now) {
  const instant = new Date(now);
  if (!Number.isFinite(instant.getTime())) throw new Error("KIS_EOD_NOW_INVALID");
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(instant).map(({ type, value }) => [type, value]));
  const referenceDate = `${parts.year}-${parts.month}-${parts.day}`;
  const weekday = new Date(`${referenceDate}T12:00:00+09:00`).getUTCDay();
  return { referenceDate, time: `${parts.hour}:${parts.minute}:${parts.second}`, weekend: weekday === 0 || weekday === 6 };
}

// A historical manifest's hashes may use another byte profile/scope. Preserve it,
// but compare this new namespace's working formula sources against frozen HEAD.
export async function loadKisEodInputs({ root, referenceDate, expectedUniverseCount = 553 }) {
  const historyDirectory = path.join(root, "data", "history");
  const names = (await fs.readdir(historyDirectory)).filter((name) => isoDatePattern.test(name.slice(0, -5)) && name.endsWith(".json") && name.slice(0, 10) <= referenceDate).sort();
  const latest = names.at(-1);
  if (!latest) throw new Error("KIS_EOD_OFFICIAL_BASELINE_MISSING");
  const officialSnapshot = JSON.parse(await fs.readFile(path.join(historyDirectory, latest), "utf8"));
  if (officialSnapshot.asOfDate !== latest.slice(0, 10) || validateSnapshot(officialSnapshot, expectedUniverseCount).length) throw new Error("KIS_EOD_OFFICIAL_BASELINE_INVALID");
  const compactPath = path.join(root, "data", "model-history", latest);
  let compactHistoryHash = null;
  try {
    const compact = JSON.parse(await fs.readFile(compactPath, "utf8"));
    if (validateCompactModelHistory(compact, expectedUniverseCount).length || compact.referenceDate !== officialSnapshot.asOfDate) throw new Error("KIS_EOD_COMPACT_BASELINE_INVALID");
    compactHistoryHash = compact.contentHash;
  } catch (error) { if (error?.code !== "ENOENT") throw error; }
  const universe = JSON.parse(await fs.readFile(path.join(root, "data", "universe.json"), "utf8"));
  const universeRecords = universe.stocks;
  if (!Array.isArray(universeRecords) || universeRecords.length !== expectedUniverseCount) throw new Error("KIS_EOD_UNIVERSE_INVALID");
  const codes = universeRecords.map((stock) => normalizeStockCode(stock.code));
  if (codes.some((code) => !code) || new Set(codes).size !== codes.length || universeRecords.some((stock) => !["KOSPI", "KOSDAQ"].includes(stock.market))) throw new Error("KIS_EOD_UNIVERSE_INVALID");
  const formulaHashes = {};
  const expectedFormulaHashes = {};
  for (const [version, relativePath] of Object.entries(FORMULA_FILES)) {
    const workingSource = await fs.readFile(path.join(root, relativePath), "utf8");
    const { stdout } = await execute("git", ["-c", `safe.directory=${path.resolve(root).replaceAll("\\", "/")}`, "show", `HEAD:${relativePath}`], { cwd: root, encoding: "utf8", maxBuffer: 2 * 1024 * 1024 });
    formulaHashes[version] = sourceHash(workingSource);
    expectedFormulaHashes[version] = sourceHash(stdout);
    if (formulaHashes[version] !== expectedFormulaHashes[version]) throw new Error("KIS_EOD_BASELINE_FORMULA_CHANGED");
  }
  return { universeRecords, officialSnapshot, formulaHashes, expectedFormulaHashes, formulaHashScope: "currentHEADFormulaSourceFilesLfNormalized", officialSnapshotHash: sha256Canonical(officialSnapshot), compactHistoryHash };
}

async function defaultProvider(now) {
  const getCredentials = () => ({ appKey: process.env.KIS_APP_KEY, appSecret: process.env.KIS_APP_SECRET });
  const fetchImpl = (input, init = {}) => fetch(input, { ...init, redirect: "error", signal: init.signal ?? AbortSignal.timeout(15_000) });
  const tokenManager = createKisTokenManager({ fetchImpl, getCredentials, now: () => clockDate(now).getTime() });
  const client = createKisApiClient({ fetchImpl, tokenManager, getCredentials });
  return createKisEodProvider({ client, now: () => clockDate(now).getTime(), delayMs: 350, maxAttempts: 3, timeoutMs: 15_000 });
}

function privatePath(root, relativePath) {
  const base = path.resolve(root, ".runtime", "kis-eod");
  const target = path.resolve(root, relativePath);
  if (!target.startsWith(`${base}${path.sep}`)) throw new Error("KIS_EOD_PRIVATE_PATH_INVALID");
  return target;
}

async function readJsonOrMissing(target) {
  try { return JSON.parse(await fs.readFile(target, "utf8")); }
  catch (error) { if (error?.code === "ENOENT") return null; throw error; }
}

async function writeRuntimeStatus(root, status) {
  const target = privatePath(root, ".runtime/kis-eod/status/latest.json");
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(status, null, 2)}\n`, { flag: "wx" });
  await fs.rename(temporary, target);
}

function validCalendar(evidence, referenceDate, checkedAt) {
  const flags = evidence?.sourceFields;
  const flagsMatch = flags?.bass_dt === referenceDate.replaceAll("-", "") && ["Y", "N"].includes(flags.opnd_yn) && ["Y", "N"].includes(flags.tr_day_yn)
    && evidence.isTradingDay === (flags.opnd_yn === "Y" && flags.tr_day_yn === "Y" ? true : flags.opnd_yn === "N" && flags.tr_day_yn === "N" ? false : null);
  return evidence?.source === "KIS" && evidence.operation === "chk-holiday" && evidence.referenceDate === referenceDate
    && flagsMatch && [true, false, null].includes(evidence.isTradingDay) && typeof evidence.receivedAt === "string"
    && Number.isFinite(Date.parse(evidence.receivedAt)) && Date.parse(evidence.receivedAt) <= checkedAt.getTime()
    && getKisEodLocalClock(evidence.receivedAt).referenceDate === referenceDate;
}

async function calendarFor({ root, provider, referenceDate, now }) {
  const target = privatePath(root, `.runtime/kis-eod/calendar/${referenceDate}.json`);
  const checkedAt = clockDate(now);
  const cached = await readJsonOrMissing(target);
  if (cached !== null) {
    if (!validCalendar(cached, referenceDate, checkedAt)) throw new Error("KIS_EOD_CALENDAR_CACHE_INVALID");
    return cached;
  }
  const response = await provider.getTradingDay(referenceDate);
  // Persist only the documented calendar fields, never arbitrary response bodies.
  const evidence = { source: response?.source, operation: response?.operation, referenceDate: response?.referenceDate, isTradingDay: response?.isTradingDay, receivedAt: response?.receivedAt, sourceFields: { bass_dt: response?.sourceFields?.bass_dt, opnd_yn: response?.sourceFields?.opnd_yn, tr_day_yn: response?.sourceFields?.tr_day_yn } };
  if (!validCalendar(evidence, referenceDate, clockDate(now))) throw new Error("KIS_EOD_CALENDAR_RESPONSE_INVALID");
  await fs.mkdir(path.dirname(target), { recursive: true });
  try { await fs.writeFile(target, `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx" }); }
  catch (error) { if (error?.code !== "EEXIST") throw error; }
  return evidence;
}

function normalizedPrivateHistory(value) {
  return { rows: value.rows.map((row) => Object.fromEntries(["basDt", "srtnCd", "mkp", "hipr", "lopr", "clpr", "trqu", "trPrc", "fltRt", "observationStatus"].filter((key) => row[key] !== undefined).map((key) => [key, row[key]]))),
    adjustment: value.adjustment, marketDivision: value.marketDivision, priceBasis: value.priceBasis, receivedAt: value.receivedAt, finality: "NOT_CONFIRMED",
    historyRowsAvailable: value.rows.length, historyComplete: value.historyComplete === true,
    symbolMapping: { requestedCode: value.symbolMapping?.requestedCode ?? value.code, responseCode: value.symbolMapping?.responseCode ?? null, status: value.symbolMapping?.status ?? "UNVERIFIED_RESPONSE_TICKER_ABSENT" },
    pageCount: value.pageCount,
    adjustmentMetadata: (value.adjustmentMetadata ?? []).map((entry) => Object.fromEntries(["date", "exDividendCode", "splitRatio", "changed", "reevaluationReason"].filter((key) => entry[key] !== undefined).map((key) => [key, entry[key]]))),
    dailyChangeMetadata: (value.dailyChangeMetadata ?? []).map((entry) => Object.fromEntries(["date", "reportedDifference", "reportedSign"].filter((key) => entry[key] !== undefined).map((key) => [key, entry[key]]))) };
}

async function writePrivateRaw(root, referenceDate, histories, failures, startedAt, completedAt) {
  const inputs = [...histories.entries()].map(([ticker, value]) => ({ ticker, ...value }));
  const withoutReceipt = (value) => Object.fromEntries(Object.entries(value).filter(([key]) => key !== "receivedAt"));
  const identity = { schemaVersion: 1, namespace: "kis-provisional-eod-private-inputs", referenceDate,
    histories: inputs.map(withoutReceipt), failures };
  const contentHash = sha256Canonical(identity);
  const relativePath = `.runtime/kis-eod/raw/${referenceDate}/${contentHash}.json`;
  const target = privatePath(root, relativePath);
  const artifact = { ...identity, contentHash, collectionStartedAt: startedAt, collectionCompletedAt: completedAt, histories: inputs, publicationEligible: false };
  await fs.mkdir(path.dirname(target), { recursive: true });
  try { await fs.writeFile(target, `${JSON.stringify(artifact, null, 2)}\n`, { flag: "wx" }); }
  catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const previous = await readJsonOrMissing(target);
    const priorIdentity = { schemaVersion: previous?.schemaVersion, namespace: previous?.namespace, referenceDate: previous?.referenceDate, histories: (previous?.histories ?? []).map(withoutReceipt), failures: previous?.failures };
    if (previous?.contentHash !== contentHash || sha256Canonical(priorIdentity) !== contentHash) throw new Error("KIS_EOD_PRIVATE_IMMUTABLE_CONFLICT");
  }
  return relativePath;
}

export async function runKisEod({ root = process.cwd(), now = () => new Date(), provider = null, collectPrivate = false, publish = false,
  collectionEnabled = process.env.KIS_EOD_COLLECTION_ENABLED, expectedUniverseCount = 553, loadInputs = loadKisEodInputs } = {}) {
  const started = clockDate(now);
  const local = getKisEodLocalClock(started);
  const common = { referenceDate: local.referenceDate, checkedAt: started.toISOString(), timezone: "Asia/Seoul", source: "KIS", sourceFinality: "UNVERIFIED", publicationEligible: false, productionChanged: false };
  const result = (status, reason, detail = {}) => ({ ...common, status, reason, ...detail });
  if (publish) return result("BLOCKED", "PUBLICATION_POLICY_UNAPPROVED", { blockers: ["sourceFinalityUnverified", "derivedPublicationRightsUnapproved", "automationUnapproved"] });
  let inputs;
  try { inputs = await loadInputs({ root, referenceDate: local.referenceDate, expectedUniverseCount }); }
  catch (error) { return result("FAILED", "INPUT_VALIDATION_FAILED", { inputFailure: inputFailureCode(error) }); }
  const inputSummary = { universeCount: inputs.universeRecords.length, officialBaselineReferenceDate: inputs.officialSnapshot.asOfDate, officialSnapshotHash: inputs.officialSnapshotHash ?? sha256Canonical(inputs.officialSnapshot), compactHistoryHash: inputs.compactHistoryHash ?? null, formulaHashScope: inputs.formulaHashScope, formulaHashesVerified: KIS_EOD_MODEL_VERSIONS.every((version) => hashPattern.test(inputs.formulaHashes?.[version] ?? "") && inputs.formulaHashes[version] === inputs.expectedFormulaHashes?.[version]) };
  if (!inputSummary.formulaHashesVerified) return result("FAILED", "INPUT_VALIDATION_FAILED");
  if (!collectPrivate) return result("DRY_RUN_READY", "PLAN_ONLY", { ...inputSummary, plannedObservationDate: local.referenceDate, adjustment: "unadjusted", requiredHistoryRows: 260, maxHistoryPages: 5, requestDelayMs: 350, clockReady: !local.weekend && local.time >= "15:30:00", calendarStatus: "NOT_REQUESTED", networkRequests: 0, filesWritten: 0 });
  if (collectionEnabled !== "true") return result("BLOCKED", "COLLECTION_NOT_ENABLED", inputSummary);
  if (local.weekend) return result("PENDING", "WEEKEND", inputSummary);
  if (local.time < "15:30:00") return result("PENDING", "BEFORE_MARKET_CLOSE", inputSummary);
  // The source's finality is unverified. Never freeze an early complete response
  // as the entire day's final input: later slots reobserve, while identical
  // inputs remain idempotent and changed inputs create immutable attempt versions.
  const source = provider ?? await defaultProvider(now);
  let calendarEvidence;
  try { calendarEvidence = await calendarFor({ root, provider: source, referenceDate: local.referenceDate, now }); }
  catch { return result("FAILED", "CALENDAR_REQUEST_FAILED", inputSummary); }
  if (calendarEvidence.isTradingDay !== true) {
    const pending = result("PENDING", calendarEvidence.isTradingDay === false ? "MARKET_CLOSED" : "CALENDAR_UNKNOWN", inputSummary);
    try { await writeRuntimeStatus(root, pending); } catch { return result("FAILED", "PRIVATE_STORAGE_FAILED"); }
    return pending;
  }
  const collectionStartedAt = clockDate(now).toISOString();
  if (getKisEodLocalClock(collectionStartedAt).referenceDate !== local.referenceDate) return result("FAILED", "REFERENCE_DATE_CHANGED");
  const histories = new Map();
  const failures = [];
  for (const stock of inputs.universeRecords) {
    if (getKisEodLocalClock(clockDate(now)).referenceDate !== local.referenceDate) break;
    const ticker = normalizeStockCode(stock.code);
    try {
      const response = await source.getHistory(ticker, local.referenceDate, { adjustment: "unadjusted", requiredRows: 260, maxPages: 5 });
      if (!Array.isArray(response?.rows)) throw new Error("KIS_EOD_HISTORY_RESPONSE_INVALID");
      histories.set(ticker, normalizedPrivateHistory({ ...response, code: ticker }));
    } catch (error) { failures.push({ ticker, reason: reasonCode(error) }); }
  }
  const collectionCompletedAt = clockDate(now).toISOString();
  if (getKisEodLocalClock(collectionCompletedAt).referenceDate !== local.referenceDate) {
    const rejected = result("FAILED", "REFERENCE_DATE_CHANGED", { collectedCount: histories.size, failedCount: failures.length });
    try { await writeRuntimeStatus(root, rejected); } catch { /* Preserve the fail-closed result. */ }
    return rejected;
  }
  const quarantined = new Set(inputs.officialSnapshot.records.filter((record) => record.qualityEligibility?.status === "quarantined" || record.qualityEligibility?.exclusions?.length).map((record) => record.code));
  const collectionComplete = inputs.universeRecords.every((stock) => histories.has(normalizeStockCode(stock.code)) || quarantined.has(normalizeStockCode(stock.code)));
  const candidate = buildKisEodCandidate({ referenceDate: local.referenceDate, now: collectionCompletedAt, calendarEvidence, universeRecords: inputs.universeRecords, historiesByCode: histories, expectedUniverseCount,
    officialSnapshot: inputs.officialSnapshot, formulaHashes: inputs.formulaHashes, expectedFormulaHashes: inputs.expectedFormulaHashes, formulaHashScope: inputs.formulaHashScope,
    collectionStartedAt, collectionCompletedAt, adjustmentPolicy: "unadjusted", sourceMetadataByCode: histories, sourceFinalityEvidence: "UNVERIFIED", publicationApproval: { rights: false, automation: false }, observationType: "LIVE_COLLECTION" });
  const statistics = { ...inputSummary, collectedCount: histories.size, failedCount: failures.length, failures, collectionComplete, rankingCounts: Object.fromEntries(KIS_EOD_MODEL_VERSIONS.map((version) => [version, candidate.rankingUniverse[version].count])) };
  if (validateKisEodCandidate(candidate).length) return result("FAILED", "CANDIDATE_VALIDATION_FAILED", statistics);
  try {
    const rawPath = await writePrivateRaw(root, local.referenceDate, histories, failures, collectionStartedAt, collectionCompletedAt);
    // A partial attempt is immutable but is not the final daily identity. Later
    // retries may create a new input hash without overwriting the earlier attempt.
    let candidatePath = null, immutableAction = null;
    if (["COLLECTED", "VALIDATED"].includes(candidate.status)) {
      const persisted = await writeImmutableKisEodCandidate({ directory: privatePath(root, `.runtime/kis-eod/candidates/${candidate.contentHash}`), candidate });
      candidatePath = path.relative(root, persisted.path).replaceAll("\\", "/");
      immutableAction = persisted.action;
    }
    const outcome = result(candidate.status === "VALIDATED" ? "VALIDATED" : "FAILED", candidate.status !== "VALIDATED" ? "NO_VALID_MODEL_INPUTS" : collectionComplete ? "PRIVATE_CANDIDATE_READY" : "PARTIAL_COLLECTION_RETRY_REQUIRED", { ...statistics, rawPath, candidatePath, contentHash: candidate.contentHash, immutableAction });
    await writeRuntimeStatus(root, outcome);
    return outcome;
  } catch { return result("FAILED", "PRIVATE_STORAGE_FAILED", statistics); }
}

async function cli() {
  const args = process.argv.slice(2);
  const known = new Set(["--dry-run", "--collect-private", "--publish"]);
  let result;
  if (args.some((argument) => !known.has(argument)) || args.filter((argument) => ["--dry-run", "--collect-private", "--publish"].includes(argument)).length > 1) result = { status: "BLOCKED", reason: "INVALID_CLI_ARGUMENTS", productionChanged: false };
  else {
    try { result = await runKisEod({ collectPrivate: args.includes("--collect-private"), publish: args.includes("--publish") }); }
    catch { result = { status: "FAILED", reason: "UNEXPECTED_FAILURE", productionChanged: false }; }
  }
  console.log(`KIS_EOD_RESULT_JSON=${JSON.stringify(result)}`);
  if (["FAILED", "BLOCKED"].includes(result.status)) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await cli();
