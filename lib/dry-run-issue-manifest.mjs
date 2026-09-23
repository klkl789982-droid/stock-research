import { createHash } from "node:crypto";

export const DRY_RUN_ISSUE_MANIFEST_SCHEMA_VERSION = 2;

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

function contentHash(value) {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function rowContext(rows, rowIndex) {
  if (!Number.isInteger(rowIndex) || rowIndex < 0 || rowIndex >= rows.length) {
    return {
      ohlcv: { mkp: null, hipr: null, lopr: null, clpr: null, trqu: null },
      previousRow: { date: null, clpr: null },
      nextRow: { date: null, clpr: null },
    };
  }
  const row = rows[rowIndex] ?? {};
  const adjacent = (candidate) => ({
    date: /^\d{8}$/u.test(String(candidate?.basDt ?? "")) ? String(candidate.basDt) : null,
    clpr: numberOrNull(candidate?.clpr),
  });
  return {
    ohlcv: {
      mkp: numberOrNull(row.mkp),
      hipr: numberOrNull(row.hipr),
      lopr: numberOrNull(row.lopr),
      clpr: numberOrNull(row.clpr),
      trqu: numberOrNull(row.trqu),
    },
    previousRow: adjacent(rows[rowIndex - 1]),
    nextRow: adjacent(rows[rowIndex + 1]),
  };
}

function compareIssues(left, right) {
  return (left.code ?? "\uffff").localeCompare(right.code ?? "\uffff")
    || (left.date ?? "\uffff").localeCompare(right.date ?? "\uffff")
    || (left.rowIndex ?? Number.MAX_SAFE_INTEGER) - (right.rowIndex ?? Number.MAX_SAFE_INTEGER)
    || left.severity.localeCompare(right.severity)
    || left.validatorRule.localeCompare(right.validatorRule);
}

function compareRequestResults(left, right) {
  return left.code.localeCompare(right.code) || left.operation.localeCompare(right.operation);
}

function countsBy(items, key) {
  return Object.fromEntries(
    [...new Set(items.map((item) => item[key]))].sort().map((value) => [value, items.filter((item) => item[key] === value).length]),
  );
}

function requestResult(input) {
  return {
    code: typeof input?.code === "string" ? input.code : null,
    operation: typeof input?.operation === "string" ? input.operation : "unknown",
    attemptCount: Number.isSafeInteger(input?.attemptCount) ? input.attemptCount : 0,
    maxAttempts: Number.isSafeInteger(input?.maxAttempts) ? input.maxAttempts : 0,
    outcome: typeof input?.outcome === "string" ? input.outcome : "unknown",
    httpStatus: Number.isInteger(input?.httpStatus) ? input.httpStatus : null,
    errorCategory: typeof input?.errorCategory === "string" ? input.errorCategory : "unknown",
    retryable: Boolean(input?.retryable),
    requestStartedAt: typeof input?.requestStartedAt === "string" ? input.requestStartedAt : null,
    requestFinishedAt: typeof input?.requestFinishedAt === "string" ? input.requestFinishedAt : null,
    elapsedMs: Number.isFinite(input?.elapsedMs) ? input.elapsedMs : null,
    latestBasDt: /^\d{8}$/u.test(String(input?.latestBasDt ?? "")) ? String(input.latestBasDt) : null,
  };
}

/**
 * Build a whitelist-only forensic record for a dry-run quality result.
 * It intentionally excludes API request/response and authentication material.
 */
export function createDryRunIssueManifest({ requestedDate, quality, historyByCode, requestResults = [], requestContract = null, requestPolicy = null }) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(String(requestedDate ?? ""))) {
    throw new Error("requestedDate must be YYYY-MM-DD");
  }
  const histories = historyByCode instanceof Map ? historyByCode : new Map(Object.entries(historyByCode ?? {}));
  const issues = (quality?.issues ?? [])
    .filter((entry) => entry?.severity === "fatal" || entry?.severity === "warning")
    .map((entry) => {
      const code = typeof entry.code === "string" ? entry.code : null;
      const date = /^\d{8}$/u.test(String(entry.date ?? "")) ? String(entry.date) : null;
      const rowIndex = Number.isInteger(entry.rowIndex) ? entry.rowIndex : null;
      return {
        severity: entry.severity,
        validatorRule: String(entry.type ?? "unknown"),
        ...(entry.disposition === "quarantine" ? { disposition: "quarantine" } : {}),
        code,
        date,
        rowIndex,
        ...rowContext(code ? histories.get(code) ?? [] : [], rowIndex),
      };
    })
    .sort(compareIssues);
  const issueTypeCounts = Object.fromEntries(
    [...new Set(issues.map((entry) => entry.validatorRule))]
      .sort()
      .map((rule) => [rule, issues.filter((entry) => entry.validatorRule === rule).length]),
  );
  const requests = requestResults.map(requestResult).sort(compareRequestResults);
  const failedRequests = requests.filter((entry) => entry.outcome !== "success");
  const base = {
    schemaVersion: DRY_RUN_ISSUE_MANIFEST_SCHEMA_VERSION,
    manifestType: "dryRunQualityIssues",
    requestedDate,
    rowOrder: "source-array-order-descending",
    issueTypeCounts,
    fatalCount: issues.filter((entry) => entry.severity === "fatal").length,
    warningCount: issues.filter((entry) => entry.severity === "warning").length,
    issues,
    requestExecution: {
      requestContract,
      requestContractHash: contentHash(requestContract),
      requestPolicy,
      outcomeCounts: countsBy(requests, "outcome"),
      errorCategoryCounts: countsBy(requests, "errorCategory"),
      attemptCountDistribution: countsBy(requests, "attemptCount"),
      failedCodeListHash: contentHash(failedRequests.map((entry) => entry.code)),
      requests,
    },
  };
  return { ...base, contentHash: contentHash(base) };
}

export function validateDryRunIssueManifest(manifest) {
  const errors = [];
  if (manifest?.schemaVersion !== DRY_RUN_ISSUE_MANIFEST_SCHEMA_VERSION) errors.push("schemaVersion");
  if (manifest?.manifestType !== "dryRunQualityIssues") errors.push("manifestType");
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(String(manifest?.requestedDate ?? ""))) errors.push("requestedDate");
  if (!Array.isArray(manifest?.issues) || manifest.issues.some((entry, index) => index > 0 && compareIssues(manifest.issues[index - 1], entry) > 0)) errors.push("issueOrder");
  const requests = manifest?.requestExecution?.requests;
  if (!Array.isArray(requests) || requests.some((entry, index) => !entry.code || index > 0 && compareRequestResults(requests[index - 1], entry) > 0)) errors.push("requestOrder");
  const { contentHash: actualHash, ...base } = manifest ?? {};
  if (actualHash !== contentHash(base)) errors.push("contentHash");
  return errors;
}
