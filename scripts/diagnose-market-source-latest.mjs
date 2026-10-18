// Read-only bounded diagnosis. Prints counts/dates/hashes, never prices or URLs/keys.
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { createPublicEodQuery, createPublicEodRequestShape, normalizePublicEodRows } from "../lib/public-eod-request.mjs";
import { sha256Canonical } from "../lib/snapshot-quality-pipeline.mjs";
const validDate = (v) => /^\d{4}-\d{2}-\d{2}$/u.test(v ?? "") && Number.isFinite(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
export async function diagnosePublicLatest({ date, control, serviceKey, fetchImpl = fetch, now = () => new Date().toISOString(), audit = false, onEvidence = null }) {
  if (!validDate(date) || !validDate(control) || control >= date) throw new Error("DIAGNOSIS_DATE_INVALID");
  if (!serviceKey) throw new Error("DIAGNOSIS_CREDENTIAL_UNAVAILABLE");
  const target = date.replaceAll("-", ""), baseline = control.replaceAll("-", "");
  const variants = [];
  for (const code of ["005930", "000660"]) {
    for (const mode of ["latest", "range", "exact", "control"]) variants.push({ code, mode });
  }
  variants.push({ code: null, mode: "marketExact" }, { code: "005930", mode: "xmlExact" });
  if (audit) variants.push({ code: "005930", mode: "literalExact" }, { code: "005930", mode: "latestAgain" }, { code: null, mode: "marketControl" });
  const results = [];
  for (const { code, mode } of variants) {
    const shape = createPublicEodRequestShape({ code: code ?? "005930", numOfRows: ["latest", "latestAgain"].includes(mode) ? 260 : 5,
      beginBasDt: mode === "range" ? target : null, endBasDt: mode === "range" ? target : null });
    // Literal audit query is independently assembled, with the same documented
    // wire names in a different order; it does not trust the shared builder.
    const query = mode === "literalExact" ? new URLSearchParams({ basDt: target, likeSrtnCd: code, numOfRows: "5", pageNo: "1", resultType: "json" }) : createPublicEodQuery(shape);
    if (["exact", "control", "marketExact", "xmlExact", "marketControl"].includes(mode)) query.set("basDt", ["control", "marketControl"].includes(mode) ? baseline : target);
    if (!code) query.delete("likeSrtnCd");
    if (mode === "xmlExact") query.set("resultType", "xml");
    const requestHash = sha256Canonical(Object.fromEntries(query));
    const requestParameters = Object.fromEntries(query);
    // Existing configuration accepts an encoded or decoded portal service key.
    let decoded; try { decoded = decodeURIComponent(serviceKey); } catch { throw new Error("DIAGNOSIS_CREDENTIAL_INVALID"); }
    query.set("serviceKey", decoded);
    const requestedAt = now();
    try {
      const response = await fetchImpl(`https://apis.data.go.kr/1160100/service/GetStockSecuritiesInfoService/getStockPriceInfo?${query}`, {
        cache: "no-store", redirect: "error", signal: AbortSignal.timeout(15000), headers: { "Cache-Control": "no-cache", Pragma: "no-cache" },
      });
      if (!response.ok) { results.push({ code, mode, requestedAt, receivedAt: now(), requestHash, status: `HTTP_${response.status}` }); continue; }
      const body = await response.text(); let businessCode, totalCount, dates, rowCount, futureRowCount = 0, rawDates = [], rawRowCount = 0;
      const responseBytesSha256 = createHash("sha256").update(body).digest("hex");
      const responseHeaders = Object.fromEntries(["content-type", "date", "age", "cache-control", "etag", "last-modified", "via", "x-cache"].map(name => [name, response.headers.get(name)]));
      if (onEvidence) {
        if ([serviceKey, decoded, encodeURIComponent(decoded)].some(value => value && body.includes(value))) throw new Error("DIAGNOSIS_RESPONSE_REFLECTED_CREDENTIAL");
        await onEvidence({ code, mode, requestedAt, receivedAt: now(), requestParameters, requestHash, httpStatus: response.status, responseHeaders, responseBytesSha256, body });
      }
      if (mode === "xmlExact") {
        businessCode = body.match(/<resultCode>([^<]*)<\/resultCode>/u)?.[1] ?? null;
        const count = body.match(/<totalCount>(\d+)<\/totalCount>/u)?.[1];
        totalCount = count === undefined ? null : Number(count);
        dates = [...body.matchAll(/<basDt>(\d{8})<\/basDt>/gu)].map((m) => m[1]); rowCount = dates.length; rawDates = dates; rawRowCount = rowCount;
      } else {
        const payload = JSON.parse(body), data = payload?.response?.body;
        businessCode = payload?.response?.header?.resultCode ?? null;
        totalCount = /^\d+$/u.test(String(data?.totalCount ?? "")) ? Number(data.totalCount) : null;
        const items = data?.items?.item;
        const raw = items ? Array.isArray(items) ? items : [items] : [];
        rawDates = raw.map(row => String(row.basDt)).sort().reverse(); rawRowCount = raw.length;
        const rows = code ? normalizePublicEodRows(raw, { code }).rows : raw;
        dates = rows.map((r) => String(r.basDt)).sort().reverse(); rowCount = rows.length;
        futureRowCount = dates.filter((d) => d > target).length;
      }
      const success = String(businessCode) === "00" && totalCount !== null && (totalCount === 0 || rawRowCount > 0);
      results.push({ code, mode, requestedAt, receivedAt: now(), requestHash, requestParameters, httpStatus: response.status,
        status: success ? rowCount ? "ROWS_OBSERVED" : "EMPTY_RESPONSE_NOT_PROOF_OF_ABSENCE" : "BUSINESS_OR_SCHEMA_FAILURE",
        businessCode: /^\d{1,3}$/u.test(String(businessCode)) ? String(businessCode) : "INVALID", totalCount, rowCount,
        latestDate: dates[0] ?? null, containsTarget: dates.includes(target), futureRowCount,
        rawRowCount, rawLatestDate: rawDates[0] ?? null, rawContainsTarget: rawDates.includes(target), filteredRowCount: rawRowCount - rowCount,
        responseBytesSha256, responseHeaders,
        responseHash: sha256Canonical(body), cacheAge: /^\d+$/u.test(response.headers.get("age") ?? "") ? Number(response.headers.get("age")) : null });
    } catch { results.push({ code, mode, requestHash, requestedAt, receivedAt: now(), status: "NETWORK_OR_PARSE_FAILURE" }); }
  }
  return { namespace: "market-source-readonly-diagnosis-v1", targetDate: date, controlDate: control, requests: results.length,
    targetObserved: results.some((r) => r.containsTarget),
    rangeExactDisagreements: ["005930", "000660"].filter((code) => results.find((r) => r.code === code && r.mode === "exact")?.containsTarget
      && results.find((r) => r.code === code && r.mode === "range")?.rowCount === 0),
    sourceAbsenceConfirmed: false, productionChanged: false, results };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args.some((arg) => !/^--(date|control)=\d{4}-\d{2}-\d{2}$/u.test(arg))) throw new Error("USAGE: --date=YYYY-MM-DD --control=YYYY-MM-DD");
  try { console.log(JSON.stringify(await diagnosePublicLatest({ date: args.find((v) => v.startsWith("--date="))?.slice(7), control: args.find((v) => v.startsWith("--control="))?.slice(10), serviceKey: process.env.DATA_GO_KR_SERVICE_KEY }))); }
  catch { console.error("PUBLIC_SOURCE_DIAGNOSIS_FAILED"); process.exitCode = 1; }
}
