import assert from "node:assert/strict";
import {
  DEFAULT_PUBLIC_EOD_MAX_ATTEMPTS,
  LATEST_PUBLIC_EOD_MAX_ATTEMPTS,
  LATEST_PUBLIC_EOD_RETRY_BACKOFF_MS,
  isRetryablePublicEodError,
  parseMaxAttemptsOption,
  resolveMaxAttempts,
  shouldRetryPublicEodRequest,
  runPublicEodRequestWithRetry,
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
assert.equal(isRetryablePublicEodError({ httpStatus: 500 }, { latestMode: true }), false);
assert.equal(isRetryablePublicEodError({ observabilityOutcome: "invalidResponse" }, { latestMode: true }), false);
assert.equal(isRetryablePublicEodError({ businessCode: "01" }, { latestMode: true }), false);

const retryEvents = [];
let timeoutThenSuccessCalls = 0;
const timeoutThenSuccess = await runPublicEodRequestWithRetry({
  maxAttempts: LATEST_PUBLIC_EOD_MAX_ATTEMPTS,
  latestMode: true,
  execute: async () => { timeoutThenSuccessCalls += 1; if (timeoutThenSuccessCalls === 1) throw Object.assign(new Error("temporary timeout"), { name: "TimeoutError" }); return "ok"; },
  onRetry: (event) => retryEvents.push(event), sleep: async () => {},
});
assert.equal(timeoutThenSuccess.value, "ok"); assert.equal(timeoutThenSuccess.attemptCount, 2); assert.equal(retryEvents[0].delayMs, LATEST_PUBLIC_EOD_RETRY_BACKOFF_MS);

let networkThenSuccessCalls = 0;
const networkThenSuccess = await runPublicEodRequestWithRetry({
  maxAttempts: LATEST_PUBLIC_EOD_MAX_ATTEMPTS, latestMode: true,
  execute: async () => { networkThenSuccessCalls += 1; if (networkThenSuccessCalls === 1) throw new TypeError("fetch failed"); return "ok"; }, sleep: async () => {},
});
assert.equal(networkThenSuccess.attemptCount, 2);

let allTimeoutCalls = 0;
await assert.rejects(() => runPublicEodRequestWithRetry({ maxAttempts: LATEST_PUBLIC_EOD_MAX_ATTEMPTS, latestMode: true, execute: async () => { allTimeoutCalls += 1; throw Object.assign(new Error("timeout"), { name: "TimeoutError" }); }, sleep: async () => {} }));
assert.equal(allTimeoutCalls, LATEST_PUBLIC_EOD_MAX_ATTEMPTS);

for (const error of [{ httpStatus: 403 }, { observabilityOutcome: "invalidResponse" }, { businessCode: "99" }]) {
  let calls = 0;
  await assert.rejects(() => runPublicEodRequestWithRetry({ maxAttempts: LATEST_PUBLIC_EOD_MAX_ATTEMPTS, latestMode: true, execute: async () => { calls += 1; throw error; }, sleep: async () => {} }));
  assert.equal(calls, 1);
}
const secret = "service-key-must-not-log";
const safeLog = [];
await runPublicEodRequestWithRetry({ maxAttempts: 2, latestMode: true, execute: async (attempt) => { if (attempt === 1) { const error = new TypeError("fetch failed"); error.secret = secret; throw error; } return "ok"; }, onRetry: (event) => safeLog.push(JSON.stringify(event)), sleep: async () => {} });
assert.equal(JSON.stringify(safeLog).includes(secret), false);

console.log("public EOD retry policy: all synthetic checks passed");
