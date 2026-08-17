import fs from "node:fs/promises";
import path from "node:path";
import { calculateEligibleSnapshotModels } from "../lib/model-score-engine.mjs";
import { createMarketPriceLedger, validateMarketPriceLedger } from "../lib/market-price-ledger.mjs";
import { normalizeModelInputRows, validateMarketDataQuality } from "../lib/market-data-quality-validator.mjs";
import { normalizeStockCode } from "../lib/stock-code.mjs";
import { createMarketAnalysisSnapshot, validateMarketAnalysisSnapshot } from "../lib/market-analysis-snapshot.mjs";
import { createIntradayMarketSeed, validateIntradayMarketSeed } from "../lib/intraday-market-seed.mjs";
import { createSourceAvailability } from "../lib/source-availability.mjs";
import { createExecutionReturns, PUBLIC_EOD_T2_POLICY_ID } from "../lib/execution-return-resolver.mjs";
import { createPublicEodQuery, createPublicEodRequestShape, createPublicEodSingleFlight, evaluatePublicEodCandidate, normalizePublicEodRows } from "../lib/public-eod-request.mjs";
import {
  annotateRankingMetadata,
  assertSnapshotQualityGate,
  buildExcludedFromScoring,
  buildTrackingUniverse,
  buildUniverseSummary,
  checkUniverseArchive,
  createDataQualityMetadata,
  createFormulaHashes,
  createSourceManifest,
  createUniverseArchive,
  sha256Canonical,
} from "../lib/snapshot-quality-pipeline.mjs";
import {
  MODEL_DEFINITIONS,
  MODEL_VERSION_DEFINITIONS,
  MODEL_HISTORY_SCHEMA_VERSION,
  assignRanks,
  createHistoryRecord,
  createTopLists,
  createTopListsByVersion,
  validateSnapshot,
} from "../lib/model-history-schema.mjs";

const serviceKey = process.env.DATA_GO_KR_SERVICE_KEY;
if (!serviceKey) throw new Error("DATA_GO_KR_SERVICE_KEY가 없습니다.");

const PRICE_URL =
  "https://apis.data.go.kr/1160100/service/GetStockSecuritiesInfoService/getStockPriceInfo";
const CONCURRENCY = 4;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_ATTEMPTS = 3;
const EXPECTED_UNIVERSE_COUNT = 553;
const dryRun = process.argv.includes("--dry-run");
const latestMode = dryRun && process.argv.includes("--latest");
const requestCache = createPublicEodSingleFlight();
const collectionStatistics = { apiRequests: 0, successes: 0, failures: 0, timeouts: 0, retries: 0, cacheHits: 0, failedSymbols: [] };

function parseRequestedDate() {
  const argument = process.argv.find((value) => value.startsWith("--date="));
  if (!argument) return null;
  const date = argument.slice("--date=".length);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("--date는 YYYY-MM-DD 형식이어야 합니다.");
  return date;
}

let requestedDate = parseRequestedDate();
let requestedCompactDate = requestedDate?.replaceAll("-", "") ?? null;

async function fetchHistoryUncached(shape, attempt = 1) {
  const query = createPublicEodQuery(shape);
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    collectionStatistics.apiRequests += 1;
    let response;
    try { response = await fetch(`${PRICE_URL}?serviceKey=${serviceKey}&${query}`, { signal: controller.signal }); }
    finally { clearTimeout(timeout); }
    if (!response.ok) { const failure = new Error(`HTTP ${response.status}`); failure.httpStatus = response.status; throw failure; }
    const payload = await response.json();
    const businessCode = String(payload?.response?.header?.resultCode ?? "");
    if (businessCode && businessCode !== "00") { const failure = new Error(`업무 응답 ${businessCode}`); failure.businessCode = businessCode; throw failure; }
    const { rows } = normalizePublicEodRows(payload?.response?.body?.items?.item, { code: shape.code });

    if (rows.length === 0) throw new Error("일봉 응답이 비어 있습니다.");
    collectionStatistics.successes += 1;
    return rows;
  } catch (error) {
    if (error?.name === "AbortError") collectionStatistics.timeouts += 1;
    const maxAttempts = latestMode ? 2 : MAX_ATTEMPTS;
    const retryable = error?.name === "AbortError" || (!latestMode && error?.httpStatus === 429) || error?.httpStatus >= 500 || (error?.httpStatus == null && !error?.businessCode);
    if (!retryable || attempt >= maxAttempts) {
      collectionStatistics.failures += 1;
      collectionStatistics.failedSymbols.push({ code: shape.code, httpStatus: error?.httpStatus ?? null, timeout: error?.name === "AbortError" });
      throw new Error(`${shape.code} 일봉 조회 실패: ${error instanceof Error ? error.message : String(error)}`);
    }
    collectionStatistics.retries += 1;
    await new Promise((resolve) => setTimeout(resolve, 2 ** (attempt - 1) * 1000));
    return fetchHistoryUncached(shape, attempt + 1);
  }
}

function fetchHistory(code) {
  const shape = createPublicEodRequestShape({ code, purpose: "latestHistoryCollection", beginBasDt: null, endBasDt: null, pageNo: 1, numOfRows: 260, resultType: "json" });
  if (requestCache.has(shape)) collectionStatistics.cacheHits += 1;
  return requestCache.run(shape, async () => fetchHistoryUncached(shape)).then((rows) => rows.filter((row) => !requestedCompactDate || String(row.basDt) <= requestedCompactDate));
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return results;
}

const universePath = path.join(process.cwd(), "data", "universe.json");
const universe = JSON.parse(await fs.readFile(universePath, "utf8"));
universe.stocks = (universe.stocks ?? []).map((stock) => ({ ...stock, code: normalizeStockCode(stock.code) }));
if (universe.stocks.some((stock) => !stock.code) || new Set(universe.stocks.map((stock) => stock.code)).size !== universe.stocks.length) {
  throw new Error("Universe 종목코드 정규화에 실패했거나 중복 코드가 있습니다.");
}
const policy = JSON.parse(await fs.readFile(path.join(process.cwd(), "config", "snapshot-quality-policy.json"), "utf8"));
const modelRegistry = JSON.parse(await fs.readFile(path.join(process.cwd(), "data", "model-registry.json"), "utf8"));
for (const version of policy.activeComparisonModels) {
  const registered = modelRegistry.models?.find((entry) => entry.modelVersion === version);
  if (!registered || registered.status === "notConfigured") throw new Error(`활성 비교 모델이 레지스트리에 유효하게 등록되지 않았습니다: ${version}`);
}
if (universe.finalCount !== EXPECTED_UNIVERSE_COUNT || universe.stocks?.length !== EXPECTED_UNIVERSE_COUNT) {
  throw new Error(`Universe가 553개가 아닙니다: finalCount=${universe.finalCount}, stocks=${universe.stocks?.length ?? 0}`);
}
const dryRunStartedAt = new Date().toISOString();
let representativeProbe = null;
if (latestMode) {
  const preferred = ["005930", "000660", "247540"];
  const representatives = preferred.map((code) => universe.stocks.find((stock) => stock.code === code)).filter(Boolean);
  for (const stock of universe.stocks) {
    if (representatives.length >= 3) break;
    if (!representatives.some((item) => item.code === stock.code)) representatives.push(stock);
  }
  const observations = [];
  for (const stock of representatives.slice(0, 3)) {
    const rows = await fetchHistory(stock.code);
    const row = rows[0];
    const latestBasDt = String(row?.basDt ?? "");
    const prices = [row?.mkp, row?.hipr, row?.lopr, row?.clpr].map(Number);
    if (!/^\d{8}$/.test(latestBasDt) || !prices.every((value) => Number.isFinite(value) && value > 0) || Number(row?.hipr) < Math.max(Number(row?.mkp), Number(row?.clpr)) || Number(row?.lopr) > Math.min(Number(row?.mkp), Number(row?.clpr)) || Number(row?.trqu) < 0) {
      throw new Error(`UPSTREAM_FAILED: 대표 종목 probe 검증 실패 ${stock.code}`);
    }
    observations.push({ code: stock.code, market: stock.market, latestBasDt });
  }
  const dates = [...new Set(observations.map((item) => item.latestBasDt))];
  if (dates.length !== 1) throw new Error(`REPRESENTATIVE_DATE_MISMATCH: ${observations.map((item) => `${item.code}:${item.latestBasDt}`).join(",")}`);
  const compact = dates[0];
  const formatted = `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
  if (formatted > new Date().toISOString().slice(0, 10)) throw new Error("UPSTREAM_FAILED: 대표 종목 미래 날짜 응답");
  requestedDate = formatted;
  requestedCompactDate = compact;
  representativeProbe = { status: "OFFICIAL_EOD_CANDIDATE_FOUND", observations, candidateAsOfDate: formatted, completedAt: new Date().toISOString() };
}

const historyDirectory = path.join(process.cwd(), "data", "history");
const marketPriceDirectory = path.join(process.cwd(), "data", "market-prices");
const universeHistoryDirectory = path.join(process.cwd(), "data", "universe-history");
const marketAnalysisDirectory = path.join(process.cwd(), "data", "analysis", "market");
const marketSeedDirectory = path.join(process.cwd(), "data", "analysis", "market-seeds");
if (!dryRun) {
  await fs.mkdir(historyDirectory, { recursive: true });
  await fs.mkdir(marketPriceDirectory, { recursive: true });
  await fs.mkdir(universeHistoryDirectory, { recursive: true });
  await fs.mkdir(marketAnalysisDirectory, { recursive: true });
  await fs.mkdir(marketSeedDirectory, { recursive: true });
}
if (requestedDate && !dryRun) {
  for (const existingPath of [
    path.join(historyDirectory, `${requestedDate}.json`),
    path.join(marketPriceDirectory, `${requestedDate}.json`),
    path.join(marketAnalysisDirectory, `${requestedDate}.json`),
    path.join(marketSeedDirectory, `${requestedDate}.json`),
  ]) {
    try {
      await fs.access(existingPath);
      throw new Error(`${existingPath}가 이미 존재합니다. 덮어쓰지 않습니다.`);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}
const histories = await mapWithConcurrency(
  universe.stocks,
  CONCURRENCY,
  async (stock, index) => {
    console.log(`[${index + 1}/${universe.stocks.length}] ${stock.code} ${stock.name}`);
    try { return await fetchHistory(stock.code); }
    catch (error) {
      if (!dryRun) throw error;
      console.error(`[DRY-RUN] ${stock.code} 수집 실패: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  },
);
const sourceCollectedAt = new Date().toISOString();
const historyByCode = new Map(universe.stocks.map((stock, index) => [stock.code, histories[index]]).filter(([, rows]) => Array.isArray(rows)));
const asOfDate = requestedDate ?? (() => {
  const dates = [...historyByCode.values()].map((rows) => String(rows[0]?.basDt ?? ""));
  if (new Set(dates).size !== 1 || !/^\d{8}$/.test(dates[0])) throw new Error("요청 날짜가 없고 종목별 최신 거래일이 일치하지 않습니다.");
  return `${dates[0].slice(0, 4)}-${dates[0].slice(4, 6)}-${dates[0].slice(6, 8)}`;
})();
const quality = validateMarketDataQuality({
  requestedDate: asOfDate,
  universeRecords: universe.stocks,
  historyByCode,
  requirements: {
    expectedUniverseCount: EXPECTED_UNIVERSE_COUNT,
    sourceManifestPresent: true,
    adjustedPricePolicy: policy.priceAdjustmentPolicy,
    corporateActionPolicy: policy.corporateActionPolicy,
    pointInTimeMasterCertified: policy.pointInTimeMasterCertified,
    securityStatusVerified: policy.securityStatusVerified,
    universeFilterVersion: policy.universeFilterVersion,
    universeGeneratedAt: universe.generatedAt,
    maxRequestedNonTradingRatio: policy.maxRequestedNonTradingRatio,
  },
});
const fatalIssues = quality.issues.filter((entry) => entry.severity === "fatal");
if (!dryRun) {
  try { assertSnapshotQualityGate(quality); }
  catch (error) { throw new Error(`시장 데이터 품질 검증 실패(산출물 생성 0개):\n${JSON.stringify(error.issues?.slice(0, 20) ?? [], null, 2)}`); }
}

const eligibilityByCode = new Map(Object.keys(quality.perSymbol).map((code) => [code, Object.fromEntries(Object.entries(quality.perSymbol[code].modelStatus).map(([version, status]) => [version, status === "eligible"]))]));
const records = fatalIssues.length > 0 ? [] : universe.stocks.map((stock) => {
    const rawHistory = historyByCode.get(stock.code);
    const history = normalizeModelInputRows(rawHistory);
    const eligibility = eligibilityByCode.get(stock.code);
    const models = calculateEligibleSnapshotModels(history, eligibility);
    const avgVolume20d = history.slice(0, 20).reduce((sum, row) => sum + Number(row.trqu), 0) / 20;
    const record = createHistoryRecord({
      stock,
      asOfDate,
      closePrice: quality.perSymbol[stock.code].requestedPriceStatus === "tradingHaltOrNoTrade" ? quality.perSymbol[stock.code].referenceClose : Number(rawHistory[0].clpr),
      openPrice: quality.perSymbol[stock.code].requestedPriceStatus === "tradingHaltOrNoTrade" ? null : Number(rawHistory[0].mkp),
      avgVolume20d,
      historyRows: quality.perSymbol[stock.code].uniqueTradingDays,
      modelA: models.modelA,
      modelAV2: models.modelAV2,
      modelB: models.modelB,
      modelC: models.modelC,
      modelD: models.modelD,
      modelE: models.modelE,
    });
    const halted = quality.perSymbol[stock.code].requestedPriceStatus === "tradingHaltOrNoTrade";
    record.executable = !halted;
    record.priceStatus = halted ? "tradingHaltOrNoTrade" : "executable";
    record.referenceClose = halted ? quality.perSymbol[stock.code].referenceClose : null;
    return record;
});

assignRanks(records);
annotateRankingMetadata(records);
const signalComputedAt = new Date().toISOString();
async function findModelAV2ComparisonStartDate() {
  const filenames = (await fs.readdir(historyDirectory))
    .filter((filename) => /^\d{4}-\d{2}-\d{2}\.json$/.test(filename))
    .sort();
  for (const filename of filenames) {
    try {
      const existing = JSON.parse(await fs.readFile(path.join(historyDirectory, filename), "utf8"));
      if (existing.topListsByVersion?.["A-v2"]?.status === "available") return existing.asOfDate;
    } catch {
      // 손상된 과거 파일을 비교 시작일의 근거로 사용하지 않습니다.
    }
  }
  return asOfDate;
}
const comparisonStartDate = await findModelAV2ComparisonStartDate();
const generatedAt = new Date().toISOString();
const formulaFiles = {
  "A-v1": "lib/technical-strength.mjs", "A-v2": "lib/technical-strength-v2.mjs",
  "B-v1": "lib/trend-strength.mjs", "C-v1": "lib/entry-strength.mjs", "D-v1": "lib/combined-technical-score.mjs",
};
const formulaHashes = createFormulaHashes(Object.fromEntries(await Promise.all(Object.entries(formulaFiles).map(async ([version, file]) => [version, await fs.readFile(path.join(process.cwd(), file), "utf8")]))));
const sourceManifest = createSourceManifest({ requestedDate: asOfDate, generatedAt, universe, historyByCode, formulaHashes, policy });
const universeSummary = buildUniverseSummary(quality, policy.activeComparisonModels);
const stocksByCode = new Map(universe.stocks.map((stock) => [stock.code, stock]));
const excludedFromScoring = buildExcludedFromScoring(quality, stocksByCode);
const dataQuality = createDataQualityMetadata(quality, asOfDate);
const marketAnalysisFormulaHash = createFormulaHashes({ marketAnalysis: await fs.readFile(path.join(process.cwd(), "lib", "market-analysis-v1.mjs"), "utf8") }).marketAnalysis;
const marketAnalysisSnapshot = fatalIssues.length === 0 ? createMarketAnalysisSnapshot({ requestedDate: asOfDate, generatedAt, universe, historyByCode: new Map([...historyByCode].map(([code, rows]) => [code, normalizeModelInputRows(rows)])), quality, sourceManifest, dataQuality, universeSummary, formulaHash: marketAnalysisFormulaHash }) : null;
const normalizedHistoryByCode = new Map([...historyByCode].map(([code, rows]) => [code, normalizeModelInputRows(rows)]));
const intradayMarketSeed = fatalIssues.length === 0 ? createIntradayMarketSeed({ requestedDate: asOfDate, generatedAt, universe, historyByCode: normalizedHistoryByCode, quality, sourceManifest, dataQuality, universeSummary, formulaHash: marketAnalysisFormulaHash }) : null;
if (marketAnalysisSnapshot) {
  const marketAnalysisErrors = validateMarketAnalysisSnapshot(marketAnalysisSnapshot, EXPECTED_UNIVERSE_COUNT);
  if (marketAnalysisErrors.length > 0) throw new Error(`시장분석 스냅샷 검증 실패:\n${marketAnalysisErrors.slice(0, 20).join("\n")}`);
}
if (intradayMarketSeed) { const errors = validateIntradayMarketSeed(intradayMarketSeed, EXPECTED_UNIVERSE_COUNT); if (errors.length) throw new Error(`장중 seed 검증 실패:\n${errors.slice(0,20).join("\n")}`); }
const preparedUniverseArchive = fatalIssues.length === 0
  ? createUniverseArchive({ requestedDate: asOfDate, generatedAt, universe, historyByCode, sourceManifest })
  : null;
const availabilityTimestamp = new Date().toISOString();
const sourceAvailability = dryRun ? {
  sourceMarketDate: asOfDate,
  sourcePublishedAt: null,
  sourceCollectedAt,
  sourceStoredAt: null,
  signalComputedAt,
  signalAvailableAt: null,
  sourceAvailabilityStatus: "OBSERVED_IN_DRY_RUN",
  sourcePublicationPolicy: (await import("../lib/source-availability.mjs")).SOURCE_PUBLICATION_POLICY,
  sourcePublicationPolicyHash: (await import("../lib/source-availability.mjs")).SOURCE_PUBLICATION_POLICY_HASH,
  timingPolicyVersion: "public-eod-t2-open-v1",
  timingEvidence: { publication: "POLICY_ESTIMATED", collection: "OBSERVED_IN_DRY_RUN", availability: "NOT_PRODUCTION_AVAILABLE" },
} : createSourceAvailability({ sourceMarketDate: asOfDate, sourceCollectedAt, signalComputedAt, availabilityTimestamp });
for (const record of records) record.executionReturnsByPolicy[PUBLIC_EOD_T2_POLICY_ID] = createExecutionReturns(asOfDate, sourceAvailability.signalAvailableAt);
function createHistoryDistribution() {
  const entries = Object.entries(quality.perSymbol).map(([code, value]) => ({ code, days: value.uniqueTradingDays }));
  const days = entries.map((entry) => entry.days).sort((a, b) => a - b);
  const codes = {
    atLeast260: entries.filter((entry) => entry.days >= 260).map((entry) => entry.code),
    from120To259: entries.filter((entry) => entry.days >= 120 && entry.days < 260).map((entry) => entry.code),
    from34To119: entries.filter((entry) => entry.days >= 34 && entry.days < 120).map((entry) => entry.code),
    below34: entries.filter((entry) => entry.days < 34).map((entry) => entry.code),
  };
  return { counts: Object.fromEntries(Object.entries(codes).map(([key, value]) => [key, value.length])), minimum: days.at(0) ?? 0, maximum: days.at(-1) ?? 0, median: days.length ? days[Math.floor(days.length / 2)] : 0, codes };
}
function diagnosticTop10(modelKey, version = null) {
  if (fatalIssues.length > 0) return { status: "NOT_APPROVED", stocks: [] };
  const rankOf = (record) => version ? record.ranksByVersion?.[version] : record.ranks?.[modelKey];
  return {
    status: "DIAGNOSTIC_ONLY",
    stocks: [...records].filter((record) => Number.isInteger(rankOf(record))).sort((a, b) => rankOf(a) - rankOf(b)).slice(0, 10).map((record) => ({
      rank: rankOf(record), code: record.code, name: record.name,
      score: version ? record.scoresByVersion[version] : record.scores[modelKey],
      rankingUniverseCount: version ? record.rankingUniverseCountByVersion[version] : record.rankingUniverseCount[modelKey],
      rankPercentile: version ? record.rankPercentileByVersion[version] : record.rankPercentile[modelKey],
      dataQualityGrade: quality.grade,
    })),
  };
}
const dryRunResult = {
  mode: "dry-run", dryRunOnly: true, runId: `schema-v6-dry-run-${new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14)}`,
  dryRunStartedAt, requestedDate: asOfDate, candidateAsOfDate: asOfDate, representativeProbe, generatedAt,
  approvedForSchemaV6Snapshot: fatalIssues.length === 0,
  collection: { ...collectionStatistics, observedUniverse: universe.stocks.length, requestedUniverseCount: universe.stocks.length, requestedCodeCount: requestCache.size(), concurrency: CONCURRENCY, timeoutMs: REQUEST_TIMEOUT_MS, maxAttempts: latestMode ? 2 : MAX_ATTEMPTS },
  quality: { status: quality.status, grade: quality.grade, eligibleForSnapshot: quality.eligibleForSnapshot, dataQuality, fatalCount: fatalIssues.length, ineligibleCount: excludedFromScoring.length, warningCount: quality.issues.filter((entry) => entry.severity === "warning").length },
  universeSummary, excludedFromScoring, historyDistribution: createHistoryDistribution(), sourceManifest,
  requestFingerprint: sha256Canonical({ candidateAsOfDate: asOfDate, codes: universe.stocks.map((stock) => stock.code).sort(), endpoint: "getStockPriceInfo", rowsPerCode: 260 }),
  sourceAvailability,
  returnsState: { futureFiniteCount: 0, legacyFiniteCount: 0, executionFiniteCount: 0, timingValidationStatus: "NOT_PRODUCTION_AVAILABLE", eligibleForExecutableAggregation: false },
  samples: { fatal: fatalIssues.slice(0, 20), insufficientHistory: excludedFromScoring.filter((entry) => entry.reason === "insufficientHistory").slice(0, 50), zeroVolume: quality.issues.filter((entry) => entry.type === "nonTradingObservation").slice(0, 20) },
  issueCounts: Object.fromEntries([...new Set(quality.issues.map((entry) => entry.type))].sort().map((type) => [type, quality.issues.filter((entry) => entry.type === type).length])),
  diagnosticTop10: { "A-v1": diagnosticTop10("modelA"), "A-v2": diagnosticTop10(null, "A-v2"), "B-v1": diagnosticTop10("modelB"), "C-v1": diagnosticTop10("modelC"), "D-v1": diagnosticTop10("modelD") },
};
const existingHistoryDates = (await fs.readdir(historyDirectory)).filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name)).map((name) => name.slice(0, 10).replaceAll("-", "")).sort();
const candidateEvaluation = evaluatePublicEodCandidate({ requestedDate: asOfDate.replaceAll("-", ""), latestDates: Object.values(quality.perSymbol).map((item) => item.latestBasDt), existingLatestDate: existingHistoryDates.at(-1) ?? null });
dryRunResult.candidateDecision = { representativeCandidate: representativeProbe?.candidateAsOfDate ?? asOfDate, ...candidateEvaluation, exactDateMatchCount: quality.summary.exactDateMatches, staleCount: quality.issues.filter((item) => item.type === "latestDateMismatch").length, futureCount: quality.issues.filter((item) => item.type === "futureDate").length, missingCount: quality.summary.missingHistoryCodes.length, exactMissingCodesHash: sha256Canonical(Object.entries(quality.perSymbol).filter(([, item]) => item.latestBasDt !== asOfDate.replaceAll("-", "")).map(([code]) => code).sort()) };
if (dryRun && fatalIssues.length > 0) {
  console.log(`DRY_RUN_RESULT_JSON=${JSON.stringify(dryRunResult)}`);
  process.exit(0);
}
const snapshot = {
  schemaVersion: MODEL_HISTORY_SCHEMA_VERSION,
  asOfDate,
  computedAt: generatedAt,
  ...sourceAvailability,
  dataMode: "official-daily-close",
  universe: {
    generatedAt: universe.generatedAt,
    sourceCount: universe.finalCount,
    snapshotCount: records.length,
  },
  modelDefinitions: MODEL_DEFINITIONS,
  modelVersionDefinitions: MODEL_VERSION_DEFINITIONS,
  championChallenger: {
    modelId: "A",
    champion: "A-v1",
    challenger: "A-v2",
    promotionStatus: "notApproved",
    evaluationMode: "parallel",
    comparisonStartDate,
  },
  sourceManifest,
  dataQuality,
  universeSummary,
  excludedFromScoring,
  topLists: createTopLists(records),
  topListsByVersion: createTopListsByVersion(records),
  futureReturnDefinition: {
    purpose: "modelPredictivePower",
    priceBasis: "signalClose-to-futureClose",
    entryAssumption: "none",
    tradingDayOffsets: [1, 5, 20],
    formula: "(futureClose / signalClose - 1) * 100",
    status: "pending",
  },
  records,
};

const validationErrors = validateSnapshot(snapshot, EXPECTED_UNIVERSE_COUNT, { dryRun });
if (validationErrors.length > 0) {
  throw new Error(`스냅샷 검증 실패:\n${validationErrors.slice(0, 20).join("\n")}`);
}

const historicalSnapshots = [];
for (const filename of (await fs.readdir(historyDirectory)).filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name))) {
  try { historicalSnapshots.push(JSON.parse(await fs.readFile(path.join(historyDirectory, filename), "utf8"))); } catch { /* 손상 파일은 추적 근거로 사용하지 않음 */ }
}
const trackingUniverse = buildTrackingUniverse(universe.stocks, historicalSnapshots);
const extraTracking = trackingUniverse.filter((item) => !historyByCode.has(item.code));
const trackingPriceUnavailable = [];
const trackingRecords = records.map((record) => ({ ...record, trackingReasons: trackingUniverse.find((item) => item.code === record.code)?.reasons ?? ["currentObservedUniverse"] }));
for (const item of extraTracking) {
  try {
    const rows = await fetchHistory(item.code);
    if (String(rows[0]?.basDt) !== asOfDate.replaceAll("-", "")) throw new Error("latestBasDt 불일치");
    const openPrice = Number(rows[0]?.mkp); const closePrice = Number(rows[0]?.clpr);
    if (![openPrice, closePrice].every((value) => Number.isFinite(value) && value > 0)) throw new Error("invalidPrice");
    trackingRecords.push({ code: item.code, openPrice, closePrice, trackingReasons: item.reasons });
  } catch (error) {
    trackingPriceUnavailable.push({ code: item.code, reasons: item.reasons, reason: error instanceof Error ? error.message : String(error) });
  }
}
trackingRecords.sort((a, b) => a.code.localeCompare(b.code));
const marketPriceLedger = createMarketPriceLedger(asOfDate, trackingRecords, { trackingUniverse, trackingPriceUnavailable });
const ledgerValidationErrors = validateMarketPriceLedger(marketPriceLedger, records.length);
if (ledgerValidationErrors.length > 0) {
  throw new Error(`가격 원장 검증 실패:\n${ledgerValidationErrors.slice(0, 20).join("\n")}`);
}

if (dryRun) {
  dryRunResult.plannedArtifactsValidation = { snapshot: "passed", marketPriceLedger: "passed", universeArchive: preparedUniverseArchive ? "passed" : "failed", marketAnalysis: marketAnalysisSnapshot ? "passed" : "failed", intradayMarketSeed: intradayMarketSeed ? "passed" : "failed" };
  dryRunResult.universeArchiveContentHash = preparedUniverseArchive?.contentHash ?? null;
  const artifactSummary = (name, value, schemaVersion, recordCount) => {
    const serialized = JSON.stringify(value);
    return { name, schemaVersion, requestedDate: asOfDate, recordCount, estimatedSerializedBytes: Buffer.byteLength(serialized), contentHash: value?.contentHash ?? sha256Canonical(value), validationStatus: "passed", sourceManifestStatus: value?.sourceManifest ? "present" : "embeddedOrNotApplicable", dataQualityGrade: dataQuality.overallGrade, structuralStatus: dataQuality.structuralStatus };
  };
  dryRunResult.sourceAvailability = sourceAvailability;
  dryRunResult.artifacts = [
    artifactSummary("historySnapshot", snapshot, snapshot.schemaVersion, snapshot.records.length),
    artifactSummary("marketPriceLedger", marketPriceLedger, marketPriceLedger.schemaVersion, marketPriceLedger.records.length),
    artifactSummary("universeHistoryArchive", universeArchive, universeArchive.schemaVersion, universeArchive.observedUniverse.length),
    artifactSummary("officialMarketAnalysis", marketAnalysisSnapshot, marketAnalysisSnapshot.schemaVersion, marketAnalysisSnapshot.records.length),
    artifactSummary("intradayMarketSeed", intradayMarketSeed, intradayMarketSeed.schemaVersion, intradayMarketSeed.records.length),
  ];
  const seedBytes = Buffer.byteLength(JSON.stringify(intradayMarketSeed));
  dryRunResult.intradaySeed = { recordCount: intradayMarketSeed.records.length, tupleCount: intradayMarketSeed.records.reduce((sum, record) => sum + record.rows.length, 0), serializedBytes: seedBytes, maximumRowsPerSymbol: Math.max(...intradayMarketSeed.records.map((record) => record.rows.length)), annual250DayEstimatedBytes: seedBytes * 250 };
  const scoreStats = (values) => { const valid = values.filter(Number.isFinite).sort((a, b) => a - b); return { finiteCount: valid.length, nullCount: values.filter((value) => value == null).length, nanCount: values.filter(Number.isNaN).length, infinityCount: values.filter((value) => value === Infinity || value === -Infinity).length, minimum: valid.at(0) ?? null, median: valid.length ? valid[Math.floor(valid.length / 2)] : null, maximum: valid.at(-1) ?? null }; };
  const modelPaths = { "A-v1": ["scores", "modelA", "ranks", "modelA"], "A-v2": ["scoresByVersion", "A-v2", "ranksByVersion", "A-v2"], "B-v1": ["scores", "modelB", "ranks", "modelB"], "C-v1": ["scores", "modelC", "ranks", "modelC"], "D-v1": ["scores", "modelD", "ranks", "modelD"] };
  dryRunResult.modelStatistics = Object.fromEntries(Object.entries(modelPaths).map(([version, [scoreGroup, scoreKey, rankGroup, rankKey]]) => {
    const values = records.map((record) => record[scoreGroup]?.[scoreKey]);
    const ranks = records.map((record) => record[rankGroup]?.[rankKey]).filter(Number.isInteger).sort((a, b) => a - b);
    const eligibleCount = values.filter(Number.isFinite).length;
    return [version, { ...scoreStats(values), eligibleCount, excludedCount: values.length - eligibleCount, rankingUniverseCount: ranks.length, duplicateRankCount: ranks.length - new Set(ranks).size, missingOrRangeRankCount: ranks.filter((rank, index) => rank !== index + 1).length, top50Possible: ranks.length >= 50 }];
  }));
  const currentCodes = universe.stocks.map((stock) => stock.code).sort();
  dryRunResult.universeComparison = { classification: "POINT_IN_TIME_UNVERIFIED", observedUniverseCount: currentCodes.length, exactDateMarketCapAtLeast100BillionCount: universe.stocks.filter((stock) => Number(historyByCode.get(stock.code)?.[0]?.mrktTotAmt) >= 100_000_000_000).length, averageTradingValueFilterPassCount: universe.stocks.filter((stock) => (historyByCode.get(stock.code) ?? []).slice(0, 20).reduce((sum, row) => sum + Number(row.trPrc), 0) / 20 >= 2_000_000_000).length, finalObservedUniverseCount: currentCodes.length, sameAsCurrentUniverse: true, addedCount: 0, missingCount: 0, codeHash: sha256Canonical(currentCodes) };
  dryRunResult.returnsState = { futureFiniteCount: records.reduce((sum, record) => sum + [record.futureReturns.future1dReturn, record.futureReturns.future5dReturn, record.futureReturns.future20dReturn].filter(Number.isFinite).length, 0), legacyFiniteCount: records.reduce((sum, record) => sum + Object.values(record.backtestReturns.returns).filter(Number.isFinite).length, 0), executionFiniteCount: records.reduce((sum, record) => sum + Object.values(record.executionReturnsByPolicy["public-eod-t2-open-v1"].returns).filter(Number.isFinite).length, 0), timingValidationStatus: "NOT_PRODUCTION_AVAILABLE", eligibleForExecutableAggregation: false };
  console.log(`DRY_RUN_RESULT_JSON=${JSON.stringify(dryRunResult)}`);
  process.exit(0);
}

const outputPath = path.join(historyDirectory, `${asOfDate}.json`);
const temporaryPath = `${outputPath}.tmp`;
const lockPath = `${outputPath}.lock`;
const ledgerPath = path.join(marketPriceDirectory, `${asOfDate}.json`);
const ledgerTemporaryPath = `${ledgerPath}.tmp`;
const ledgerLockPath = `${ledgerPath}.lock`;
const archivePath = path.join(universeHistoryDirectory, `${asOfDate}.json`);
const universeArchive = preparedUniverseArchive;
const archiveAction = await checkUniverseArchive(archivePath, universeArchive);
const archiveTemporaryPath = `${archivePath}.tmp`;
const archiveLockPath = `${archivePath}.lock`;
const marketAnalysisPath = path.join(marketAnalysisDirectory, `${asOfDate}.json`);
const marketAnalysisTemporaryPath = `${marketAnalysisPath}.tmp`;
const marketAnalysisLockPath = `${marketAnalysisPath}.lock`;
const marketSeedPath = path.join(marketSeedDirectory, `${asOfDate}.json`);
const marketSeedTemporaryPath = `${marketSeedPath}.tmp`;
const marketSeedLockPath = `${marketSeedPath}.lock`;

try {
  await fs.writeFile(lockPath, `${process.pid}\n`, { encoding: "utf8", flag: "wx" });
  await fs.writeFile(ledgerLockPath, `${process.pid}\n`, { encoding: "utf8", flag: "wx" });
  await fs.writeFile(archiveLockPath, `${process.pid}\n`, { encoding: "utf8", flag: "wx" });
  await fs.writeFile(marketAnalysisLockPath, `${process.pid}\n`, { encoding: "utf8", flag: "wx" });
  await fs.writeFile(marketSeedLockPath, `${process.pid}\n`, { encoding: "utf8", flag: "wx" });
} catch (error) {
  await fs.rm(lockPath, { force: true });
  await fs.rm(ledgerLockPath, { force: true });
  await fs.rm(archiveLockPath, { force: true });
  await fs.rm(marketAnalysisLockPath, { force: true });
  await fs.rm(marketSeedLockPath, { force: true });
  if (error?.code === "EEXIST") throw new Error(`${asOfDate} 스냅샷 생성이 이미 진행 중이거나 완료되었습니다.`);
  throw error;
}

try {
  try {
    await fs.access(outputPath);
    throw new Error(`${outputPath}가 이미 존재합니다. 과거 스냅샷은 덮어쓰지 않습니다.`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  try {
    await fs.access(ledgerPath);
    throw new Error(`${ledgerPath}가 이미 존재합니다. 가격 원장을 덮어쓰지 않습니다.`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  try {
    await fs.access(marketAnalysisPath);
    throw new Error(`${marketAnalysisPath}가 이미 존재합니다. 시장분석 스냅샷을 덮어쓰지 않습니다.`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  try { await fs.access(marketSeedPath); throw new Error(`${marketSeedPath}가 이미 존재합니다. 장중 seed를 덮어쓰지 않습니다.`); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  await fs.writeFile(temporaryPath, `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  await fs.writeFile(ledgerTemporaryPath, `${JSON.stringify(marketPriceLedger, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  if (archiveAction === "create") await fs.writeFile(archiveTemporaryPath, `${JSON.stringify(universeArchive, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  await fs.writeFile(marketAnalysisTemporaryPath, `${JSON.stringify(marketAnalysisSnapshot, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  await fs.writeFile(marketSeedTemporaryPath, `${JSON.stringify(intradayMarketSeed, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  const committed = [];
  try {
    await fs.rename(temporaryPath, outputPath);
    committed.push(outputPath);
    await fs.rename(ledgerTemporaryPath, ledgerPath);
    committed.push(ledgerPath);
    if (archiveAction === "create") { await fs.rename(archiveTemporaryPath, archivePath); committed.push(archivePath); }
    await fs.rename(marketAnalysisTemporaryPath, marketAnalysisPath);
    committed.push(marketAnalysisPath);
    await fs.rename(marketSeedTemporaryPath, marketSeedPath); committed.push(marketSeedPath);
  } catch (error) {
    for (const file of committed.reverse()) await fs.rm(file, { force: true });
    throw error;
  }
  console.log(`저장 완료: ${outputPath}`);
  console.log(`검증 완료: ${records.length}개, 중복 0개, A/B/C/D 순위 누락 0개`);
  console.warn("Model E: 공식 미등록으로 점수/순위/TOP 목록을 생성하지 않았습니다.");
} finally {
  await fs.rm(temporaryPath, { force: true });
  await fs.rm(ledgerTemporaryPath, { force: true });
  await fs.rm(archiveTemporaryPath, { force: true });
  await fs.rm(marketAnalysisTemporaryPath, { force: true });
  await fs.rm(marketSeedTemporaryPath, { force: true });
  await fs.rm(lockPath, { force: true });
  await fs.rm(ledgerLockPath, { force: true });
  await fs.rm(archiveLockPath, { force: true });
  await fs.rm(marketAnalysisLockPath, { force: true });
  await fs.rm(marketSeedLockPath, { force: true });
}
