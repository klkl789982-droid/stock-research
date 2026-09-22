import assert from "node:assert/strict";
import {
  classifyPublicEodRequestError,
  createPublicEodRequestContract,
  createPublicEodRequestResult,
} from "../lib/public-eod-request-observability.mjs";

const shape = {
  operation: "getStockPriceInfo", purpose: "latestHistoryCollection", codeParameter: "likeSrtnCd",
  code: "005930", beginBasDt: null, endBasDt: null, pageNo: 1, numOfRows: 260,
  resultType: "json", normalizationVersion: "official-eod-normalization-v3",
};

assert.deepEqual(classifyPublicEodRequestError({ name: "AbortError" }), { outcome: "timeout", httpStatus: null, errorCategory: "timeout" });
assert.deepEqual(classifyPublicEodRequestError({ cause: { code: "ECONNRESET" } }), { outcome: "networkError", httpStatus: null, errorCategory: "connectionReset" });
assert.deepEqual(classifyPublicEodRequestError({ cause: { code: "ENOTFOUND" } }), { outcome: "networkError", httpStatus: null, errorCategory: "dns" });
assert.deepEqual(classifyPublicEodRequestError({ cause: { code: "CERT_HAS_EXPIRED" } }), { outcome: "networkError", httpStatus: null, errorCategory: "tls" });
assert.deepEqual(classifyPublicEodRequestError({ cause: { code: "ERR_PROXY_CONNECTION_FAILED" } }), { outcome: "networkError", httpStatus: null, errorCategory: "proxy" });
for (const status of [401, 403, 429, 500]) {
  assert.deepEqual(classifyPublicEodRequestError({ httpStatus: status }), { outcome: "httpError", httpStatus: status, errorCategory: "http" });
}
assert.deepEqual(classifyPublicEodRequestError({ businessCode: "safe-code" }), { outcome: "businessError", httpStatus: null, errorCategory: "businessError" });
assert.deepEqual(classifyPublicEodRequestError({ observabilityOutcome: "invalidResponse" }), { outcome: "invalidResponse", httpStatus: null, errorCategory: "invalidResponse" });
assert.deepEqual(classifyPublicEodRequestError({ name: "TypeError" }), { outcome: "networkError", httpStatus: null, errorCategory: "fetchFailed" });

const secret = "must-not-be-serialized";
const result = createPublicEodRequestResult({
  shape: { ...shape, serviceKey: secret }, attemptCount: 1, maxAttempts: 1,
  startedAt: "2026-08-20T00:00:00.000Z", finishedAt: "2026-08-20T00:00:00.050Z",
  retryable: false, outcome: classifyPublicEodRequestError({ cause: { code: "ENOTFOUND" }, message: secret }),
});
assert.equal(JSON.stringify(result).includes(secret), false);
assert.equal(result.elapsedMs, 50);
assert.equal(result.latestBasDt, null);
assert.deepEqual(createPublicEodRequestContract(shape), {
  operation: "getStockPriceInfo", purpose: "latestHistoryCollection", codeParameter: "likeSrtnCd",
  beginBasDt: null, endBasDt: null, pageNo: 1, numOfRows: 260,
  resultType: "json", normalizationVersion: "official-eod-normalization-v3",
});

console.log("public EOD request observability: all synthetic checks passed");
