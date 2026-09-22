const SAFE_ERROR_CODE = /^[A-Z][A-Z0-9_]*$/u;

const ERROR_CATEGORIES = new Map([
  ["ETIMEDOUT", "timeout"],
  ["ENOTFOUND", "dns"],
  ["EAI_AGAIN", "dns"],
  ["ECONNRESET", "connectionReset"],
  ["ECONNREFUSED", "connectionRefused"],
  ["ERR_PROXY_CONNECTION_FAILED", "proxy"],
  ["ERR_TLS_CERT_ALTNAME_INVALID", "tls"],
  ["CERT_HAS_EXPIRED", "tls"],
  ["DEPTH_ZERO_SELF_SIGNED_CERT", "tls"],
  ["UNABLE_TO_VERIFY_LEAF_SIGNATURE", "tls"],
]);

function safeErrorCode(error) {
  const code = error?.code ?? error?.cause?.code;
  return typeof code === "string" && SAFE_ERROR_CODE.test(code) ? code : null;
}

export function createPublicEodRequestContract(shape) {
  return {
    operation: shape.operation,
    purpose: shape.purpose,
    codeParameter: shape.codeParameter,
    beginBasDt: shape.beginBasDt,
    endBasDt: shape.endBasDt,
    pageNo: shape.pageNo,
    numOfRows: shape.numOfRows,
    resultType: shape.resultType,
    normalizationVersion: shape.normalizationVersion,
  };
}

export function classifyPublicEodRequestError(error) {
  if (error?.observabilityOutcome === "invalidResponse") {
    return { outcome: "invalidResponse", httpStatus: null, errorCategory: "invalidResponse" };
  }
  if (error?.businessCode) {
    return { outcome: "businessError", httpStatus: null, errorCategory: "businessError" };
  }
  if (Number.isInteger(error?.httpStatus)) {
    return { outcome: "httpError", httpStatus: error.httpStatus, errorCategory: "http" };
  }
  const code = safeErrorCode(error);
  const category = code ? ERROR_CATEGORIES.get(code) : null;
  if (error?.name === "AbortError" || category === "timeout") {
    return { outcome: "timeout", httpStatus: null, errorCategory: "timeout" };
  }
  if (category) return { outcome: "networkError", httpStatus: null, errorCategory: category };
  if (error?.name === "TypeError") {
    return { outcome: "networkError", httpStatus: null, errorCategory: "fetchFailed" };
  }
  return { outcome: "networkError", httpStatus: null, errorCategory: "unknown" };
}

export function createPublicEodRequestResult({
  shape,
  attemptCount,
  maxAttempts,
  startedAt,
  finishedAt,
  retryable,
  outcome,
  latestBasDt = null,
}) {
  const started = new Date(startedAt);
  const finished = new Date(finishedAt);
  return {
    code: shape.code,
    operation: shape.operation,
    attemptCount,
    maxAttempts,
    outcome: outcome.outcome,
    httpStatus: outcome.httpStatus,
    errorCategory: outcome.errorCategory,
    retryable: Boolean(retryable),
    requestStartedAt: started.toISOString(),
    requestFinishedAt: finished.toISOString(),
    elapsedMs: Math.max(0, finished.getTime() - started.getTime()),
    latestBasDt: /^\d{8}$/u.test(String(latestBasDt ?? "")) ? String(latestBasDt) : null,
  };
}
