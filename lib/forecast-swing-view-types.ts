/** Read-only preparation contract. Null predictions must never become numeric defaults. */
export type ForecastSwingLedgerRecord = {
  id: string;
  status: "PREPARING";
  /** Legacy wire name: preparation-record creation time, not prediction issuance. */
  issuedAt: string | null;
  ticker: string | null;
  modelVersion: string;
  expectedReturnPercent: null;
  lossProbability: null;
  rangePercent: null;
  signalDate?: string | null;
  observedModels?: Array<{ modelVersion: string; score: number | null; rank?: number | null }>;
  outcome?: { status: "OBSERVED" | "PENDING" | "BLOCKED" | "NOT_EVALUATED"; reasons: string[]; resolvedAt: string | null; entryDate: string | null; exitDate: string | null; benchmarkReturnPercent: number | null; netReturnPercent: null };
};

export type ForecastSwingPreparingResponse = {
  schemaVersion: 1;
  observationPolicyId: "intraday-1400-v1";
  officialSignalTime: "14:00:00";
  status: "PREPARING";
  generatedAt: string;
  model: {
    version: string;
    trainingStatus: "NOT_TRAINED";
    externalValidationStatus: "NOT_VALIDATED";
  };
  horizon: {
    tradingDays: 5;
    entryPolicy: "NEXT_SESSION_OPEN_AFTER_ISSUANCE";
    exitPolicy: "FIFTH_SESSION_CLOSE";
  };
  prediction: {
    expectedReturnPercent: null;
    lossProbability: null;
    rangePercent: null;
  };
  observation: {
    status: "AVAILABLE" | "UNAVAILABLE";
    signalDate: string | null;
    collectionStartedAt: string | null;
    collectionCompletedAt: string | null;
    availableAt: string | null;
    referencePrice: number | null;
    ticker: string | null;
    companyName: string | null;
    observedAt: string | null;
    rowCount: number;
    independentDateCount: number;
  };
  readiness: {
    status: "BLOCKED";
    eligibleForTraining: false;
    blockers: Array<{ code: string; message: string }>;
  };
  ledger: { recordCount: number; records: ForecastSwingLedgerRecord[] };
  evaluation: {
    mature5DayCount: number;
    independentDateCount: number;
    costStatus: "UNKNOWN";
    costAdjustedReturnPercent: null;
  };
  daytrade: { status: "PREPARING"; reason: string };
};
