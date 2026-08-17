import { normalizeStockCode } from "./stock-code.mjs";

export const PUBLIC_EOD_T2_POLICY_ID = "public-eod-t2-open-v1";
export const EXECUTION_HORIZONS = {
  H1: { holdingTradingDay: 1, returnKey: "holding1dReturn", exitKey: "h1", statusKey: "h1Status" },
  H5: { holdingTradingDay: 5, returnKey: "holding5dReturn", exitKey: "h5", statusKey: "h5Status" },
  H20: { holdingTradingDay: 20, returnKey: "holding20dReturn", exitKey: "h20", statusKey: "h20Status" },
};
const finitePrice = (value) => Number.isFinite(value) && value > 0;
const roundReturn = (value) => Number(value.toFixed(6));
const nextDate = (date) => { const value = new Date(`${date}T00:00:00Z`); value.setUTCDate(value.getUTCDate() + 1); return value.toISOString().slice(0, 10); };
const weekend = (date) => [0, 6].includes(new Date(`${date}T00:00:00Z`).getUTCDay());

export function createExecutionReturns(signalDate, signalAvailableAt) {
  return {
    status: "pendingEntry",
    timingValidationStatus: "UNKNOWN",
    timingEvidenceLevel: "UNKNOWN",
    signalDate,
    signalAvailableAt,
    entry: { tradingDayOffset: 2, date: null, timestamp: null, openPrice: null, priceBasis: "officialDailyOpen" },
    returns: { holding1dReturn: null, holding5dReturn: null, holding20dReturn: null },
    exits: {
      h1: { holdingTradingDay: 1, date: null, closePrice: null },
      h5: { holdingTradingDay: 5, date: null, closePrice: null },
      h20: { holdingTradingDay: 20, date: null, closePrice: null },
    },
    resolution: { entryStatus: "pending", h1Status: "pending", h5Status: "pending", h20Status: "pending", reason: null },
    grossReturn: true, transactionCostsIncluded: false, slippageIncluded: false,
  };
}

export const createLegacyClassification = () => ({ policyId: "legacy-t1-open-v1", timingValidationStatus: "UNKNOWN", eligibleForExecutableAggregation: false, reason: "sourceAvailabilityNotRecorded" });

function locate(calendar, startDate, offset) {
  const dates = calendar?.dates ?? {}, maximum = Object.keys(dates).sort().at(-1) ?? null;
  if (!maximum || startDate >= maximum) return { status: "pendingFutureTradingDay", date: null };
  let cursor = nextDate(startDate), count = 0;
  while (cursor <= maximum) {
    const entry = dates[cursor];
    if (!entry) { if (weekend(cursor)) { cursor = nextDate(cursor); continue; } return { status: "missingTradingCalendarStatus", date: cursor }; }
    if (entry.status === "marketClosed") { cursor = nextDate(cursor); continue; }
    if (entry.status === "unchecked" || entry.status === "collectionFailed") return { status: entry.status, date: cursor };
    if (entry.status !== "tradingDay") return { status: "missingTradingCalendarStatus", date: cursor };
    count += 1; if (count === offset) return { status: "resolved", date: cursor, calendarEntry: entry };
    cursor = nextDate(cursor);
  }
  return { status: "pendingFutureTradingDay", date: null };
}

const ledgerRecord = (ledgers, date, code) => ledgers.get(date)?.recordsByCode?.get(normalizeStockCode(code));
const block = (result, status, statusKey = "entryStatus") => { result.resolution[statusKey] = status; result.resolution.reason = status; return result; };

export function resolveExecutionReturnsByPolicy(record, signalSnapshot, priceLedgers, tradingCalendar, policyId = PUBLIC_EOD_T2_POLICY_ID) {
  if (policyId !== PUBLIC_EOD_T2_POLICY_ID) throw new Error(`지원하지 않는 실행정책: ${policyId}`);
  const existing = record.executionReturnsByPolicy?.[policyId];
  if (existing && Object.values(existing.returns ?? {}).every(Number.isFinite)) return structuredClone(existing);
  const availableAt = signalSnapshot.signalAvailableAt ?? signalSnapshot.sourceAvailability?.signalAvailableAt ?? null;
  const result = existing ? structuredClone(existing) : createExecutionReturns(signalSnapshot.asOfDate, availableAt);
  if (!availableAt || !Number.isFinite(Date.parse(availableAt))) { result.status = "sourceAvailabilityUnknown"; result.timingValidationStatus = "UNKNOWN"; return block(result, "sourceAvailabilityUnknown"); }
  const entryTarget = locate(tradingCalendar, signalSnapshot.asOfDate, 2);
  if (entryTarget.status !== "resolved") { result.status = entryTarget.status; return block(result, entryTarget.status); }
  const entry = ledgerRecord(priceLedgers, entryTarget.date, record.code);
  if (!priceLedgers.get(entryTarget.date)) return block(result, "missingTradingDaySnapshot");
  if (!entry) return block(result, "missingEntryOpenPrice");
  if (entry.executable === false) return block(result, "tradingHaltOrNotExecutable");
  if (!finitePrice(entry.openPrice)) return block(result, entry.openPrice == null ? "missingEntryOpenPrice" : "invalidPrice");
  const entryTimestamp = `${entryTarget.date}T09:00:00+09:00`;
  result.entry = { ...result.entry, date: entryTarget.date, timestamp: entryTimestamp, openPrice: entry.openPrice };
  if (Date.parse(availableAt) >= Date.parse(entryTimestamp)) { result.status = "timingInvalid"; result.timingValidationStatus = "INVALID"; return block(result, "timingInvalid"); }
  result.timingValidationStatus = "VALID";
  const publicationEvidence = signalSnapshot.timingEvidence?.publication ?? signalSnapshot.sourceAvailability?.timingEvidence?.publication;
  result.timingEvidenceLevel = signalSnapshot.sourceAvailabilityStatus === "VERIFIED" || publicationEvidence === "VERIFIED"
    ? "VERIFIED" : publicationEvidence === "POLICY_ESTIMATED" ? "POLICY_ESTIMATED" : "UNKNOWN";
  result.resolution.entryStatus = "timingValid";
  for (const horizon of Object.values(EXECUTION_HORIZONS)) {
    if (Number.isFinite(result.returns[horizon.returnKey])) continue;
    const exitTarget = locate(tradingCalendar, entryTarget.date, horizon.holdingTradingDay - 1);
    const target = horizon.holdingTradingDay === 1 ? { status: "resolved", date: entryTarget.date } : exitTarget;
    if (target.status !== "resolved") { result.resolution[horizon.statusKey] = target.status; continue; }
    const ledger = priceLedgers.get(target.date), exit = ledgerRecord(priceLedgers, target.date, record.code);
    if (!ledger) { result.resolution[horizon.statusKey] = "missingTradingDaySnapshot"; continue; }
    if (!exit) { result.resolution[horizon.statusKey] = "missingExitClosePrice"; continue; }
    if (exit.executable === false) { result.resolution[horizon.statusKey] = "tradingHaltOrNotExecutable"; continue; }
    if (!finitePrice(exit.closePrice)) { result.resolution[horizon.statusKey] = exit.closePrice == null ? "missingExitClosePrice" : "invalidPrice"; continue; }
    result.exits[horizon.exitKey] = { holdingTradingDay: horizon.holdingTradingDay, date: target.date, closePrice: exit.closePrice };
    result.returns[horizon.returnKey] = roundReturn((exit.closePrice / entry.openPrice - 1) * 100);
    result.resolution[horizon.statusKey] = "resolved";
  }
  result.status = Object.values(result.returns).every(Number.isFinite) ? "resolved" : "pendingExitPrice";
  if (result.status === "resolved") result.resolution.reason = null;
  return result;
}

export function resolveExecutionReturns(snapshots, ledgers, calendar, policyId = PUBLIC_EOD_T2_POLICY_ID) {
  const ledgerMap = new Map(ledgers.map((ledger) => [ledger.date, ledger]));
  const changedDates = [];
  for (const snapshot of snapshots) {
    if (snapshot.schemaVersion !== 6) continue;
    let changed = false;
    for (const record of snapshot.records) {
      const before = JSON.stringify(record.executionReturnsByPolicy?.[policyId] ?? null);
      const resolved = resolveExecutionReturnsByPolicy(record, snapshot, ledgerMap, calendar, policyId);
      if (before !== JSON.stringify(resolved)) { record.executionReturnsByPolicy ??= {}; record.executionReturnsByPolicy[policyId] = resolved; changed = true; }
    }
    if (changed) changedDates.push(snapshot.asOfDate);
  }
  return { snapshots, changedDates };
}
