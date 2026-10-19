import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { createPublicEodRequestShape, createPublicEodQuery, normalizePublicEodRows,
  publicEodRequestFingerprint } from "../../lib/public-eod-request.mjs";

// Exactly two small read-only provider calls, no automatic retries, no raw
// prices printed/persisted, no candidate generation or official promotion.
export function readinessRequest(date, exact) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date ?? "") || !Number.isFinite(Date.parse(`${date}T00:00:00Z`))
    || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) throw new Error("PROBE_DATE_REQUIRED");
  // endBasDt is exclusive: begin=end is an empty range, not an exact-date test.
  // This diagnostic does not change the production collection contract.
  const shape = { ...createPublicEodRequestShape({ code: "005930", purpose: exact ? "exactDate" : "latestProbe",
    pageNo: 1, numOfRows: 5, resultType: "json" }), basDt: exact ? date.replaceAll("-", "") : null };
  const query = createPublicEodQuery(shape);
  if (shape.basDt) query.set("basDt", shape.basDt);
  return { shape, query };
}
export async function probeReadiness({ date, serviceKey, fetchImpl = fetch }) {
  readinessRequest(date, false);
  if (!serviceKey) throw new Error("PROBE_CREDENTIAL_UNAVAILABLE");
  const target = date.replaceAll("-", ""), results = [];
  for (const exact of [false, true]) {
    const { shape, query } = readinessRequest(date, exact);
    const requestedAt = new Date().toISOString();
    try {
      const response = await fetchImpl(`https://apis.data.go.kr/1160100/service/GetStockSecuritiesInfoService/getStockPriceInfo?serviceKey=${serviceKey}&${query}`,
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
  return { requestedDate: date, maximumRequests: 2, fullCollection: false, localCacheUsed: false,
    rawPricesIncluded: false, results };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(await probeReadiness({ date: process.argv.find(arg => arg.startsWith("--date="))?.slice(7),
    serviceKey: process.env.DATA_GO_KR_SERVICE_KEY })));
}
