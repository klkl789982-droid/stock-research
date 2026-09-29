import { classifyPublicEodRequestError } from "./public-eod-request-observability.mjs";

export const DEFAULT_PUBLIC_EOD_MAX_ATTEMPTS = 3;
export const LATEST_PUBLIC_EOD_MAX_ATTEMPTS = 2;
export const LATEST_PUBLIC_EOD_RETRY_BACKOFF_MS = 1_000;
const RETRYABLE_NETWORK_CODES = new Set(["ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "ENOTFOUND", "EAI_AGAIN", "ECONNRESET", "ECONNREFUSED"]);

export function parseMaxAttemptsOption(argv = process.argv) {
  const options = argv.filter((value) => value.startsWith("--max-attempts="));
  if (options.length === 0) return null;
  if (options.length > 1) throw new Error("--max-attempts는 한 번만 지정할 수 있습니다.");
  const value = options[0].slice("--max-attempts=".length);
  if (!/^[1-9]\d*$/u.test(value)) {
    throw new Error("--max-attempts는 양의 정수여야 합니다.");
  }
  const attempts = Number(value);
  if (!Number.isSafeInteger(attempts)) {
    throw new Error("--max-attempts는 안전한 양의 정수여야 합니다.");
  }
  return attempts;
}

export function resolveMaxAttempts({ latestMode, maxAttempts }) {
  return maxAttempts ?? (latestMode ? LATEST_PUBLIC_EOD_MAX_ATTEMPTS : DEFAULT_PUBLIC_EOD_MAX_ATTEMPTS);
}

export function isRetryablePublicEodError(error, { latestMode }) {
  if (error?.observabilityOutcome === "invalidResponse" || error?.businessCode) return false;
  if (Number.isInteger(error?.httpStatus)) {
    return !latestMode && (error.httpStatus === 429 || error.httpStatus >= 500);
  }
  const networkCode = error?.code ?? error?.cause?.code;
  return error?.name === "AbortError"
    || error?.name === "TimeoutError"
    || RETRYABLE_NETWORK_CODES.has(networkCode)
    || error?.name === "TypeError" && error?.message === "fetch failed";
}

export function shouldRetryPublicEodRequest({ error, attempt, maxAttempts, latestMode }) {
  return attempt < maxAttempts && isRetryablePublicEodError(error, { latestMode });
}

export async function runPublicEodRequestWithRetry({ execute, maxAttempts, latestMode, onRetry = () => {}, sleep = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)), backoffMs = LATEST_PUBLIC_EOD_RETRY_BACKOFF_MS }) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return { value: await execute(attempt), attemptCount: attempt };
    } catch (error) {
      if (!shouldRetryPublicEodRequest({ error, attempt, maxAttempts, latestMode })) throw error;
      const delayMs = backoffMs * 2 ** (attempt - 1);
      const outcome = classifyPublicEodRequestError(error);
      onRetry({ attempt, nextAttempt: attempt + 1, maxAttempts, delayMs, outcome: outcome.outcome, errorCategory: outcome.errorCategory });
      await sleep(delayMs);
    }
  }
  throw new Error("PUBLIC_EOD_RETRY_EXHAUSTED");
}
