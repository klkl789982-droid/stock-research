import { createHash } from "node:crypto";
import { createPublicEodRequestShape, createPublicEodQuery, normalizePublicEodRows,
  publicEodRequestFingerprint } from "../../lib/public-eod-request.mjs";

// Exactly two small read-only provider calls, no automatic retries, no raw
// prices printed/persisted, no candidate generation or official promotion.
const date = process.argv.find(arg => arg.startsWith("--date="))?.slice(7);
if (!/^\d{4}-\d{2}-\d{2}$/u.test(date ?? "")) throw new Error("PROBE_DATE_REQUIRED");
const serviceKey = process.env.DATA_GO_KR_SERVICE_KEY;
if (!serviceKey) throw new Error("PROBE_CREDENTIAL_UNAVAILABLE");
const target = date.replaceAll("-", ""), results = [];
for (const exact of [false, true]) {
  const shape = createPublicEodRequestShape({ code: "005930", purpose: exact ? "exactDateRange" : "latestProbe",
    beginBasDt: exact ? target : null, endBasDt: exact ? target : null, pageNo: 1, numOfRows: 5, resultType: "json" });
  const requestedAt = new Date().toISOString();
  try {
    const response = await fetch(`https://apis.data.go.kr/1160100/service/GetStockSecuritiesInfoService/getStockPriceInfo?serviceKey=${serviceKey}&${createPublicEodQuery(shape)}`,
      { cache: "no-store", redirect: "error", signal: AbortSignal.timeout(15000) });
    const body = await response.text(), receivedAt = new Date().toISOString();
    let payload; try { payload = JSON.parse(body); } catch { throw new Error("PROBE_NON_JSON_RESPONSE"); }
    const dates = normalizePublicEodRows(payload?.response?.body?.items?.item, { code: "005930" }).rows.map(row => String(row.basDt));
    results.push({ shape, requestFingerprint: publicEodRequestFingerprint(shape), requestedAt, receivedAt, httpStatus: response.status,
      businessStatus: String(payload?.response?.header?.resultCode ?? "UNKNOWN"),
      totalCount: Number(payload?.response?.body?.totalCount ?? 0), dates, targetFound: dates.includes(target),
      rawBodySha256: createHash("sha256").update(body).digest("hex"),
      serverDate: response.headers.get("date"), age: response.headers.get("age"), cacheStatus: response.headers.get("x-cache") });
  } catch (error) {
    results.push({ shape, requestFingerprint: publicEodRequestFingerprint(shape), requestedAt, receivedAt: new Date().toISOString(),
      reason: error?.message === "PROBE_NON_JSON_RESPONSE" ? error.message : "PROBE_TRANSPORT_FAILED" });
  }
}
console.log(JSON.stringify({ requestedDate: date, maximumRequests: 2, fullCollection: false, localCacheUsed: false,
  rawPricesIncluded: false, results }));
