import fs from "node:fs/promises";
import { createKisTokenManager } from "../lib/kis-token-manager-core.mjs";
import { createKisApiClient } from "../lib/kis-api-client-core.mjs";
import { createKisEodProvider } from "../lib/kis-eod-provider.mjs";
import { createPublicEodQuery, createPublicEodRequestShape, normalizePublicEodRows } from "../lib/public-eod-request.mjs";
import { calculateSnapshotModels } from "../lib/model-score-engine.mjs";

// Explicit diagnostic only: never writes prices, candidates, outcomes or production.
const date = process.argv.find((arg) => arg.startsWith("--date="))?.slice(7);
const codes = (process.argv.find((arg) => arg.startsWith("--codes="))?.slice(8) ?? "005930,000660,064290").split(",");
const comparisonOnly = process.argv.includes("--comparison-only");
if (!/^\d{4}-\d{2}-\d{2}$/u.test(date ?? "") || codes.length > 10 || codes.some((code) => !/^\d{6}$/u.test(code))) throw new Error("DIAGNOSTIC_ARGUMENT_INVALID");
const credentials = () => ({ appKey: process.env.KIS_APP_KEY, appSecret: process.env.KIS_APP_SECRET });
const boundedFetch = (url, init = {}) => fetch(url, { ...init, redirect: "error", signal: init.signal ?? AbortSignal.timeout(15_000) });
const tokenManager = createKisTokenManager({ fetchImpl: boundedFetch, getCredentials: credentials });
const client = createKisApiClient({ fetchImpl: boundedFetch, tokenManager, getCredentials: credentials });
const provider = createKisEodProvider({ client, delayMs: 350 });
const report = { diagnosticOnly: true, requestedDate: date, sourceFinality: "NOT_CONFIRMED", calendar: null, results: [] };
try { report.calendar = await provider.getTradingDay(date); } catch (error) { report.calendar = { status: "unknown", reason: error.code ?? "KIS_CALENDAR_FAILED" }; }
const seed = await fs.readFile(`data/analysis/market-seeds/${date}.json`, "utf8").then(JSON.parse).catch(() => null);
for (const code of codes) {
  try {
    const history = await provider.getHistory(code, date, { requiredRows: comparisonOnly ? 5 : 260 });
    const adjusted = await provider.getHistory(code, date, { adjustment: "adjusted", requiredRows: 5, maxPages: 1 });
    let official = null, publicStatus = "CREDENTIAL_MISSING";
    if (process.env.DATA_GO_KR_SERVICE_KEY) {
      try {
        const shape = createPublicEodRequestShape({ code, purpose: "kisEodComparison", numOfRows: 10 });
        const query = createPublicEodQuery(shape);
        query.set("basDt", date.replaceAll("-", ""));
        const response = await boundedFetch(`https://apis.data.go.kr/1160100/service/GetStockSecuritiesInfoService/getStockPriceInfo?serviceKey=${process.env.DATA_GO_KR_SERVICE_KEY}&${query}`);
        if (!response.ok) throw new Error("PUBLIC_HTTP_FAILURE");
        const payload = await response.json();
        if (payload?.response?.header?.resultCode !== "00") throw new Error("PUBLIC_BUSINESS_FAILURE");
        official = normalizePublicEodRows(payload?.response?.body?.items?.item, { code, requestedDate: date.replaceAll("-", "") }).rows[0] ?? null;
        publicStatus = official ? "EXACT_DATE_FOUND" : "EXACT_DATE_NOT_AVAILABLE";
      } catch { publicStatus = "PUBLIC_REQUEST_FAILED"; }
    }
    const latest = history.rows[0];
    const comparisons = official ? Object.fromEntries(["mkp", "hipr", "lopr", "clpr", "trqu", "trPrc"].map((field) => [field, { equal: latest[field] === Number(official[field]), relativeDifferencePercent: Number(official[field]) !== 0 ? Math.round((latest[field] / Number(official[field]) - 1) * 1e6) / 1e4 : null }])) : null;
    const normalized = history.rows.map((row, index, rows) => ({ ...row, fltRt: row.fltRt ?? (rows[index + 1]?.clpr > 0 ? (row.clpr / rows[index + 1].clpr - 1) * 100 : null) }));
    const first = comparisonOnly ? null : calculateSnapshotModels(normalized), second = comparisonOnly ? null : calculateSnapshotModels(normalized);
    const item = seed?.records?.find((record) => record.code === code);
    const saved = item?.rows?.find((row) => row[0] === date.replaceAll("-", ""));
    const savedComparison = saved ? Object.fromEntries(["mkp", "hipr", "lopr", "clpr", "trqu"].map((field, index) => [field, { equal: latest[field] === saved[index + 1], relativeDifferencePercent: saved[index + 1] !== 0 ? Math.round((latest[field] / saved[index + 1] - 1) * 1e6) / 1e4 : null }])) : null;
    report.results.push({ code, status: "COLLECTED", exactDate: latest.basDt === date.replaceAll("-", ""), rows: history.rows.length, pages: history.pageCount, fieldsComplete: ["mkp", "hipr", "lopr", "clpr", "trqu", "trPrc"].every((field) => latest[field] !== null), symbolMapping: history.symbolMapping.status, priceBasis: history.priceBasis, adjustmentMetadataPresent: history.adjustmentMetadata.length, adjustedVsOriginalEqual: adjusted.rows.every((row) => ["mkp", "hipr", "lopr", "clpr"].every((field) => row[field] === history.rows.find((entry) => entry.basDt === row.basDt)?.[field])), officialComparison: { publicStatus, fields: comparisons, savedSeedFound: Boolean(item), savedOfficialOhlcv: savedComparison, savedTradingValue: "NOT_STORED_IN_SEED" }, modelEngineDeterministic: first ? JSON.stringify(first) === JSON.stringify(second) : null, modelOutputsPresent: first ? ["modelA", "modelAV2", "modelB", "modelC", "modelD"].every((key) => first[key] !== null) : null });
  } catch (error) { report.results.push({ code, status: "FAILED", reason: /^KIS_[A-Z0-9_]+$/u.test(error.code ?? "") ? error.code : "DIAGNOSTIC_FAILED" }); }
}
console.log(JSON.stringify(report, null, 2));
