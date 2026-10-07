import { sha256Canonical } from "./snapshot-quality-pipeline.mjs";
import { normalizeStockCode } from "./stock-code.mjs";
import { locateExecutionTradingDay } from "./execution-return-resolver.mjs";

export const INTRADAY_MODEL_TOP_EXECUTION_POLICY_ID = "intraday-1430-t1-open-v1";
export const INTRADAY_MODEL_TOP_HORIZONS = Object.freeze({
  "1DAY": { holdingTradingDays: 1, offsetFromEntry: 0 },
  "5DAY": { holdingTradingDays: 5, offsetFromEntry: 4 },
  "20DAY": { holdingTradingDays: 20, offsetFromEntry: 19 },
  "60DAY": { holdingTradingDays: 60, offsetFromEntry: 59 },
});

const finitePrice = (value) => Number.isFinite(Number(value)) && Number(value) > 0;
const roundReturn = (value) => Number(value.toFixed(6));
const ledgerRecord = (ledgers, date, ticker) => ledgers.get(date)?.recordsByCode?.get(normalizeStockCode(ticker)) ?? null;
const targetStatus = (target) => target.status === "pendingFutureTradingDay" ? "PENDING" : target.status === "resolved" ? "MATURE" : "DATA_MISSING";

function createObservationRecords(signal) {
  const records = [];
  for (const record of signal.records ?? []) {
    if (record.dataStatus !== "AVAILABLE") continue;
    for (const [modelVersion, rank] of Object.entries(record.ranks ?? {})) {
      if (!Number.isInteger(rank) || rank < 1 || rank > 20) continue;
      records.push({
        observationId: record.observationIds?.[modelVersion] ?? null,
        modelVersion,
        ticker: record.ticker,
        companyName: record.companyName,
        rank,
        topNs: [5, 10, 20].filter((topN) => rank <= topN),
        entry: { status: "PENDING", tradingDate: null, timestamp: null, price: null, priceBasis: "nextTradingDayOfficialOpen", reason: "futureTradingDayPending" },
        horizons: Object.fromEntries(Object.keys(INTRADAY_MODEL_TOP_HORIZONS).map((horizon) => [horizon, { status: "PENDING", targetTradingDate: null, closePrice: null, returnPercent: null, reason: "futureTradingDayPending", resolvedAt: null }])),
      });
    }
  }
  return records.sort((left, right) => left.modelVersion.localeCompare(right.modelVersion) || left.rank - right.rank || left.ticker.localeCompare(right.ticker));
}

export function resolveIntradayModelTopOutcomes({ signal, existing = null, priceLedgers = [], tradingCalendar, resolvedAt }) {
  if (signal?.observationType !== "LIVE_OBSERVATION" || signal?.status !== "READY" || signal?.officialSignalTime !== "14:30:00") throw new Error("INTRADAY_LIVE_SIGNAL_INVALID");
  const ledgers = new Map(priceLedgers.map((ledger) => [ledger.date, ledger]));
  const previous = new Map((existing?.records ?? []).map((record) => [record.observationId, record]));
  const records = createObservationRecords(signal);
  const entryTarget = locateExecutionTradingDay(tradingCalendar, signal.signalDate, 1);
  for (const record of records) {
    const prior = previous.get(record.observationId);
    if (prior?.entry?.status === "MATURE") record.entry = structuredClone(prior.entry);
    else if (entryTarget.status !== "resolved") record.entry = { ...record.entry, status: targetStatus(entryTarget), reason: entryTarget.status, tradingDate: entryTarget.date };
    else {
      const price = ledgerRecord(ledgers, entryTarget.date, record.ticker);
      if (!ledgers.has(entryTarget.date)) record.entry = { ...record.entry, status: "DATA_MISSING", tradingDate: entryTarget.date, reason: "missingEntryLedger" };
      else if (!price) record.entry = { ...record.entry, status: "DATA_MISSING", tradingDate: entryTarget.date, reason: "missingEntryTicker" };
      else if (price.executable === false) record.entry = { ...record.entry, status: "DATA_MISSING", tradingDate: entryTarget.date, reason: "notExecutable" };
      else if (!finitePrice(price.openPrice)) record.entry = { ...record.entry, status: "DATA_MISSING", tradingDate: entryTarget.date, reason: "missingEntryOpenPrice" };
      else record.entry = { status: "MATURE", tradingDate: entryTarget.date, timestamp: `${entryTarget.date}T09:00:00+09:00`, price: Number(price.openPrice), priceBasis: "nextTradingDayOfficialOpen", reason: null };
    }
    for (const [horizon, policy] of Object.entries(INTRADAY_MODEL_TOP_HORIZONS)) {
      if (prior?.horizons?.[horizon]?.status === "MATURE") { record.horizons[horizon] = structuredClone(prior.horizons[horizon]); continue; }
      if (record.entry.status !== "MATURE") {
        record.horizons[horizon] = { ...record.horizons[horizon], status: record.entry.status, reason: `entry:${record.entry.reason}` };
        continue;
      }
      const target = policy.offsetFromEntry === 0 ? { status: "resolved", date: record.entry.tradingDate } : locateExecutionTradingDay(tradingCalendar, record.entry.tradingDate, policy.offsetFromEntry);
      if (target.status !== "resolved") {
        record.horizons[horizon] = { ...record.horizons[horizon], status: targetStatus(target), targetTradingDate: target.date, reason: target.status };
        continue;
      }
      const price = ledgerRecord(ledgers, target.date, record.ticker);
      if (!ledgers.has(target.date)) record.horizons[horizon] = { ...record.horizons[horizon], status: "DATA_MISSING", targetTradingDate: target.date, reason: "missingExitLedger" };
      else if (!price) record.horizons[horizon] = { ...record.horizons[horizon], status: "DATA_MISSING", targetTradingDate: target.date, reason: "missingExitTicker" };
      else if (price.executable === false) record.horizons[horizon] = { ...record.horizons[horizon], status: "DATA_MISSING", targetTradingDate: target.date, reason: "notExecutable" };
      else if (!finitePrice(price.closePrice)) record.horizons[horizon] = { ...record.horizons[horizon], status: "DATA_MISSING", targetTradingDate: target.date, reason: "missingExitClosePrice" };
      else record.horizons[horizon] = { status: "MATURE", targetTradingDate: target.date, closePrice: Number(price.closePrice), returnPercent: roundReturn((Number(price.closePrice) / record.entry.price - 1) * 100), reason: null, resolvedAt };
    }
  }
  const summary = Object.fromEntries(Object.keys(INTRADAY_MODEL_TOP_HORIZONS).map((horizon) => [horizon, {
    sampleCount: records.filter((record) => record.horizons[horizon].status === "MATURE").length,
    maturity: Object.fromEntries(["PENDING", "MATURE", "DATA_MISSING"].map((status) => [status, records.filter((record) => record.horizons[horizon].status === status).length])),
  }]));
  const base = {
    schemaVersion: 1,
    dataset: "intraday-model-top-execution-outcomes",
    layer: "INTRADAY_1430_LIVE",
    signalDate: signal.signalDate,
    signalTime: signal.officialSignalTime,
    signalContentHash: signal.contentHash,
    executionPolicy: { policyId: INTRADAY_MODEL_TOP_EXECUTION_POLICY_ID, entryTradingDayOffset: 1, entryPriceBasis: "officialDailyOpen", rationale: "first reproducible official price after a finalized 14:30 signal; intraday executable quote ledger is not stored", grossReturn: true, transactionCostsIncluded: false, slippageIncluded: false },
    horizons: INTRADAY_MODEL_TOP_HORIZONS,
    generatedAt: existing?.generatedAt ?? resolvedAt,
    updatedAt: resolvedAt,
    source: { signalDataset: signal.artifactType, signalHash: signal.contentHash, marketPriceLedger: "data/market-prices/YYYY-MM-DD.json", tradingCalendar: "data/trading-calendar/status.json" },
    records,
    summary,
  };
  return { ...base, contentHash: sha256Canonical(base) };
}

export function validateIntradayModelTopOutcomes(value) {
  const errors = [];
  if (value?.schemaVersion !== 1 || value?.dataset !== "intraday-model-top-execution-outcomes" || value?.layer !== "INTRADAY_1430_LIVE") errors.push("schema");
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value?.signalDate ?? "") || value?.signalTime !== "14:30:00") errors.push("signal");
  if (value?.executionPolicy?.policyId !== INTRADAY_MODEL_TOP_EXECUTION_POLICY_ID) errors.push("executionPolicy");
  if (!Array.isArray(value?.records) || value.records.some((record) => !record.observationId || !["A-v1", "B-v1", "C-v1", "D-v1"].includes(record.modelVersion))) errors.push("records");
  const { contentHash, ...base } = value ?? {};
  if (contentHash !== sha256Canonical(base)) errors.push("contentHash");
  return [...new Set(errors)];
}
