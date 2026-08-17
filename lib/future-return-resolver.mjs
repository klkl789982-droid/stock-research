import { normalizeStockCode } from "./stock-code.mjs";

export const FUTURE_RETURN_HORIZONS = [
  {
    offset: 1,
    predictionReturnKey: "future1dReturn",
    predictionDateKey: "future1dDate",
    backtestReturnKey: "nextOpenToT1CloseReturn",
    exitKey: "t1",
    exitStatusKey: "t1Status",
  },
  {
    offset: 5,
    predictionReturnKey: "future5dReturn",
    predictionDateKey: "future5dDate",
    backtestReturnKey: "nextOpenToT5CloseReturn",
    exitKey: "t5",
    exitStatusKey: "t5Status",
  },
  {
    offset: 20,
    predictionReturnKey: "future20dReturn",
    predictionDateKey: "future20dDate",
    backtestReturnKey: "nextOpenToT20CloseReturn",
    exitKey: "t20",
    exitStatusKey: "t20Status",
  },
];

const roundReturn = (value) => Number(value.toFixed(6));
const isValidPrice = (value) => Number.isFinite(value) && value > 0;

export function immutableSnapshotView(snapshot) {
  return {
    ...snapshot,
    records: snapshot.records.map((record) => {
      const immutableRecord = { ...record };
      delete immutableRecord.futureReturns;
      delete immutableRecord.backtestReturns;
      return immutableRecord;
    }),
  };
}

function nextCalendarDate(date) {
  const next = new Date(`${date}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}

function isWeekend(date) {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return day === 0 || day === 6;
}

export function createTradingCalendarIndex(calendar) {
  const dates = calendar?.dates ?? {};
  return { dates, maximumCheckedDate: Object.keys(dates).sort().at(-1) ?? null };
}

function locateFutureDate(calendar, signalDate, offset) {
  if (!calendar.maximumCheckedDate || signalDate >= calendar.maximumCheckedDate) {
    return { status: "pendingFutureTradingDay", date: null };
  }
  let cursor = nextCalendarDate(signalDate);
  let tradingDays = 0;
  while (cursor <= calendar.maximumCheckedDate) {
    const entry = calendar.dates[cursor];
    if (!entry) {
      if (isWeekend(cursor)) {
        cursor = nextCalendarDate(cursor);
        continue;
      }
      return { status: "unchecked", date: cursor };
    }
    if (entry.status === "marketClosed") {
      cursor = nextCalendarDate(cursor);
      continue;
    }
    if (entry.status === "collectionFailed" || entry.status === "unchecked") {
      return { status: entry.status, date: cursor };
    }
    if (entry.status !== "tradingDay") return { status: "unchecked", date: cursor };
    tradingDays += 1;
    if (tradingDays === offset) return { status: "resolved", date: cursor, entry };
    cursor = nextCalendarDate(cursor);
  }
  return { status: "pendingFutureTradingDay", date: null };
}

function classifyPrice(value, missingStatus) {
  if (value == null) return missingStatus;
  return isValidPrice(value) ? "resolved" : "invalidPrice";
}

function createBacktestReturns() {
  return {
    status: "pendingEntryPrice",
    entry: { priceBasis: "nextTradingDayOpen", date: null, openPrice: null },
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

function createStatistics() {
  const prediction = {};
  const backtest = {};
  for (const horizon of FUTURE_RETURN_HORIZONS) {
    prediction[horizon.predictionReturnKey] = { updated: 0, alreadyResolved: 0, pending: 0, failed: 0, completed: 0 };
    backtest[horizon.backtestReturnKey] = { updated: 0, alreadyResolved: 0, pending: 0, failed: 0, completed: 0 };
  }
  return {
    snapshotsScanned: 0,
    snapshotsUpdated: 0,
    updatedRecords: 0,
    failed: 0,
    pending: 0,
    horizons: prediction,
    backtestHorizons: backtest,
    statuses: {},
  };
}

function recordStatus(statistics, status) {
  statistics.statuses[status] = (statistics.statuses[status] ?? 0) + 1;
}

export function resolveFutureReturns(snapshots, marketPriceLedgers = [], tradingCalendar = { schemaVersion: 1, dates: {} }) {
  const ordered = [...snapshots].sort((a, b) => a.asOfDate.localeCompare(b.asOfDate));
  const snapshotByDate = new Map(ordered.map((snapshot) => [snapshot.asOfDate, snapshot]));
  const ledgerByDate = new Map(marketPriceLedgers.map((ledger) => [ledger.date, ledger]));
  const calendar = createTradingCalendarIndex(tradingCalendar);
  const statistics = createStatistics();
  statistics.snapshotsScanned = ordered.length;
  const changedDates = [];

  for (const snapshot of ordered) {
    let snapshotChanged = false;
    const updatedCodes = new Set();
    const entryTarget = locateFutureDate(calendar, snapshot.asOfDate, 1);

    for (const record of snapshot.records) {
      let backtest = record.backtestReturns;
      const backtestBefore = JSON.stringify(backtest ?? null);
      const entryLedger = entryTarget.date && entryTarget.entry?.marketPriceLedger === "created" ? ledgerByDate.get(entryTarget.date) : null;
      const normalizedCode = normalizeStockCode(record.code);
      const entryPriceRecord = normalizedCode ? entryLedger?.recordsByCode.get(normalizedCode) : null;

      if (backtest || entryTarget.status === "resolved") {
        backtest ??= createBacktestReturns();
        if (entryTarget.status !== "resolved") {
          backtest.resolution.entryStatus = entryTarget.status;
          backtest.resolution.reason = entryTarget.status;
          recordStatus(statistics, entryTarget.status);
        } else if (!entryLedger) {
          backtest.resolution.entryStatus = "missingTradingDaySnapshot";
          backtest.resolution.reason = "missingTradingDaySnapshot";
          recordStatus(statistics, "missingTradingDaySnapshot");
        } else if (!entryPriceRecord) {
          backtest.resolution.entryStatus = "symbolMissing";
          backtest.resolution.reason = "symbolMissing";
          recordStatus(statistics, "symbolMissing");
        } else {
          const entryStatus = entryPriceRecord.executable === false ? "notExecutable" : classifyPrice(entryPriceRecord.openPrice, "missingOpenPrice");
          if (entryStatus === "resolved") {
            if (backtest.entry.openPrice == null) {
              backtest.entry.date = entryTarget.date;
              backtest.entry.openPrice = entryPriceRecord.openPrice;
            } else if (backtest.entry.openPrice !== entryPriceRecord.openPrice || backtest.entry.date !== entryTarget.date) {
              throw new Error(`${snapshot.asOfDate} ${record.code}: 기존 진입가와 가격 원장이 일치하지 않습니다.`);
            }
          }
          backtest.resolution.entryStatus = entryStatus;
          if (entryStatus !== "resolved") backtest.resolution.reason = entryStatus;
          recordStatus(statistics, entryStatus);
        }
      }

      for (const horizon of FUTURE_RETURN_HORIZONS) {
        const target = locateFutureDate(calendar, snapshot.asOfDate, horizon.offset);
        const predictionStatistics = statistics.horizons[horizon.predictionReturnKey];
        const existingPrediction = record.futureReturns?.[horizon.predictionReturnKey];
        if (Number.isFinite(existingPrediction)) {
          predictionStatistics.alreadyResolved += 1;
          predictionStatistics.completed += 1;
        } else if (target.status === "pendingFutureTradingDay") {
          predictionStatistics.pending += 1;
          statistics.pending += 1;
        } else if (target.status !== "resolved") {
          predictionStatistics.failed += 1;
          statistics.failed += 1;
        } else {
          const futureSnapshot = target.entry?.modelSnapshot === "created" ? snapshotByDate.get(target.date) : null;
          const futureLedger = target.entry?.marketPriceLedger === "created" ? ledgerByDate.get(target.date) : null;
          const futureRecord = normalizedCode ? futureLedger?.recordsByCode.get(normalizedCode) : null;
          if (!futureSnapshot || !futureLedger || !futureRecord || !isValidPrice(record.closePrice) || !isValidPrice(futureRecord.closePrice)) {
            predictionStatistics.failed += 1;
            statistics.failed += 1;
          } else {
            record.futureReturns[horizon.predictionReturnKey] = roundReturn((futureRecord.closePrice / record.closePrice - 1) * 100);
            record.futureReturns.resolvedAt[horizon.predictionDateKey] = target.date;
            predictionStatistics.updated += 1;
            predictionStatistics.completed += 1;
            snapshotChanged = true;
            updatedCodes.add(record.code);
          }
        }

        const backtestStatistics = statistics.backtestHorizons[horizon.backtestReturnKey];
        const existingBacktestReturn = backtest?.returns[horizon.backtestReturnKey];
        if (Number.isFinite(existingBacktestReturn)) {
          backtestStatistics.alreadyResolved += 1;
          backtestStatistics.completed += 1;
          continue;
        }
        if (!backtest) {
          backtestStatistics.pending += 1;
          continue;
        }
        if (target.status !== "resolved") {
          backtest.resolution[horizon.exitStatusKey] = target.status;
          backtestStatistics[target.status === "pendingFutureTradingDay" ? "pending" : "failed"] += 1;
          recordStatus(statistics, target.status);
          continue;
        }
        const exitLedger = target.entry?.marketPriceLedger === "created" ? ledgerByDate.get(target.date) : null;
        if (!exitLedger) {
          backtest.resolution[horizon.exitStatusKey] = "missingTradingDaySnapshot";
          backtest.resolution.reason = "missingTradingDaySnapshot";
          backtestStatistics.failed += 1;
          recordStatus(statistics, "missingTradingDaySnapshot");
          continue;
        }
        const exitPriceRecord = normalizedCode ? exitLedger.recordsByCode.get(normalizedCode) : null;
        if (!exitPriceRecord) {
          backtest.resolution[horizon.exitStatusKey] = "symbolMissing";
          backtest.resolution.reason = "symbolMissing";
          backtestStatistics.failed += 1;
          recordStatus(statistics, "symbolMissing");
          continue;
        }
        const exitStatus = exitPriceRecord.executable === false ? "notExecutable" : classifyPrice(exitPriceRecord.closePrice, "missingExitClosePrice");
        backtest.resolution[horizon.exitStatusKey] = exitStatus;
        if (exitStatus !== "resolved") {
          backtest.resolution.reason = exitStatus;
          backtestStatistics.failed += 1;
          recordStatus(statistics, exitStatus);
          continue;
        }
        if (!backtest.exits[horizon.exitKey].date) {
          backtest.exits[horizon.exitKey] = { date: target.date, closePrice: exitPriceRecord.closePrice };
        }
        if (isValidPrice(backtest.entry.openPrice)) {
          backtest.returns[horizon.backtestReturnKey] = roundReturn((exitPriceRecord.closePrice / backtest.entry.openPrice - 1) * 100);
          backtestStatistics.updated += 1;
          backtestStatistics.completed += 1;
          updatedCodes.add(record.code);
        } else {
          backtestStatistics.failed += 1;
        }
      }

      if (backtest) {
        const allResolved = FUTURE_RETURN_HORIZONS.every((horizon) => Number.isFinite(backtest.returns[horizon.backtestReturnKey]));
        backtest.status = allResolved ? "resolved" : backtest.resolution.entryStatus === "resolved" ? "partiallyResolved" : "pendingEntryPrice";
        if (allResolved) backtest.resolution.reason = null;
        if (backtestBefore !== JSON.stringify(backtest)) {
          record.backtestReturns = backtest;
          snapshotChanged = true;
          updatedCodes.add(record.code);
        }
      }
    }

    if (snapshotChanged) {
      statistics.snapshotsUpdated += 1;
      statistics.updatedRecords += updatedCodes.size;
      changedDates.push(snapshot.asOfDate);
    }
  }

  return { snapshots: ordered, changedDates, statistics, calendar };
}

export function prepareSnapshots(rawSnapshots) {
  return rawSnapshots.map((snapshot) => {
    const copy = structuredClone(snapshot);
    return { ...copy, recordsByCode: new Map(copy.records.map((record) => [normalizeStockCode(record.code), record]).filter(([code]) => code)) };
  });
}

export function prepareMarketPriceLedgers(rawLedgers) {
  return rawLedgers.map((ledger) => {
    const copy = structuredClone(ledger);
    return { ...copy, recordsByCode: new Map(copy.records.map((record) => [normalizeStockCode(record.code), record]).filter(([code]) => code)) };
  });
}

export function serializableSnapshot(snapshot) {
  const serializable = { ...snapshot };
  delete serializable.recordsByCode;
  return serializable;
}
