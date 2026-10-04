import fs from "node:fs/promises";
import path from "node:path";
import { sha256Canonical } from "./snapshot-quality-pipeline.mjs";
import { normalizeStockCode } from "./stock-code.mjs";

const isValidClose = (value) => Number.isFinite(value) && value > 0;
const isDate = (value) => /^\d{4}-\d{2}-\d{2}$/u.test(value ?? "");
const addDays = (date, days) => {
  const result = new Date(`${date}T00:00:00Z`);
  result.setUTCDate(result.getUTCDate() + days);
  return result.toISOString().slice(0, 10);
};
const nextWeekday = (date) => {
  let candidate = addDays(date, 1);
  while ([0, 6].includes(new Date(`${candidate}T00:00:00Z`).getUTCDay())) candidate = addDays(candidate, 1);
  return candidate;
};

export function buildHistoricalOneDayBackfillPlan({ snapshots, coverageAsOfDate, discoveryWindowDays = 14 }) {
  if (!isDate(coverageAsOfDate)) throw new Error("coverageAsOfDate가 YYYY-MM-DD 형식이어야 합니다.");
  const signals = [...snapshots].sort((left, right) => left.asOfDate.localeCompare(right.asOfDate)).map((snapshot) => {
    const discoveryStartDate = nextWeekday(snapshot.asOfDate);
    const trackingCodes = snapshot.records.map((record) => normalizeStockCode(record.code)).filter(Boolean).sort();
    const availableSignalCloseCount = snapshot.records.filter((record) => isValidClose(record.closePrice)).length;
    const pending = discoveryStartDate > coverageAsOfDate;
    return {
      signalDate: snapshot.asOfDate,
      sourceSnapshotHash: snapshot.contentHash ?? sha256Canonical(snapshot),
      trackingUniverseCount: trackingCodes.length,
      trackingUniverseHash: sha256Canonical(trackingCodes),
      signalCloseAvailableCount: availableSignalCloseCount,
      status: pending ? "PENDING" : "DISCOVERY_REQUIRED",
      discoveryWindow: pending ? null : { beginBasDt: discoveryStartDate.replaceAll("-", ""), endBasDt: addDays(discoveryStartDate, discoveryWindowDays - 1).replaceAll("-", "") },
      targetCollection: pending ? null : { targetTradingDate: "toBeConfirmedFromOfficialEod", expectedRequests: trackingCodes.length, operation: "getStockPriceInfo" },
    };
  });
  return {
    schemaVersion: 1,
    dataset: "historical-one-day-outcome-backfill-plan",
    returnDefinition: "(targetTradingDayClose - signalDayClose) / signalDayClose * 100",
    coverageAsOfDate,
    source: { provider: "공공데이터포털", operation: "getStockPriceInfo" },
    signals,
    totals: {
      discoveryRequired: signals.filter((signal) => signal.status === "DISCOVERY_REQUIRED").length,
      pending: signals.filter((signal) => signal.status === "PENDING").length,
      expectedTargetRequests: signals.reduce((sum, signal) => sum + (signal.targetCollection?.expectedRequests ?? 0), 0),
    },
  };
}

export function createHistoricalOneDayPriceLedger({ signalSnapshot, targetTradingDate, collectedAt, source = "data-go-kr-official-daily-price", targetPrices }) {
  if (!isDate(signalSnapshot?.asOfDate) || !isDate(targetTradingDate) || targetTradingDate <= signalSnapshot.asOfDate) throw new Error("signalDate 이후의 targetTradingDate가 필요합니다.");
  if (!/^\d{4}-\d{2}-\d{2}T/u.test(collectedAt ?? "")) throw new Error("collectedAt이 필요합니다.");
  const sourceSnapshotHash = signalSnapshot.contentHash ?? sha256Canonical(signalSnapshot);
  const targetByCode = new Map(targetPrices.map((record) => [normalizeStockCode(record.code), record]).filter(([code]) => code));
  const records = signalSnapshot.records.map((record) => {
    const ticker = normalizeStockCode(record.code);
    const target = targetByCode.get(ticker);
    const signalClose = record.closePrice;
    const targetClose = target?.closePrice ?? null;
    const status = !isValidClose(signalClose) ? "DATA_MISSING" : !target ? "DATA_MISSING" : !isValidClose(targetClose) ? "DATA_MISSING" : "MATURE";
    const reason = status === "MATURE"
      ? null
      : !isValidClose(signalClose)
        ? "signalCloseUnavailable"
        : !target
          ? "symbolPriceMissing"
          : target.missingReason ?? "targetCloseUnavailable";
    return { ticker, signalClose: isValidClose(signalClose) ? signalClose : null, targetClose: isValidClose(targetClose) ? targetClose : null, status, reason, sourceReferenceDate: target?.sourceReferenceDate ?? targetTradingDate };
  }).sort((left, right) => left.ticker.localeCompare(right.ticker));
  const base = {
    schemaVersion: 1,
    dataset: "historical-one-day-price-ledger",
    signalDate: signalSnapshot.asOfDate,
    targetTradingDate,
    sourceSnapshotHash,
    source,
    collectedAt,
    returnDefinition: "(targetTradingDayClose - signalDayClose) / signalDayClose * 100",
    records,
  };
  return { ...base, contentHash: sha256Canonical(base) };
}

export function reconcileHistoricalOneDayOutcomes({ snapshots, priceLedgers }) {
  const snapshotsByDate = new Map(snapshots.map((snapshot) => [snapshot.asOfDate, snapshot]));
  return priceLedgers.map((ledger) => {
    const snapshot = snapshotsByDate.get(ledger.signalDate);
    if (!snapshot) throw new Error(`${ledger.signalDate}: signal snapshot이 없습니다.`);
    const expectedHash = snapshot.contentHash ?? sha256Canonical(snapshot);
    if (ledger.sourceSnapshotHash !== expectedHash) throw new Error(`${ledger.signalDate}: sourceSnapshotHash가 일치하지 않습니다.`);
    const records = ledger.records.map((record) => ({
      ticker: record.ticker,
      signalClose: record.signalClose,
      targetClose: record.targetClose,
      status: record.status,
      reason: record.reason,
      returnPercent: record.status === "MATURE" ? Number(((record.targetClose - record.signalClose) / record.signalClose * 100).toFixed(6)) : null,
    }));
    const base = { schemaVersion: 1, dataset: "historical-one-day-outcomes", signalDate: ledger.signalDate, targetTradingDate: ledger.targetTradingDate, sourcePriceLedgerHash: ledger.contentHash, returnDefinition: ledger.returnDefinition, records };
    return { ...base, contentHash: sha256Canonical(base) };
  });
}

const modelScoreAndRank = (record, model) => {
  if (model === "A-v1") return { score: record.scoresByVersion?.[model] ?? record.scores?.modelA, rank: record.ranksByVersion?.[model] ?? record.ranks?.modelA };
  if (model === "A-v2") return { score: record.scoresByVersion?.[model], rank: record.ranksByVersion?.[model] };
  const key = { "B-v1": "modelB", "C-v1": "modelC", "D-v1": "modelD" }[model];
  return { score: record.scores?.[key], rank: record.ranks?.[key] };
};

export function summarizeHistoricalOneDayModelOutcomes({ snapshots, outcomes }) {
  const models = ["A-v1", "A-v2", "B-v1", "C-v1", "D-v1"];
  const outcomeByDate = new Map(outcomes.map((outcome) => [outcome.signalDate, new Map(outcome.records.map((record) => [record.ticker, record]))]));
  const values = Object.fromEntries(models.map((model) => [model, []]));
  for (const snapshot of snapshots) {
    const outcomeByTicker = outcomeByDate.get(snapshot.asOfDate);
    if (!outcomeByTicker) continue;
    for (const record of snapshot.records) {
      const outcome = outcomeByTicker.get(normalizeStockCode(record.code));
      if (outcome?.status !== "MATURE" || !Number.isFinite(outcome.returnPercent)) continue;
      for (const model of models) {
        const value = modelScoreAndRank(record, model);
        if (Number.isFinite(value.score) && Number.isInteger(value.rank)) values[model].push(outcome.returnPercent);
      }
    }
  }
  return Object.fromEntries(models.map((model) => {
    const returns = values[model].sort((left, right) => left - right);
    const count = returns.length;
    const median = count === 0 ? null : count % 2 ? returns[(count - 1) / 2] : Number(((returns[count / 2 - 1] + returns[count / 2]) / 2).toFixed(6));
    return [model, {
      observationCount: count,
      meanReturn: count === 0 ? null : Number((returns.reduce((sum, value) => sum + value, 0) / count).toFixed(6)),
      medianReturn: median,
      positiveRate: count === 0 ? null : Number((returns.filter((value) => value > 0).length / count * 100).toFixed(4)),
      minReturn: count === 0 ? null : returns[0],
      maxReturn: count === 0 ? null : returns.at(-1),
    }];
  }));
}

export async function writeHistoricalOneDayOutcomeArtifacts({ root = process.cwd(), priceLedger, outcome }) {
  if (priceLedger.signalDate !== outcome.signalDate || priceLedger.targetTradingDate !== outcome.targetTradingDate) throw new Error("price ledger와 outcome의 signal/target 날짜가 일치하지 않습니다.");
  const priceDirectory = path.join(root, "data", "historical-outcome-prices");
  const outcomeDirectory = path.join(root, "data", "historical-outcomes", "1d");
  await Promise.all([fs.mkdir(priceDirectory, { recursive: true }), fs.mkdir(outcomeDirectory, { recursive: true })]);
  const pricePath = path.join(priceDirectory, `${priceLedger.signalDate}.json`);
  const outcomePath = path.join(outcomeDirectory, `${outcome.signalDate}.json`);
  for (const [target, value] of [[pricePath, priceLedger], [outcomePath, outcome]]) {
    try {
      await fs.writeFile(target, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    } catch (error) {
      if (error?.code === "EEXIST") throw new Error(`${path.relative(root, target).replaceAll("\\", "/")}: immutable historical outcome artifact가 이미 존재합니다.`);
      throw error;
    }
  }
  return { pricePath: path.relative(root, pricePath).replaceAll("\\", "/"), outcomePath: path.relative(root, outcomePath).replaceAll("\\", "/") };
}
