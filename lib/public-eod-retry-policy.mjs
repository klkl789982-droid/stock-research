export const DEFAULT_PUBLIC_EOD_MAX_ATTEMPTS = 3;
export const LATEST_PUBLIC_EOD_MAX_ATTEMPTS = 2;

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
  return error?.name === "AbortError"
    || (!latestMode && error?.httpStatus === 429)
    || error?.httpStatus >= 500
    || (error?.httpStatus == null && !error?.businessCode);
}

export function shouldRetryPublicEodRequest({ error, attempt, maxAttempts, latestMode }) {
  return attempt < maxAttempts && isRetryablePublicEodError(error, { latestMode });
}
