import assert from "node:assert/strict";
import fs from "node:fs";
import { settleSearchRequest } from "../lib/search-request-isolation.mjs";

const response = (status, data, jsonError = null) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => { if (jsonError) throw jsonError; return data; },
});
const success = (key) => settleSearchRequest(Promise.resolve(response(200, { key })), `${key} 실패`);
const networkFailure = (key) => settleSearchRequest(Promise.reject(new TypeError("fetch failed")), `${key} 실패`);
const httpFailure = (key, status = 503) => settleSearchRequest(Promise.resolve(response(status, { error: { message: `${key} unavailable` } })), `${key} 실패`);

const runScenario = async (overrides = {}) => {
  const requests = {
    price: success("price"), realtime: success("realtime"), company: success("company"), market: success("market"), intraday: success("intraday"),
    ...overrides,
  };
  const entries = await Promise.all(Object.entries(requests).map(async ([key, request]) => [key, await request]));
  return Object.fromEntries(entries);
};

const allSuccess = await runScenario();
assert.deepEqual(Object.values(allSuccess).map((item) => item.status), Array(5).fill("success"));

const priceFailed = await runScenario({ price: networkFailure("price") });
assert.equal(priceFailed.price.status, "unavailable");
assert.equal(priceFailed.realtime.status, "success");
assert.equal(priceFailed.company.status, "success");

const realtimeFailed = await runScenario({ realtime: httpFailure("realtime") });
assert.equal(realtimeFailed.realtime.status, "error");
assert.equal(realtimeFailed.price.status, "success");

const companyFailed = await runScenario({ company: Promise.resolve(response(404, { error: { message: "missing company" } })).then((item) => settleSearchRequest(Promise.resolve(item), "company 실패")) });
assert.equal(companyFailed.company.status, "missing");
assert.equal(companyFailed.market.status, "success");

const marketFailed = await runScenario({ market: networkFailure("market") });
assert.equal(marketFailed.market.status, "unavailable");
assert.equal(marketFailed.company.status, "success");

const multipleFailed = await runScenario({ price: networkFailure("price"), company: httpFailure("company"), intraday: networkFailure("intraday") });
assert.equal(multipleFailed.realtime.status, "success");
assert.equal(multipleFailed.market.status, "success");

const invalidJson = await settleSearchRequest(Promise.resolve(response(200, null, new SyntaxError("invalid"))), "가격 조회 실패");
assert.equal(invalidJson.status, "error");

const page = fs.readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
assert.match(page, /Promise\.allSettled\(tasks\)/u);
assert.match(page, /setStockInfo\(null\)/u);
assert.match(page, /setSearchedStock\(null\)/u);
assert.match(page, /requestId === searchRequestIdRef\.current && selectedCodeRef\.current === stockCode/u);
assert.match(page, /alert\("종목을 찾을 수 없습니다\."\)/u);
assert.doesNotMatch(page, /console\.log\("가격 API 원본:/u);
assert.doesNotMatch(page, /console\.log\("실시간 데이터:/u);

console.log("검색 API 부분 성공·다중 실패·missing·stale guard 회귀 테스트 통과");
