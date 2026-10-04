import { sha256Canonical } from "./snapshot-quality-pipeline.mjs";

export const HISTORICAL_OUTCOME_CALENDAR_EVIDENCE_SCHEMA_VERSION = 1;

export function createHistoricalOutcomeCalendarEvidence({ snapshots, marketPriceLedgers, tradingCalendar }) {
  const ledgerByDate = new Map(marketPriceLedgers.map((ledger) => [ledger.date, ledger]));
  const explicitDates = tradingCalendar?.dates ?? {};
  const entries = {};
  for (const snapshot of [...snapshots].sort((left, right) => left.asOfDate.localeCompare(right.asOfDate))) {
    const date = snapshot.asOfDate;
    const ledger = ledgerByDate.get(date);
    if (explicitDates[date] || !ledger || ledger.date !== date || !Array.isArray(snapshot.records) || !Array.isArray(ledger.records)) continue;
    const snapshotCodes = new Set(snapshot.records.map((record) => record.code));
    const ledgerCodes = new Set(ledger.records.map((record) => record.code));
    if (snapshotCodes.size === 0 || snapshotCodes.size !== ledgerCodes.size || [...snapshotCodes].some((code) => !ledgerCodes.has(code))) continue;
    entries[date] = {
      status: "tradingDay",
      observedBasDt: date,
      modelSnapshot: "created",
      marketPriceLedger: "created",
      evidence: "matchingHistoricalSnapshotAndPriceLedger",
    };
  }
  const base = {
    schemaVersion: HISTORICAL_OUTCOME_CALENDAR_EVIDENCE_SCHEMA_VERSION,
    dataset: "historical-outcome-calendar-evidence",
    policy: "onlyFillAbsentCalendarDatesWhenMatchingSnapshotAndPriceLedgerExist;neverOverrideExplicitCalendar",
    entries,
  };
  return { ...base, contentHash: sha256Canonical(base) };
}

export function mergeCalendarEvidence(tradingCalendar, evidence) {
  return {
    ...tradingCalendar,
    dates: { ...(tradingCalendar?.dates ?? {}), ...Object.fromEntries(Object.entries(evidence?.entries ?? {}).filter(([date]) => !tradingCalendar?.dates?.[date])) },
  };
}
