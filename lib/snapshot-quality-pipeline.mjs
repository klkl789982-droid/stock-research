import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { normalizeStockCode } from "./stock-code.mjs";

export const SOURCE_MANIFEST_SCHEMA_VERSION = 2;

export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

export function sha256Canonical(value) {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

export function normalizeHistoryForHash(historyByCode) {
  return [...historyByCode.entries()]
    .map(([rawCode, rows]) => ({ code: normalizeStockCode(rawCode), rows: [...rows].sort((a, b) => String(b.basDt).localeCompare(String(a.basDt))).map(canonicalize) }))
    .filter((entry) => entry.code)
    .sort((a, b) => a.code.localeCompare(b.code));
}

export function createFormulaHashes(formulaSources) {
  return Object.fromEntries(Object.entries(formulaSources).sort(([a], [b]) => a.localeCompare(b)).map(([version, source]) => [version, createHash("sha256").update(source).digest("hex")]));
}

export function createSourceManifest({ requestedDate, generatedAt, universe, historyByCode, formulaHashes, policy }) {
  const latestDates = [...historyByCode.values()].map((rows) => String(rows[0]?.basDt ?? "")).sort();
  const universeInput = [...universe.stocks]
    .map((stock) => ({ ...canonicalize(stock), code: normalizeStockCode(stock.code) }))
    .filter((stock) => stock.code)
    .sort((a, b) => a.code.localeCompare(b.code));
  return {
    schemaVersion: SOURCE_MANIFEST_SCHEMA_VERSION,
    requestedDate,
    generatedAt,
    sources: {
      securityMaster: { provider: "KIS", asOfDate: null, pointInTimeCertified: policy.pointInTimeMasterCertified, contentHash: null },
      officialDailyPrice: {
        provider: "공공데이터포털", service: "getStockPriceInfo", requestedDate,
        minimumLatestBasDt: latestDates.at(0) ?? null, maximumLatestBasDt: latestDates.at(-1) ?? null,
        rawResponseStored: policy.rawResponseStored, normalizedInputHash: sha256Canonical(normalizeHistoryForHash(historyByCode)),
      },
    },
    universe: { filterVersion: policy.universeFilterVersion, contentHash: sha256Canonical(universeInput) },
    modelFormulaHashes: formulaHashes,
    marketDataNormalizationVersion: policy.marketDataNormalizationVersion ?? "v1",
  };
}

export function buildUniverseSummary(quality, activeComparisonModels) {
  const observedCodes = Object.keys(quality.perSymbol).sort();
  const modelEligibleUniverse = {};
  for (const [version, eligibility] of Object.entries(quality.modelEligibility)) {
    const codes = [...eligibility.eligibleCodes].sort();
    modelEligibleUniverse[version] = { count: codes.length, codesHash: sha256Canonical(codes), excludedCount: observedCodes.length - codes.length };
  }
  const activeSets = activeComparisonModels.map((version) => new Set(quality.modelEligibility[version]?.eligibleCodes ?? []));
  const commonCodes = observedCodes.filter((code) => activeSets.every((set) => set.has(code)));
  return {
    observedUniverse: { count: observedCodes.length, codesHash: sha256Canonical(observedCodes) },
    modelEligibleUniverse,
    commonComparisonUniverse: { activeModels: [...activeComparisonModels], count: commonCodes.length, codesHash: sha256Canonical(commonCodes) },
  };
}

export function buildExcludedFromScoring(quality, stocksByCode) {
  const excluded = [];
  for (const [modelVersion, eligibility] of Object.entries(quality.modelEligibility)) {
    for (const code of eligibility.ineligibleCodes) {
      excluded.push({
        code, name: stocksByCode.get(code)?.name ?? null, modelVersion,
        reason: eligibility.reasons[code], requiredTradingDays: quality.requirements.models[modelVersion],
        availableTradingDays: quality.perSymbol[code]?.uniqueTradingDays ?? 0,
      });
    }
  }
  return excluded.sort((a, b) => a.modelVersion.localeCompare(b.modelVersion) || a.code.localeCompare(b.code));
}

export function annotateRankingMetadata(records) {
  const models = ["modelA", "modelB", "modelC", "modelD"];
  for (const model of models) {
    const count = records.filter((record) => Number.isInteger(record.ranks?.[model])).length;
    for (const record of records) {
      const rank = record.ranks?.[model];
      record.rankingUniverseCount[model] = Number.isInteger(rank) ? count : null;
      record.rankPercentile[model] = Number.isInteger(rank) && count > 0 ? Number((rank / count).toFixed(12)) : null;
    }
  }
  const count = records.filter((record) => Number.isInteger(record.ranksByVersion?.["A-v2"])).length;
  for (const record of records) {
    const rank = record.ranksByVersion?.["A-v2"];
    record.rankingUniverseCountByVersion["A-v2"] = Number.isInteger(rank) ? count : null;
    record.rankPercentileByVersion["A-v2"] = Number.isInteger(rank) && count > 0 ? Number((rank / count).toFixed(12)) : null;
  }
}

export function createDataQualityMetadata(quality, requestedDate) {
  const types = (severity) => quality.issues.filter((entry) => entry.severity === severity).map((entry) => entry.type);
  const countType = (type) => quality.issues.filter((entry) => entry.type === type).length;
  return {
    schemaVersion: quality.schemaVersion, overallGrade: quality.grade, structuralStatus: quality.summary.structuralStatus, asOfDate: requestedDate,
    coverage: { expected: quality.summary.expectedUniverseCount, received: quality.summary.historyCodeCount, valid: quality.summary.exactDateMatches, missingCodes: quality.summary.missingHistoryCodes, unexpectedCodes: quality.summary.unexpectedHistoryCodes },
    freshness: { requestedDate, minimumBasDt: Object.values(quality.perSymbol).map((item) => item.latestBasDt).filter(Boolean).sort().at(0) ?? null, maximumBasDt: Object.values(quality.perSymbol).map((item) => item.latestBasDt).filter(Boolean).sort().at(-1) ?? null, exactMatchCount: quality.summary.exactDateMatches, staleCount: countType("latestDateMismatch") },
    integrity: {
      duplicateCodes: quality.summary.duplicateUniverseCodes.length, duplicateCodeDates: quality.summary.duplicateDateRows,
      invalidOpen: quality.issues.filter((entry) => entry.type === "invalidPrice").length,
      invalidHigh: quality.issues.filter((entry) => entry.type === "invalidPrice").length,
      invalidLow: quality.issues.filter((entry) => entry.type === "invalidPrice").length,
      invalidClose: countType("invalidClose"),
      invalidOhlcRelationships: countType("invalidOhlcRelationship"),
      negativeVolume: countType("invalidVolume"), zeroVolumeRows: quality.summary.zeroVolumeRows,
      insufficientHistoryByModel: Object.fromEntries(Object.entries(quality.modelEligibility).map(([version, value]) => [version, value.ineligibleCodes.filter((code) => value.reasons[code] === "insufficientHistory").length])),
    },
    certification: { eligibleForDisplay: true, eligibleForRanking: quality.status === "passed", eligibleForRankBacktest: false, eligibleForScoreBucketBacktest: false, eligibleForOptimization: quality.eligibleForOptimization },
    blockingReasons: [...new Set([...types("fatal"), ...types("warning"), "rawResponseNotStored"])].sort(), warnings: quality.issues.filter((entry) => entry.severity === "warning"),
  };
}

export function createUniverseArchive({ requestedDate, generatedAt, universe, historyByCode, sourceManifest }) {
  const observedUniverse = [...universe.stocks].map((stock) => ({ ...stock, code: normalizeStockCode(stock.code) })).filter((stock) => stock.code).sort((a, b) => a.code.localeCompare(b.code)).map((stock) => {
    const rows = historyByCode.get(stock.code);
    const recent20 = rows.slice(0, 20);
    return {
      code: stock.code, name: stock.name, market: stock.market,
      marketCap: Number(rows[0].mrktTotAmt), marketCapAsOfDate: requestedDate,
      tradingValues: recent20.map((row) => Number(row.trPrc)),
      averageTradingValue20: recent20.reduce((sum, row) => sum + Number(row.trPrc), 0) / 20,
      tradingValueDates: recent20.map((row) => String(row.basDt)),
    };
  });
  const base = { schemaVersion: 1, requestedDate, generatedAt, filterVersion: sourceManifest.universe.filterVersion, criteria: universe.criteria, observedUniverse, sourceManifest: { schemaVersion: sourceManifest.schemaVersion, securityMaster: sourceManifest.sources.securityMaster, officialDailyPriceHash: sourceManifest.sources.officialDailyPrice.normalizedInputHash } };
  return { ...base, contentHash: sha256Canonical(base) };
}

export function buildTrackingUniverse(observedStocks, historicalSnapshots) {
  const tracking = new Map(observedStocks.map((stock) => { const code = normalizeStockCode(stock.code); return [code, { code, name: stock.name, market: stock.market, reasons: new Set(["currentObservedUniverse"]) }]; }).filter(([code]) => code));
  for (const snapshot of historicalSnapshots) {
    for (const record of snapshot.records ?? []) {
      const predictionPending = ["future1dReturn", "future5dReturn", "future20dReturn"].some((key) => !Number.isFinite(record.futureReturns?.[key]));
      const backtestPending = ["nextOpenToT1CloseReturn", "nextOpenToT5CloseReturn", "nextOpenToT20CloseReturn"].some((key) => !Number.isFinite(record.backtestReturns?.returns?.[key]));
      if (!predictionPending && !backtestPending) continue;
      const code = normalizeStockCode(record.code);
      if (!code) continue;
      const item = tracking.get(code) ?? { code, name: record.name, market: record.market, reasons: new Set() };
      if (predictionPending) item.reasons.add("unresolvedFutureReturn");
      if (backtestPending) item.reasons.add("unresolvedBacktestReturn");
      tracking.set(code, item);
    }
  }
  return [...tracking.values()].sort((a, b) => a.code.localeCompare(b.code)).map((item) => ({ ...item, reasons: [...item.reasons].sort() }));
}

export async function checkUniverseArchive(existingPath, archive) {
  try {
    const existing = JSON.parse(await fs.readFile(existingPath, "utf8"));
    if (existing.contentHash === archive.contentHash) return "idempotent";
    throw new Error(`Universe 아카이브 해시 충돌: ${existingPath}`);
  } catch (error) {
    if (error?.code === "ENOENT") return "create";
    throw error;
  }
}

export function assertSnapshotQualityGate(quality) {
  const fatalIssues = quality.issues.filter((entry) => entry.severity === "fatal");
  if (fatalIssues.length > 0) {
    const error = new Error("시장 데이터 구조 검증에 실패했습니다.");
    error.code = "MARKET_DATA_QUALITY_FATAL";
    error.issues = fatalIssues;
    throw error;
  }
}

export async function commitNewArtifactSet(artifacts, options = {}) {
  const committed = [];
  const temporary = [];
  for (const artifact of artifacts) {
    try { await fs.access(artifact.path); throw new Error(`대상 파일이 이미 존재합니다: ${artifact.path}`); }
    catch (error) { if (error?.code !== "ENOENT") throw error; }
  }
  try {
    for (const artifact of artifacts) {
      const tempPath = `${artifact.path}.tmp-${process.pid}`;
      await fs.writeFile(tempPath, artifact.content, { encoding: "utf8", flag: "wx" });
      temporary.push(tempPath);
    }
    for (let index = 0; index < artifacts.length; index += 1) {
      await fs.rename(temporary[index], artifacts[index].path);
      committed.push(artifacts[index].path);
      if (options.failAfterCommit === committed.length) throw new Error("syntheticCommitFailure");
    }
  } catch (error) {
    for (const file of committed.reverse()) await fs.rm(file, { force: true });
    throw error;
  } finally {
    for (const file of temporary) await fs.rm(file, { force: true });
  }
}
