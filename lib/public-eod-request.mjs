import { createHash } from "node:crypto";
import { normalizeStockCode } from "./stock-code.mjs";

export const PUBLIC_EOD_OPERATION = "getStockPriceInfo";
export const PUBLIC_EOD_NORMALIZATION_VERSION = "official-eod-normalization-v3";
const DATE = /^\d{8}$/;

const cleanDate = (value, name) => {
  if (value == null || value === "") return null;
  const text = String(value);
  if (!DATE.test(text)) throw new Error(`${name}은 YYYYMMDD 형식이어야 합니다.`);
  return text;
};

export function createPublicEodRequestShape(input) {
  const code = normalizeStockCode(input.code);
  if (!code) throw new Error("유효한 종목코드가 필요합니다.");
  const pageNo = Number(input.pageNo ?? 1), numOfRows = Number(input.numOfRows ?? 260);
  if (!Number.isInteger(pageNo) || pageNo < 1 || !Number.isInteger(numOfRows) || numOfRows < 1) throw new Error("pageNo/numOfRows가 유효하지 않습니다.");
  return {
    operation: PUBLIC_EOD_OPERATION,
    purpose: String(input.purpose ?? "historyCollection"),
    codeParameter: "likeSrtnCd",
    code,
    beginBasDt: cleanDate(input.beginBasDt, "beginBasDt"),
    endBasDt: cleanDate(input.endBasDt, "endBasDt"),
    pageNo,
    numOfRows,
    resultType: String(input.resultType ?? "json"),
    normalizationVersion: PUBLIC_EOD_NORMALIZATION_VERSION,
  };
}

export function publicEodRequestFingerprint(shape) {
  const canonical = JSON.stringify(Object.fromEntries(Object.entries(shape).sort(([a], [b]) => a.localeCompare(b))));
  return createHash("sha256").update(canonical).digest("hex");
}

export function createPublicEodQuery(shape) {
  const query = new URLSearchParams({ resultType: shape.resultType, pageNo: String(shape.pageNo), numOfRows: String(shape.numOfRows), [shape.codeParameter]: shape.code });
  if (shape.beginBasDt) query.set("beginBasDt", shape.beginBasDt);
  if (shape.endBasDt) query.set("endBasDt", shape.endBasDt);
  return query;
}

export function normalizePublicEodRows(items, { code, requestedDate = null } = {}) {
  const normalizedCode = normalizeStockCode(code);
  const source = !items ? [] : Array.isArray(items) ? items : [items];
  const matching = source.filter((row) => normalizeStockCode(row.srtnCd) === normalizedCode);
  const futureRows = requestedDate ? matching.filter((row) => String(row.basDt) > requestedDate) : [];
  const rows = matching.filter((row) => !requestedDate || String(row.basDt) <= requestedDate).sort((a, b) => String(b.basDt).localeCompare(String(a.basDt)));
  const dates = rows.map((row) => String(row.basDt));
  const duplicates = dates.filter((date, index) => dates.indexOf(date) !== index);
  if (duplicates.length) throw new Error(`중복 basDt 응답: ${[...new Set(duplicates)].join(",")}`);
  return { rows, futureRowCount: futureRows.length, futureDates: [...new Set(futureRows.map((row) => String(row.basDt)))].sort(), exactDateFound: requestedDate ? dates.includes(requestedDate) : null };
}

export function createPublicEodSingleFlight() {
  const inFlight = new Map(), resolved = new Map();
  const generations = new Map();
  return {
    run(shape, loader) {
      const fingerprint = publicEodRequestFingerprint(shape);
      if (resolved.has(fingerprint)) return Promise.resolve(resolved.get(fingerprint));
      if (inFlight.has(fingerprint)) return inFlight.get(fingerprint);
      const generation = (generations.get(fingerprint) ?? 0) + 1;
      generations.set(fingerprint, generation);
      const promise = Promise.resolve().then(loader).then((value) => { if (generations.get(fingerprint) === generation) resolved.set(fingerprint, value); return value; }).finally(() => { if (generations.get(fingerprint) === generation) inFlight.delete(fingerprint); });
      inFlight.set(fingerprint, promise);
      return promise;
    },
    has(shape) { const fingerprint = publicEodRequestFingerprint(shape); return inFlight.has(fingerprint) || resolved.has(fingerprint); },
    size() { return inFlight.size + resolved.size; },
  };
}

export function evaluatePublicEodCandidate({ requestedDate, latestDates, existingLatestDate = null }) {
  const distribution = latestDates.reduce((counts, date) => { const key = date ?? "missing"; counts[key] = (counts[key] ?? 0) + 1; return counts; }, {});
  const unique = Object.keys(distribution);
  const allExact = latestDates.length > 0 && latestDates.every((date) => date === requestedDate);
  let status = allExact ? "FULL_UNIVERSE_EXACT_DATE" : "FULL_UNIVERSE_DATE_MISMATCH";
  if (allExact && existingLatestDate && requestedDate === existingLatestDate) status = "NO_NEW_OFFICIAL_EOD";
  if (existingLatestDate && requestedDate < existingLatestDate) status = "CANDIDATE_OLDER_THAN_HISTORY";
  return { status, approved: status === "FULL_UNIVERSE_EXACT_DATE", distribution, minimumLatestBasDt: unique.filter((date) => date !== "missing").sort().at(0) ?? null, maximumLatestBasDt: unique.filter((date) => date !== "missing").sort().at(-1) ?? null };
}
