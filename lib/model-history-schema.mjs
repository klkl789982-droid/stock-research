import { CONFIGURED_MODEL_KEYS, SNAPSHOT_MODEL_KEYS } from "./model-score-engine.mjs";
import { assignModelAV2Ranks, MODEL_A_V2_FORMULA_HASH, MODEL_A_V2_VERSION } from "./technical-strength-v2.mjs";
import { normalizeStockCode } from "./stock-code.mjs";
import { createExecutionReturns, createLegacyClassification, PUBLIC_EOD_T2_POLICY_ID } from "./execution-return-resolver.mjs";

export const MODEL_HISTORY_SCHEMA_VERSION = 6;
export const READABLE_MODEL_HISTORY_SCHEMA_VERSIONS = [2, 3, 4, 5, 6];
export function isReadableModelHistorySchemaVersion(version) {
  return READABLE_MODEL_HISTORY_SCHEMA_VERSIONS.includes(version);
}

export const MODEL_DEFINITIONS = {
  A: { name: "technicalStrength", modelVersion: "A-v1", status: "active" },
  B: { name: "trendStrength", modelVersion: "B-v1", status: "experimental" },
  C: { name: "entryStrength", modelVersion: "C-v1", status: "experimental" },
  D: { name: "combinedTechnicalScore", modelVersion: "D-v1", status: "experimental" },
  E: { name: "modelE", modelVersion: "E-v1", status: "notConfigured" },
};

export const MODEL_VERSION_DEFINITIONS = {
  "A-v1": { modelId: "A", role: "champion", status: "active", scoreRange: null },
  "A-v2": {
    modelId: "A",
    role: "challenger",
    status: "evaluation",
    scoreRange: { min: 0, max: 100 },
    formulaHash: MODEL_A_V2_FORMULA_HASH,
    tieBreakBasis: "finalScoreThenRawScoreThenCode",
  },
};

export function createFutureReturns() {
  return {
    future1dReturn: null,
    future5dReturn: null,
    future20dReturn: null,
    resolvedAt: {
      future1dDate: null,
      future5dDate: null,
      future20dDate: null,
    },
  };
}

export function createBacktestReturns() {
  return {
    status: "pendingEntryPrice",
    entry: {
      priceBasis: "nextTradingDayOpen",
      date: null,
      openPrice: null,
    },
    returns: {
      nextOpenToT1CloseReturn: null,
      nextOpenToT5CloseReturn: null,
      nextOpenToT20CloseReturn: null,
    },
    exits: {
      t1: { date: null, closePrice: null },
      t5: { date: null, closePrice: null },
      t20: { date: null, closePrice: null },
    },
    resolution: {
      entryStatus: "pending",
      t1Status: "pending",
      t5Status: "pending",
      t20Status: "pending",
      reason: null,
    },
  };
}

export function createHistoryRecord({
  stock,
  asOfDate,
  closePrice,
  openPrice,
  avgVolume20d,
  historyRows,
  modelA,
  modelAV2,
  modelB,
  modelC,
  modelD,
  modelE = null,
}) {
  return {
    date: asOfDate,
    code: normalizeStockCode(stock.code),
    name: stock.name,
    market: stock.market,
    marketCap: stock.marketCap,
    avgVolume20d,
    historyRows,
    openPrice,
    closePrice,
    scores: {
      modelA: modelA?.finalTechnicalScore ?? null,
      modelB: modelB?.trendStrength ?? null,
      modelC: modelC?.entryStrength ?? null,
      modelD,
      modelE,
    },
    scoresByVersion: {
      "A-v1": modelA?.finalTechnicalScore ?? null,
      [MODEL_A_V2_VERSION]: modelAV2?.finalScore ?? null,
    },
    rawScoresByVersion: {
      [MODEL_A_V2_VERSION]: modelAV2?.rawScore ?? null,
    },
    ranks: {
      modelA: null,
      modelB: null,
      modelC: null,
      modelD: null,
      modelE: null,
    },
    ranksByVersion: {
      "A-v1": null,
      [MODEL_A_V2_VERSION]: null,
    },
    modelDetailsByVersion: {
      [MODEL_A_V2_VERSION]: modelAV2,
    },
    factors: {
      trendScore: modelB?.trendStrength ?? null,
      maStructureScore: modelB?.components.structure ?? null,
      trendPersistenceScore: modelB?.components.persistence ?? null,
      momentumScore: modelB?.components.momentum ?? null,
      macdScore: modelB?.components.macdConfirmation ?? null,
      position52wScore: modelB?.components.rangePosition ?? null,
      entryScore: modelC?.entryStrength ?? null,
      priceActionScore: modelC?.components.priceAction ?? null,
      volumeScore: modelC?.components.volumeConfirmation ?? null,
      shortMomentumScore: modelC?.components.shortMomentum ?? null,
      rsiMacdScore: modelC?.components.turning ?? null,
      shortMAScore: modelC?.components.shortTermIntegrity ?? null,
      riskPenalty: modelC?.riskPenalty ?? null,
    },
    riskFlags: modelC?.riskFlags ?? null,
    rankingUniverseCount: { modelA: null, modelB: null, modelC: null, modelD: null },
    rankPercentile: { modelA: null, modelB: null, modelC: null, modelD: null },
    rankingUniverseCountByVersion: { [MODEL_A_V2_VERSION]: null },
    rankPercentileByVersion: { [MODEL_A_V2_VERSION]: null },
    futureReturns: createFutureReturns(),
    backtestReturns: createBacktestReturns(),
    executionReturnsByPolicy: { [PUBLIC_EOD_T2_POLICY_ID]: createExecutionReturns(asOfDate, null) },
    legacyBacktestReturnsClassification: createLegacyClassification(),
  };
}

export function assignRanks(records) {
  for (const model of SNAPSHOT_MODEL_KEYS) {
    const ranked = records
      .filter((record) => Number.isFinite(record.scores[model]))
      .sort((a, b) => b.scores[model] - a.scores[model]);

    ranked.forEach((record, index) => {
      record.ranks[model] = index + 1;
    });
  }
  for (const record of records) record.ranksByVersion["A-v1"] = record.ranks.modelA;
  assignModelAV2Ranks(records);
}

export function createTopListsByVersion(records) {
  const ranked = records
    .filter((record) => Number.isInteger(record.ranksByVersion?.[MODEL_A_V2_VERSION]))
    .sort((left, right) => left.ranksByVersion[MODEL_A_V2_VERSION] - right.ranksByVersion[MODEL_A_V2_VERSION]);
  const toItem = (record) => ({
    rank: record.ranksByVersion[MODEL_A_V2_VERSION], code: record.code, name: record.name, market: record.market,
    score: record.scoresByVersion[MODEL_A_V2_VERSION], rawScore: record.rawScoresByVersion[MODEL_A_V2_VERSION],
  });
  return { [MODEL_A_V2_VERSION]: { status: ranked.length > 0 ? "available" : "notConfigured", TOP10: ranked.slice(0, 10).map(toItem), TOP20: ranked.slice(0, 20).map(toItem), TOP50: ranked.slice(0, 50).map(toItem) } };
}

export function createTopLists(records) {
  const topLists = {};
  for (const model of SNAPSHOT_MODEL_KEYS) {
    const ranked = records
      .filter((record) => Number.isInteger(record.ranks[model]))
      .sort((a, b) => a.ranks[model] - b.ranks[model]);
    topLists[model] = {
      status: ranked.length > 0 ? "available" : "notConfigured",
      TOP10: ranked.slice(0, 10).map((record) => toTopListItem(record, model)),
      TOP20: ranked.slice(0, 20).map((record) => toTopListItem(record, model)),
      TOP50: ranked.slice(0, 50).map((record) => toTopListItem(record, model)),
    };
  }
  return topLists;
}

function toTopListItem(record, model) {
  return {
    rank: record.ranks[model],
    code: record.code,
    name: record.name,
    market: record.market,
    score: record.scores[model],
  };
}

export function validateSnapshot(snapshot, expectedCount = null, options = {}) {
  const errors = [];

  if (snapshot.schemaVersion !== MODEL_HISTORY_SCHEMA_VERSION) {
    errors.push("지원하지 않는 schemaVersion입니다.");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(snapshot.asOfDate ?? "")) {
    errors.push("asOfDate 형식이 YYYY-MM-DD가 아닙니다.");
  }
  if (snapshot.schemaVersion === 6) {
    for (const field of ["sourceMarketDate", "sourceCollectedAt", "sourceStoredAt", "signalComputedAt", "signalAvailableAt", "sourceAvailabilityStatus", "sourcePublicationPolicyHash", "timingPolicyVersion"]) {
      if (snapshot[field] == null && !(options.dryRun && ["sourceStoredAt", "signalAvailableAt"].includes(field))) errors.push(`${field}가 누락되었습니다.`);
    }
  }
  if (!Array.isArray(snapshot.records) || snapshot.records.length === 0) {
    errors.push("records가 비어 있습니다.");
  }
  if (expectedCount !== null && snapshot.records?.length !== expectedCount) {
    errors.push(`스냅샷 종목 수 불일치: ${snapshot.records?.length ?? 0}/${expectedCount}`);
  }

  const codes = new Set();
  for (const record of snapshot.records ?? []) {
    const code = normalizeStockCode(record.code);
    if (!code) errors.push(`유효하지 않은 종목코드: ${record.code}`);
    if (code && codes.has(code)) errors.push(`중복 종목코드: ${code}`);
    if (code) codes.add(code);
    if (!Number.isFinite(record.marketCap)) errors.push(`${record.code} marketCap이 유효하지 않습니다.`);
    if (record.priceStatus === "tradingHaltOrNoTrade") {
      if (record.openPrice !== null || record.executable !== false || !Number.isFinite(record.referenceClose)) errors.push(`${record.code} 무거래 스냅샷 구조가 유효하지 않습니다.`);
    } else if (!Number.isFinite(record.openPrice) || record.openPrice <= 0) {
      errors.push(`${record.code} openPrice가 유효하지 않습니다.`);
    }
    if (!Number.isFinite(record.avgVolume20d)) errors.push(`${record.code} avgVolume20d가 유효하지 않습니다.`);
    if (!Number.isInteger(record.historyRows) || record.historyRows < 20) {
      errors.push(`${record.code} 일봉 수가 20개 미만입니다.`);
    }
    if (record.backtestReturns?.entry?.priceBasis !== "nextTradingDayOpen") {
      errors.push(`${record.code} backtestReturns 기본 구조가 누락되었습니다.`);
    }
    if (snapshot.schemaVersion === 6) {
      const execution = record.executionReturnsByPolicy?.[PUBLIC_EOD_T2_POLICY_ID];
      if (execution?.entry?.priceBasis !== "officialDailyOpen" || execution?.entry?.tradingDayOffset !== 2 || execution?.signalAvailableAt !== snapshot.signalAvailableAt) errors.push(`${record.code} 신규 실행수익률 기본 구조가 누락되었습니다.`);
      if (record.legacyBacktestReturnsClassification?.policyId !== "legacy-t1-open-v1" || record.legacyBacktestReturnsClassification?.eligibleForExecutableAggregation !== false) errors.push(`${record.code} legacy backtest 분류가 누락되었습니다.`);
    }
    for (const model of CONFIGURED_MODEL_KEYS) {
      const hasScore = Number.isFinite(record.scores?.[model]);
      const hasRank = Number.isInteger(record.ranks?.[model]);
      if (hasScore !== hasRank) errors.push(`${record.code} ${model} 점수와 순위 자격이 일치하지 않습니다.`);
    }
    if (record.scores?.modelE !== null) {
      errors.push(`${record.code} Model E는 정의 전까지 null이어야 합니다.`);
    }
    const hasAV2 = Number.isFinite(record.scoresByVersion?.[MODEL_A_V2_VERSION]);
    if (hasAV2 && (record.scoresByVersion[MODEL_A_V2_VERSION] < 0 || record.scoresByVersion[MODEL_A_V2_VERSION] > 100)) errors.push(`${record.code} A-v2 점수가 0~100 범위를 벗어났습니다.`);
    if (hasAV2 !== Number.isFinite(record.rawScoresByVersion?.[MODEL_A_V2_VERSION]) || hasAV2 !== Number.isInteger(record.ranksByVersion?.[MODEL_A_V2_VERSION])) errors.push(`${record.code} A-v2 점수와 순위 자격이 일치하지 않습니다.`);
    if (hasAV2 && record.modelDetailsByVersion?.[MODEL_A_V2_VERSION]?.formulaHash !== MODEL_A_V2_FORMULA_HASH) errors.push(`${record.code} A-v2 formulaHash가 일치하지 않습니다.`);
  }

  for (const model of CONFIGURED_MODEL_KEYS) {
    const ranks = (snapshot.records ?? []).map((record) => record.ranks?.[model]).filter(Number.isInteger).sort((a, b) => a - b);
    ranks.forEach((rank, index) => {
      if (rank !== index + 1) errors.push(`${model} 순위가 연속적이지 않습니다: ${rank} (예상 ${index + 1})`);
    });
    for (const size of [10, 20, 50]) {
      const list = snapshot.topLists?.[model]?.[`TOP${size}`];
      if (!Array.isArray(list) || list.length !== Math.min(size, ranks.length)) {
        errors.push(`${model} TOP${size} 목록 수가 올바르지 않습니다.`);
      }
    }
  }

  if (snapshot.topLists?.modelE?.status !== "notConfigured") {
    errors.push("Model E TOP 목록은 공식 등록 전까지 notConfigured여야 합니다.");
  }
  const versionRanks = (snapshot.records ?? []).map((record) => record.ranksByVersion?.[MODEL_A_V2_VERSION]).filter(Number.isInteger).sort((a, b) => a - b);
  versionRanks.forEach((rank, index) => { if (rank !== index + 1) errors.push(`A-v2 순위가 연속적이지 않습니다: ${rank} (예상 ${index + 1})`); });
  for (const size of [10, 20, 50]) {
    const list = snapshot.topListsByVersion?.[MODEL_A_V2_VERSION]?.[`TOP${size}`];
    if (!Array.isArray(list) || list.length !== Math.min(size, versionRanks.length)) errors.push(`A-v2 TOP${size} 목록 수가 올바르지 않습니다.`);
  }

  return errors;
}
