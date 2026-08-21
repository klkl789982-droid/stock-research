import assert from "node:assert/strict";
import {
  DEFAULT_PUBLIC_EOD_MAX_ATTEMPTS,
  LATEST_PUBLIC_EOD_MAX_ATTEMPTS,
  isRetryablePublicEodError,
  parseMaxAttemptsOption,
  resolveMaxAttempts,
  shouldRetryPublicEodRequest,
} from "../lib/public-eod-retry-policy.mjs";

assert.equal(parseMaxAttemptsOption(["node", "script"]), null);
assert.equal(parseMaxAttemptsOption(["node", "script", "--max-attempts=1"]), 1);
for (const value of ["0", "-1", "one", "1.5", ""]) {
  assert.throws(() => parseMaxAttemptsOption(["node", "script", `--max-attempts=${value}`]), /양의 정수/);
}
assert.throws(
  () => parseMaxAttemptsOption(["node", "script", "--max-attempts=1", "--max-attempts=2"]),
  /한 번만/,
);
assert.equal(resolveMaxAttempts({ latestMode: true, maxAttempts: null }), LATEST_PUBLIC_EOD_MAX_ATTEMPTS);
assert.equal(resolveMaxAttempts({ latestMode: false, maxAttempts: null }), DEFAULT_PUBLIC_EOD_MAX_ATTEMPTS);
assert.equal(resolveMaxAttempts({ latestMode: true, maxAttempts: 1 }), 1);

for (const error of [{ name: "TypeError" }, { name: "AbortError" }, { httpStatus: 500 }]) {
  assert.equal(
    shouldRetryPublicEodRequest({ error, attempt: 1, maxAttempts: 1, latestMode: true }),
    false,
  );
}
assert.equal(isRetryablePublicEodError({ httpStatus: 401 }, { latestMode: true }), false);
assert.equal(isRetryablePublicEodError({ httpStatus: 403 }, { latestMode: true }), false);
assert.equal(isRetryablePublicEodError({ httpStatus: 429 }, { latestMode: true }), false);
assert.equal(isRetryablePublicEodError({ httpStatus: 429 }, { latestMode: false }), true);

console.log("public EOD retry policy: all synthetic checks passed");
