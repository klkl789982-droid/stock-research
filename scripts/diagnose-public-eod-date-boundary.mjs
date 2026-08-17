import { createPublicEodQuery, createPublicEodRequestShape, normalizePublicEodRows, publicEodRequestFingerprint } from "../lib/public-eod-request.mjs";

const serviceKey = process.env.DATA_GO_KR_SERVICE_KEY;
if (!serviceKey) throw new Error("DATA_GO_KR_SERVICE_KEY가 없습니다.");
const endpoint = "https://apis.data.go.kr/1160100/service/GetStockSecuritiesInfoService/getStockPriceInfo";
const codes = ["005930", "000660", "247540"], targetDate = "20260813";
const variants = [
  { id: "A", purpose: "latestProbe", beginBasDt: null, endBasDt: null },
  { id: "B", purpose: "historyCollection", beginBasDt: null, endBasDt: targetDate },
  { id: "C", purpose: "exactDateRange", beginBasDt: targetDate, endBasDt: targetDate },
  { id: "D", purpose: "historyCollection", beginBasDt: null, endBasDt: targetDate },
];
const seen = new Map(), results = []; let httpRequests = 0, retries = 0;

async function request(shape, attempt = 1) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15_000);
  httpRequests += 1;
  try {
    const response = await fetch(`${endpoint}?serviceKey=${serviceKey}&${createPublicEodQuery(shape)}`, { signal: controller.signal });
    if ([401, 403, 429].includes(response.status)) throw Object.assign(new Error(`STOP_HTTP_${response.status}`), { stop: true, status: response.status });
    if (response.status >= 500 && attempt < 2) { retries += 1; return request(shape, attempt + 1); }
    if (!response.ok) throw Object.assign(new Error(`HTTP_${response.status}`), { status: response.status });
    const payload = await response.json();
    const businessStatus = String(payload?.response?.header?.resultCode ?? "UNKNOWN");
    const items = payload?.response?.body?.items?.item;
    const normalized = normalizePublicEodRows(items, { code: shape.code });
    const dates = normalized.rows.map((row) => String(row.basDt));
    return { httpStatus: response.status, businessStatus, totalCount: Number(payload?.response?.body?.totalCount ?? 0), returnedRowCount: dates.length, first3BasDt: dates.slice(0, 3), latestBasDt: dates.at(0) ?? null, earliestBasDt: dates.at(-1) ?? null, contains20260813: dates.includes("20260813"), contains20260812: dates.includes("20260812"), duplicateDateCount: dates.length - new Set(dates).size, futureDateCount: dates.filter((date) => date > targetDate).length, sortDirection: dates.every((date, index) => index === 0 || dates[index - 1] >= date) ? "descending" : "notDescending" };
  } finally { clearTimeout(timer); }
}

for (const code of codes) {
  for (const variant of variants) {
    const shape = createPublicEodRequestShape({ code, purpose: variant.purpose, beginBasDt: variant.beginBasDt, endBasDt: variant.endBasDt, pageNo: 1, numOfRows: 260, resultType: "json" });
    const fingerprint = publicEodRequestFingerprint(shape);
    const wireKey = createPublicEodQuery(shape).toString();
    if (!seen.has(wireKey)) seen.set(wireKey, request(shape));
    const response = await seen.get(wireKey);
    results.push({ variant: variant.id, sanitizedRequestShape: shape, requestFingerprint: fingerprint, deduplicatedWireRequest: variant.id === "D", ...response });
  }
}
console.log(`EOD_BOUNDARY_DIAGNOSIS_JSON=${JSON.stringify({ targetDate, maximumAllowedRequests: 12, httpRequests, retries, results })}`);
