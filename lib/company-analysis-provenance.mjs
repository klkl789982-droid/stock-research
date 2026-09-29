const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
export const cagrInputStatus = (value) => value == null ? "missing" : value <= 0 ? "nonPositive" : "available";

export function createCagrProvenance(row, parseAmount) {
  const latest = parseAmount(row?.thstrm_amount); const comparison = parseAmount(row?.bfefrmtrm_amount);
  const currentInputStatus = cagrInputStatus(latest); const comparisonInputStatus = cagrInputStatus(comparison);
  return {
    calculationStatus: currentInputStatus === "available" && comparisonInputStatus === "available" ? "available" : currentInputStatus === "nonPositive" || comparisonInputStatus === "nonPositive" ? "nonPositive" : "missing",
    accountFound: Boolean(row), accountIdentifier: row?.account_id ?? null, accountName: row?.account_nm ?? null,
    currentInputStatus, comparisonInputStatus,
    currentPeriodLabel: row?.thstrm_nm ?? null, comparisonPeriodLabel: row?.bfefrmtrm_nm ?? null,
  };
}

// Kept separate from scoring: these diagnostics explain unavailable inputs only.
export function classifyLedgerReadFailure(error) {
  if (error?.code === "ENOENT") return "missingFile";
  if (error instanceof SyntaxError || error?.name === "SyntaxError") return "invalidJson";
  return "readFailure";
}

export function validateLedgerContainer(ledger) {
  if (!isObject(ledger) || ledger.schemaVersion !== 1 || !Array.isArray(ledger.statements)) return ["schemaInvalid"];
  return [];
}

export function diagnosePointInTimeStatements(statements, requestedDate, validateStatement) {
  const rows = Array.isArray(statements) ? statements : [];
  const valid = rows.filter((statement) => validateStatement(statement).length === 0);
  const pointInTime = valid.filter((statement) => statement.filingDate <= requestedDate);
  const detail = pointInTime.length > 0
    ? "available"
    : rows.length === 0
      ? "noStatements"
      : valid.length === 0
        ? "allStatementsSchemaInvalid"
        : "allValidStatementsAfterAnalysisDate";
  return {
    status: pointInTime.length > 0 ? "available" : "missing",
    detail,
    statementCount: rows.length,
    validStatementCount: valid.length,
    pointInTimeStatementCount: pointInTime.length,
    candidates: [...pointInTime].sort((a, b) => b.filingDate.localeCompare(a.filingDate) || String(b.receiptNumber).localeCompare(String(a.receiptNumber))),
  };
}
