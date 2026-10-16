import { readFile, readdir, mkdir, open, link, unlink, lstat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { hashIntradayModelTop, isCurrentIntradayModelTopSignal } from "./intraday-model-top-official-signal.mjs";
import { CURRENT_LIVE_PROFILE } from "./intraday-model-top-time-policy.mjs";
import { createPreparingForecast, validateForecastRecord, hashSwingContent, SWING_FORECAST_VERSION } from "./forecast-swing-contract.mjs";
import { readSwingResolution } from "./forecast-swing-results.mjs";
import { isLocalRequest } from "./local-live-executor.mjs";

/** Optional local-only ledger root; Vercel never reads a workstation state path. */
export async function forecastSwingRootForRequest(request, { env = process.env, repositoryRoot = process.cwd() } = {}) {
  const configured = env.FORECAST_SWING_PRIVATE_ROOT;
  if (!configured) return repositoryRoot;
  if (Object.hasOwn(env, "VERCEL") || !isLocalRequest(request) || !path.isAbsolute(configured)) throw new Error("PRIVATE_SWING_ROOT_DENIED");
  // Runtime-only workstation paths, denied on Vercel; never bundle a checkout or private state.
  const root = path.resolve(/* turbopackIgnore: true */ configured), repository = path.resolve(/* turbopackIgnore: true */ repositoryRoot);
  const lower = value => process.platform === "win32" ? value.toLowerCase() : value;
  if (root === path.parse(root).root || lower(root) === lower(repository) || lower(root).startsWith(`${lower(repository)}${path.sep}`)
    || root.split(path.sep).some(part => ["public", ".git"].includes(part.toLowerCase()))) throw new Error("PRIVATE_SWING_ROOT_DENIED");
  let current = path.parse(root).root;
  for (const part of root.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if ((await lstat(current)).isSymbolicLink()) throw new Error("PRIVATE_SWING_ROOT_DENIED");
  }
  return root;
}

const datePattern = /^\d{4}-\d{2}-\d{2}$/u;
const digestPattern = /^[a-f0-9]{64}$/u;
const validDate = value => typeof value === "string" && datePattern.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const readJson = async file => JSON.parse(await readFile(file, "utf8"));
const list = async directory => { try { return await readdir(directory); } catch (error) { if (error.code === "ENOENT") return []; throw error; } };
export const SWING_LEDGER_DIRECTORY = "data/forecast-ledger/swing-5d";
const BLOCKERS = [
  { code: "MODEL_NOT_TRAINED", message: "예측 모델 학습과 독립된 미래 기간 검증이 아직 없습니다." },
  { code: "INPUT_PROVENANCE_NOT_CERTIFIED", message: "입력별 이용 가능 시각, 당시 종목군과 수정주가 검증이 완성되지 않았습니다." },
  { code: "EXECUTION_EVIDENCE_MISSING", message: "실제 체결·거래정지·상장폐지 검증 자료가 부족합니다." },
  { code: "COST_MODEL_UNSPECIFIED", message: "수수료·세금·스프레드·슬리피지 가정이 확정되지 않았습니다." },
];

// Structural and timestamp validation does not certify forecast readiness.
export function isSavedSwingObservation(signal) {
  try {
    if (!isCurrentIntradayModelTopSignal(signal) || signal.status !== "READY" || signal.observationType !== "LIVE_OBSERVATION"
      || !validDate(signal.signalDate) || !validDate(signal.seedReferenceDate) || signal.seedReferenceDate >= signal.signalDate) return false;
    const start = Date.parse(signal.collectionStartedAt), end = Date.parse(signal.collectionCompletedAt);
    const from = Date.parse(`${signal.signalDate}T${CURRENT_LIVE_PROFILE.signalTime}+09:00`), to = Date.parse(`${signal.signalDate}T${CURRENT_LIVE_PROFILE.windowEnd}+09:00`);
    const rows = signal.records.filter(row => row.dataStatus === "AVAILABLE");
    const excluded = signal.records.filter(row => row.dataStatus === "INELIGIBLE");
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < from || end < start || end > to || !rows.length
      || rows.length + excluded.length !== signal.records.length || signal.collection?.successful !== rows.length || signal.collection.failed !== 0
      || signal.collection.ineligible !== excluded.length || signal.universe?.eligibleCount !== rows.length || signal.universe.sourceCount !== signal.records.length
      || signal.universe.eligibleHash !== hashIntradayModelTop(rows.map(row => row.ticker).sort())) return false;
    return rows.every(row => {
      const quoted = Date.parse(`${row.quote?.asOfDate}T${row.quote?.asOfTime}+09:00`), received = Date.parse(row.quote?.receivedAt);
      return typeof row.ticker === "string" && /^[0-9A-Z]{6}$/u.test(row.ticker) && typeof row.companyName === "string"
        && row.quote?.asOfDate === signal.signalDate && /^\d{2}:\d{2}:\d{2}$/u.test(row.quote?.asOfTime ?? "")
        && Number.isFinite(quoted) && quoted >= from && quoted <= to && Number.isFinite(received) && received >= quoted && received >= start && received <= end
        && Number.isFinite(row.provisionalOhlcv?.close) && row.provisionalOhlcv.close > 0;
    });
  } catch { return false; }
}

/** @param {{root?:string, code?:string|null, now?:string}} options */
export async function loadSwingObservation({ root = process.cwd(), code = null, now = new Date().toISOString() } = {}) {
  if (code !== null && !/^[0-9A-Z]{6}$/u.test(code)) throw new Error("INVALID_STOCK_CODE");
  if (!Number.isFinite(Date.parse(now))) throw new Error("INVALID_NOW");
  const directory = path.join(root, "data", "intraday-signals", "model-top");
  let independentDateCount = 0, invalidArtifactCount = 0;
  for (const date of await list(directory)) {
    if (!validDate(date)) continue;
    try {
      if (!(await list(path.join(directory, date))).includes("1400.json")) continue; // 14:30-only archives are not current samples or corrupt data.
      const historical = await readJson(path.join(directory, date, "1400.json"));
      if (historical.signalDate === date && isSavedSwingObservation(historical)) {
        if (Date.parse(historical.collectionCompletedAt) <= Date.parse(now)) independentDateCount += 1;
      }
      else invalidArtifactCount += 1;
    } catch { invalidArtifactCount += 1; }
  }
  try {
    const latest = await readJson(path.join(directory, "latest.json"));
    if (latest.schemaVersion !== CURRENT_LIVE_PROFILE.schemaVersion || latest.observationPolicyId !== CURRENT_LIVE_PROFILE.policyId || latest.artifactType !== "intradayModelTopLatestStatus" || latest.status !== "READY" || !validDate(latest.signalDate)
      || latest.officialSignalTime !== CURRENT_LIVE_PROFILE.signalTime || latest.signalPath !== `data/intraday-signals/model-top/${latest.signalDate}/1400.json`) throw new Error("SAVED_SIGNAL_UNAVAILABLE");
    const signal = await readJson(path.join(directory, latest.signalDate, "1400.json"));
    if (!isSavedSwingObservation(signal) || signal.signalDate !== latest.signalDate || signal.contentHash !== latest.contentHash
      || Date.parse(signal.collectionCompletedAt) > Date.parse(now)) throw new Error("SAVED_SIGNAL_INVALID");
    const rows = signal.records.filter(row => row.dataStatus === "AVAILABLE");
    const row = rows.find(item => item.ticker === (code ?? "005930")) ?? (code === null ? rows[0] : null);
    return { signal, row, independentDateCount, invalidArtifactCount, reason: row ? null : "STOCK_OBSERVATION_UNAVAILABLE" };
  } catch { return { signal: null, row: null, independentDateCount, invalidArtifactCount, reason: "SAVED_SIGNAL_UNAVAILABLE" }; }
}

/** @param {{root?:string, now?:string}} options */
export async function readSwingLedger({ root = process.cwd(), now = new Date().toISOString() } = {}) {
  const records = []; let invalidRecordCount = 0;
  const directory = path.join(root, SWING_LEDGER_DIRECTORY);
  for (const name of await list(directory)) {
    if (!/^[a-f0-9]{64}\.json$/u.test(name)) { invalidRecordCount += 1; continue; }
    try {
      const record = await readJson(path.join(directory, name));
      if (!validateForecastRecord(record).valid || record.observationPolicyId !== CURRENT_LIVE_PROFILE.policyId || record.forecastHash !== name.slice(0, -5) || Date.parse(record.createdAt) > Date.parse(now)) throw new Error("INVALID_LEDGER_RECORD");
      records.push(record);
    } catch { invalidRecordCount += 1; }
  }
  records.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.forecastHash.localeCompare(b.forecastHash));
  return { records, invalidRecordCount };
}

/** @param {{root?:string, code?:string|null, now?:string}} options */
export async function loadForecastSwingDashboard({ root = process.cwd(), code = null, now = new Date().toISOString() } = {}) {
  if (!Number.isFinite(Date.parse(now))) throw new Error("INVALID_NOW");
  const saved = await loadSwingObservation({ root, code, now });
  const ledger = await readSwingLedger({ root, now });
  const selectedRecords = ledger.records.filter(record => code === null || record.observation.symbol === code);
  const resolutions = await Promise.all(selectedRecords.map(forecast => readSwingResolution({ root, forecast, now })));
  const observed = resolutions.filter(result => result.outcome?.status === "OBSERVED");
  const blockers = [...BLOCKERS];
  if (saved.reason) blockers.push({ code: saved.reason, message: "요청한 종목의 유효한 저장 관측을 사용할 수 없습니다." });
  if (saved.invalidArtifactCount || ledger.invalidRecordCount) blockers.push({ code: "INVALID_SAVED_RECORDS", message: "일부 저장 기록의 무결성 검사가 실패했습니다. 검증된 기록만 표시합니다." });
  if (resolutions.some(result => result.invalidCount)) blockers.push({ code: "INVALID_OUTCOME_EVIDENCE", message: "일부 후속 결과의 증거 검증에 실패했습니다. 해당 결과는 표시하지 않습니다." });
  const { signal, row } = saved;
  return {
    schemaVersion: 1, status: "PREPARING", generatedAt: now, observationPolicyId: CURRENT_LIVE_PROFILE.policyId, officialSignalTime: CURRENT_LIVE_PROFILE.signalTime,
    model: { version: SWING_FORECAST_VERSION, trainingStatus: "NOT_TRAINED", externalValidationStatus: "NOT_VALIDATED" },
    horizon: { tradingDays: 5, entryPolicy: "NEXT_SESSION_OPEN_AFTER_ISSUANCE", exitPolicy: "FIFTH_SESSION_CLOSE" },
    prediction: { expectedReturnPercent: null, lossProbability: null, rangePercent: null },
    observation: { status: row ? "AVAILABLE" : "UNAVAILABLE", signalDate: signal?.signalDate ?? null,
      collectionStartedAt: signal?.collectionStartedAt ?? null, collectionCompletedAt: signal?.collectionCompletedAt ?? null,
      availableAt: null, referencePrice: row?.provisionalOhlcv.close ?? null, ticker: row?.ticker ?? code, companyName: row?.companyName ?? null,
      observedAt: row ? `${row.quote.asOfDate}T${row.quote.asOfTime}+09:00` : null, rowCount: signal?.collection.successful ?? 0,
      independentDateCount: saved.independentDateCount },
    readiness: { status: "BLOCKED", eligibleForTraining: false, blockers },
    ledger: { recordCount: selectedRecords.length, records: selectedRecords.slice(0, 20).map((record, index) => {
      const outcome = resolutions[index].outcome;
      return { id: record.forecastHash, status: "PREPARING", issuedAt: record.createdAt,
        signalDate: record.observation.observedDate, ticker: record.observation.symbol, modelVersion: record.modelVersion,
        observedModels: record.inputs.filter(input => input.modelVersion && input.name.startsWith("observedScore:")).map(input => ({ modelVersion: input.modelVersion, score: input.value,
          rank: record.inputs.find(rank => rank.name === `selectedRank:${input.modelVersion}`)?.value ?? null })),
        expectedReturnPercent: null, lossProbability: null, rangePercent: null,
        outcome: { status: outcome?.status ?? "NOT_EVALUATED", reasons: outcome?.reasons ?? ["OUTCOME_EVIDENCE_NOT_AVAILABLE"],
          resolvedAt: outcome?.resolvedAt ?? null, entryDate: outcome?.entryDate ?? null, exitDate: outcome?.exitDate ?? null,
          benchmarkReturnPercent: outcome?.status === "OBSERVED" ? outcome.grossReturn * 100 : null, netReturnPercent: null } };
    }) },
    // Benchmarks are not prediction validation or realized P&L. Old Daily/LIVE
    // outcome files are never imported; only this record's reproducible proof is read.
    evaluation: { mature5DayCount: observed.length, independentDateCount: new Set(selectedRecords.filter((_, index) => resolutions[index].outcome?.status === "OBSERVED").map(record => record.observation.observedDate)).size, costAdjustedReturnPercent: null, costStatus: "UNKNOWN" },
    daytrade: { status: "PREPARING", reason: "분봉·장중 체결 경로 자료가 없어 단타 예측은 준비 중입니다." },
  };
}

/** Build a new preparation entry at this read's real timestamp, never at the old signal time. */
export async function prepareSwingLedgerRecord({ root = process.cwd(), code, clock = () => new Date().toISOString() }) {
  const { signal, row } = await loadSwingObservation({ root, code });
  if (!signal || !row) throw new Error("SAVED_SIGNAL_UNAVAILABLE");
  return prepareSwingRecordFromSignal({ signal, row, createdAt: clock() });
}

/** Shared preparation contract; model TOP selection does not change the score. */
export function prepareSwingRecordFromSignal({ signal, row, createdAt, selectedVersions = null }) {
  if (!isSavedSwingObservation(signal) || !signal.records.includes(row) || row.dataStatus !== "AVAILABLE"
    || !Number.isFinite(Date.parse(createdAt)) || Date.parse(createdAt) < Date.parse(signal.collectionCompletedAt)) throw new Error("SAVED_SIGNAL_UNAVAILABLE");
  // A receipt cannot precede this actual completed read. The injected clock is
  // for deterministic local tests; the CLI never accepts a timestamp argument.
  const evidence = { source: "saved-intraday-model-top", sourceHash: signal.contentHash, availableAt: createdAt, receivedAt: createdAt,
    availabilityEvidence: "SYSTEM_OBSERVED", originalPublicationAt: null, historicalObservation: true, seedHash: signal.source?.seedHash ?? null };
  return createPreparingForecast({ createdAt, observationPolicyId: CURRENT_LIVE_PROFILE.policyId, observation: { symbol: row.ticker, observedDate: signal.signalDate,
    observedAt: `${row.quote.asOfDate}T${row.quote.asOfTime}+09:00`, referencePrice: row.provisionalOhlcv.close, provenance: evidence },
    inputs: Object.entries(row.scores ?? {}).filter(([version]) => !selectedVersions || selectedVersions.includes(version)).flatMap(([version, value]) => [
      { name: `observedScore:${version}`, value: Number.isFinite(value) ? value : null },
      ...(selectedVersions ? [{ name: `selectedRank:${version}`, value: row.ranks[version] }] : []),
    ].map(input => ({ ...input, source: "saved-intraday-model-top",
      observedAt: createdAt, availableAt: createdAt, receivedAt: createdAt, availabilityEvidence: "SYSTEM_OBSERVED",
      sourceHash: signal.contentHash, modelVersion: version, formulaHash: signal.modelDefinitions?.[version[0]]?.formulaHash ?? null,
      seedHash: signal.source?.seedHash ?? null, sourceArtifact: `data/intraday-signals/model-top/${signal.signalDate}/1400.json` }))),
    blockers: BLOCKERS.map(blocker => blocker.code) });
}

// CLI-only explicit opt-in writer. GET handlers never call this function.
export async function appendSwingPreparation({ root = process.cwd(), record }) {
  if (!validateForecastRecord(record).valid || record.observationPolicyId !== CURRENT_LIVE_PROFILE.policyId || !digestPattern.test(record.forecastHash)) throw new Error("INVALID_LEDGER_RECORD");
  const directory = path.join(root, SWING_LEDGER_DIRECTORY);
  await mkdir(directory, { recursive: true });
  const target = path.join(directory, `${record.forecastHash}.json`);
  const text = `${JSON.stringify(record, null, 2)}\n`;
  const temporary = `${target}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
  let created = true;
  try {
    try { await link(temporary, target); } catch (error) { if (error.code !== "EEXIST") throw error; created = false; }
    let existing;
    try { existing = JSON.parse(await readFile(target, "utf8")); } catch { throw new Error("IMMUTABLE_LEDGER_CONFLICT"); }
    if (!validateForecastRecord(existing).valid || hashSwingContent(existing) !== hashSwingContent(record)) throw new Error("IMMUTABLE_LEDGER_CONFLICT");
    return { created, forecastHash: record.forecastHash };
  } finally { await unlink(temporary); }
}
