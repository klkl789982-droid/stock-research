import { CONFIGURED_MODEL_KEYS, SNAPSHOT_MODEL_KEYS } from "./model-score-engine.mjs";

export const MODEL_HISTORY_SCHEMA_VERSION = 3;

export const MODEL_DEFINITIONS = {
  A: { name: "technicalStrength", modelVersion: "A-v1", status: "active" },
  B: { name: "trendStrength", modelVersion: "B-v1", status: "experimental" },
  C: { name: "entryStrength", modelVersion: "C-v1", status: "experimental" },
  D: { name: "combinedTechnicalScore", modelVersion: "D-v1", status: "experimental" },
  E: { name: "modelE", modelVersion: "E-v1", status: "notConfigured" },
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
  modelB,
  modelC,
  modelD,
  modelE = null,
}) {
  return {
    date: asOfDate,
    code: stock.code,
    name: stock.name,
    market: stock.market,
    marketCap: stock.marketCap,
    avgVolume20d,
    historyRows,
    openPrice,
    closePrice,
    scores: {
      modelA: modelA.finalTechnicalScore,
      modelB: modelB.trendStrength,
      modelC: modelC.entryStrength,
      modelD,
      modelE,
    },
    ranks: {
      modelA: null,
      modelB: null,
      modelC: null,
      modelD: null,
      modelE: null,
    },
    factors: {
      trendScore: modelB.trendStrength,
      maStructureScore: modelB.components.structure,
      trendPersistenceScore: modelB.components.persistence,
      momentumScore: modelB.components.momentum,
      macdScore: modelB.components.macdConfirmation,
      position52wScore: modelB.components.rangePosition,
      entryScore: modelC.entryStrength,
      priceActionScore: modelC.components.priceAction,
      volumeScore: modelC.components.volumeConfirmation,
      shortMomentumScore: modelC.components.shortMomentum,
      rsiMacdScore: modelC.components.turning,
      shortMAScore: modelC.components.shortTermIntegrity,
      riskPenalty: modelC.riskPenalty,
    },
    riskFlags: modelC.riskFlags,
    futureReturns: createFutureReturns(),
    backtestReturns: createBacktestReturns(),
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

export function validateSnapshot(snapshot, expectedCount = null) {
  const errors = [];

  if (snapshot.schemaVersion !== MODEL_HISTORY_SCHEMA_VERSION) {
    errors.push("지원하지 않는 schemaVersion입니다.");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(snapshot.asOfDate ?? "")) {
    errors.push("asOfDate 형식이 YYYY-MM-DD가 아닙니다.");
  }
  if (!Array.isArray(snapshot.records) || snapshot.records.length === 0) {
    errors.push("records가 비어 있습니다.");
  }
  if (expectedCount !== null && snapshot.records?.length !== expectedCount) {
    errors.push(`스냅샷 종목 수 불일치: ${snapshot.records?.length ?? 0}/${expectedCount}`);
  }

  const codes = new Set();
  for (const record of snapshot.records ?? []) {
    if (codes.has(record.code)) errors.push(`중복 종목코드: ${record.code}`);
    codes.add(record.code);
    if (!Number.isFinite(record.marketCap)) errors.push(`${record.code} marketCap이 유효하지 않습니다.`);
    if (!Number.isFinite(record.openPrice) || record.openPrice <= 0) {
      errors.push(`${record.code} openPrice가 유효하지 않습니다.`);
    }
    if (!Number.isFinite(record.avgVolume20d)) errors.push(`${record.code} avgVolume20d가 유효하지 않습니다.`);
    if (!Number.isInteger(record.historyRows) || record.historyRows < 20) {
      errors.push(`${record.code} 일봉 수가 20개 미만입니다.`);
    }
    if (record.backtestReturns?.entry?.priceBasis !== "nextTradingDayOpen") {
      errors.push(`${record.code} backtestReturns 기본 구조가 누락되었습니다.`);
    }
    for (const model of CONFIGURED_MODEL_KEYS) {
      if (!Number.isFinite(record.scores?.[model])) {
        errors.push(`${record.code} ${model} 점수가 유효하지 않습니다.`);
      }
      if (!Number.isInteger(record.ranks?.[model])) {
        errors.push(`${record.code} ${model} 순위가 누락되었습니다.`);
      }
    }
    if (record.scores?.modelE !== null) {
      errors.push(`${record.code} Model E는 정의 전까지 null이어야 합니다.`);
    }
  }

  for (const model of CONFIGURED_MODEL_KEYS) {
    const ranks = (snapshot.records ?? []).map((record) => record.ranks?.[model]).sort((a, b) => a - b);
    ranks.forEach((rank, index) => {
      if (rank !== index + 1) errors.push(`${model} 순위가 연속적이지 않습니다: ${rank} (예상 ${index + 1})`);
    });
    for (const size of [10, 20, 50]) {
      const list = snapshot.topLists?.[model]?.[`TOP${size}`];
      if (!Array.isArray(list) || list.length !== Math.min(size, snapshot.records?.length ?? 0)) {
        errors.push(`${model} TOP${size} 목록 수가 올바르지 않습니다.`);
      }
    }
  }

  if (snapshot.topLists?.modelE?.status !== "notConfigured") {
    errors.push("Model E TOP 목록은 공식 등록 전까지 notConfigured여야 합니다.");
  }

  return errors;
}
