import assert from "node:assert/strict";
import { createKisApiClient, classifyKisHttpStatus, safeKisError } from "../lib/kis-api-client-core.mjs";
import { createKisTokenManager } from "../lib/kis-token-manager-core.mjs";

const credentials = { appKey: "synthetic-app-key", appSecret: "synthetic-app-secret" };
const tokenResponse = (token, expiresIn = 3600) => new Response(JSON.stringify({ access_token: token, expires_in: expiresIn }), { status: 200, headers: { "Content-Type": "application/json" } });
const makeManager = ({ tokenFetch, now = () => 1_800_000_000_000 }) => createKisTokenManager({ fetchImpl: tokenFetch, getCredentials: () => credentials, now });

let issuanceCount = 0;
const reuseManager = makeManager({ tokenFetch: async () => { issuanceCount += 1; return tokenResponse(`token-${issuanceCount}`); } });
const first = await reuseManager.getToken();
const second = await reuseManager.getToken();
assert.equal(issuanceCount, 1, "최초 요청만 발급해야 합니다.");
assert.equal(second.generation, first.generation, "유효 token을 재사용해야 합니다.");

let currentTime = 1_800_000_000_000;
let refreshIssuanceCount = 0;
const refreshManager = makeManager({ now: () => currentTime, tokenFetch: async () => { refreshIssuanceCount += 1; return tokenResponse(`refresh-${refreshIssuanceCount}`); } });
const refreshFirst = await refreshManager.getToken();
currentTime = refreshFirst.expiresAtMs - 4 * 60 * 1000;
const refreshSecond = await refreshManager.getToken();
assert.equal(refreshIssuanceCount, 2, "만료 5분 이내에는 갱신해야 합니다.");
assert.notEqual(refreshSecond.generation, refreshFirst.generation);

let releaseIssuance;
let concurrentIssuanceCount = 0;
const concurrentManager = makeManager({ tokenFetch: () => { concurrentIssuanceCount += 1; return new Promise((resolve) => { releaseIssuance = () => resolve(tokenResponse("shared-token")); }); } });
const concurrentRequests = Array.from({ length: 20 }, () => concurrentManager.getToken());
await Promise.resolve();
releaseIssuance();
const concurrentTokens = await Promise.all(concurrentRequests);
assert.equal(concurrentIssuanceCount, 1, "동시 요청은 하나의 발급 Promise를 공유해야 합니다.");
assert.equal(new Set(concurrentTokens.map((record) => record.generation)).size, 1);

let failureAttempts = 0;
const failureManager = makeManager({ tokenFetch: async () => { failureAttempts += 1; return failureAttempts === 1 ? new Response("", { status: 500 }) : tokenResponse("recovered-token"); } });
await assert.rejects(() => failureManager.getToken(), (error) => error.code === "KIS_TOKEN_HTTP_500");
assert.equal(failureManager.getState().hasUsableToken, false);
await failureManager.getToken();
assert.equal(failureAttempts, 2, "실패 Promise를 정리해 다음 정상 요청이 재시도할 수 있어야 합니다.");

let expiryAttempts = 0;
const expiryManager = makeManager({ tokenFetch: async () => { expiryAttempts += 1; return expiryAttempts === 1 ? new Response(JSON.stringify({ access_token: "missing-expiry" }), { status: 200 }) : tokenResponse("valid-after-expiry-error"); } });
await assert.rejects(() => expiryManager.getToken(), (error) => error.code === "KIS_TOKEN_EXPIRY_MISSING");
assert.equal(expiryManager.getState().hasUsableToken, false);
await expiryManager.getToken();

async function runHttpScenario(statuses) {
  let tokenIssues = 0;
  let businessCalls = 0;
  const manager = makeManager({ tokenFetch: async () => { tokenIssues += 1; return tokenResponse(`scenario-token-${tokenIssues}`); } });
  const client = createKisApiClient({
    tokenManager: manager,
    getCredentials: () => credentials,
    fetchImpl: async () => new Response("", { status: statuses[Math.min(businessCalls++, statuses.length - 1)] }),
  });
  const response = await client.request("https://synthetic.invalid/business");
  return { response, tokenIssues, businessCalls };
}

const one401 = await runHttpScenario([401, 200]);
assert.deepEqual({ status: one401.response.status, tokenIssues: one401.tokenIssues, businessCalls: one401.businessCalls }, { status: 200, tokenIssues: 2, businessCalls: 2 });
const two401 = await runHttpScenario([401, 401]);
assert.deepEqual({ status: two401.response.status, tokenIssues: two401.tokenIssues, businessCalls: two401.businessCalls }, { status: 401, tokenIssues: 2, businessCalls: 2 });
for (const status of [403, 429, 500]) {
  const result = await runHttpScenario([status]);
  assert.equal(result.tokenIssues, 1, `HTTP ${status}에서 token을 갱신하면 안 됩니다.`);
  assert.equal(result.businessCalls, 1);
}

let concurrent401Issues = 0;
const concurrent401Manager = makeManager({ tokenFetch: async () => { concurrent401Issues += 1; await Promise.resolve(); return tokenResponse(`concurrent-401-${concurrent401Issues}`); } });
await concurrent401Manager.getToken();
let concurrent401BusinessCalls = 0;
const concurrent401Client = createKisApiClient({ tokenManager: concurrent401Manager, getCredentials: () => credentials, fetchImpl: async (_input, init) => {
  concurrent401BusinessCalls += 1;
  return new Response("", { status: String(new Headers(init.headers).get("authorization")).includes("concurrent-401-1") ? 401 : 200 });
} });
const concurrent401Responses = await Promise.all(Array.from({ length: 10 }, () => concurrent401Client.request("https://synthetic.invalid/business")));
assert.ok(concurrent401Responses.every((response) => response.status === 200));
assert.equal(concurrent401Issues, 2, "동시 401도 신규 token 한 번만 발급해야 합니다.");
assert.equal(concurrent401BusinessCalls, 20);

let lateIssues = 0;
const lateManager = makeManager({ tokenFetch: async () => { lateIssues += 1; return tokenResponse(`late-token-${lateIssues}`); } });
let releaseLate401;
const lateClient = createKisApiClient({ tokenManager: lateManager, getCredentials: () => credentials, fetchImpl: async (_input, init) => {
  const authorization = String(new Headers(init.headers).get("authorization"));
  if (authorization.includes("late-token-2")) return new Response("", { status: 200 });
  if (!releaseLate401) return new Promise((resolve) => { releaseLate401 = () => resolve(new Response("", { status: 401 })); });
  return new Response("", { status: 401 });
} });
const lateRequest = lateClient.request("https://synthetic.invalid/late");
await Promise.resolve();
const refreshRequest = lateClient.request("https://synthetic.invalid/refresh");
assert.equal((await refreshRequest).status, 200);
releaseLate401();
assert.equal((await lateRequest).status, 200);
assert.equal(lateIssues, 2, "늦은 이전 token의 401이 새 token을 삭제하면 안 됩니다.");

assert.equal(classifyKisHttpStatus(403).code, "KIS_FORBIDDEN");
assert.equal(classifyKisHttpStatus(429).code, "KIS_RATE_LIMITED");
const serializedSafeError = JSON.stringify(safeKisError({ code: "KIS_TOKEN_NETWORK_ERROR", token: "secret-token", appKey: credentials.appKey, appSecret: credentials.appSecret }));
assert.ok(!serializedSafeError.includes("secret-token"));
assert.ok(!serializedSafeError.includes(credentials.appKey));
assert.ok(!serializedSafeError.includes(credentials.appSecret));

console.log(JSON.stringify({ tokenCache: "passed", refreshWindow: "passed", singleFlight: "passed", bounded401Retry: "passed", non401NoRefresh: "passed", late401Protection: "passed", secretRedaction: "passed" }, null, 2));
