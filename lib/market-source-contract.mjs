// Isolated research contract. Never imported by the Daily/LIVE publication paths.
import { normalizeStockCode } from "./stock-code.mjs";
import { normalizePublicEodRows } from "./public-eod-request.mjs";
import { parseKisDailyBarResponse } from "./kis-eod-provider.mjs";
import { classifyMarketDataRow } from "./market-data-quality-validator.mjs";
import { sha256Canonical } from "./snapshot-quality-pipeline.mjs";

export const MARKET_SOURCE_CONTRACT = "market-source-research-v1";
export const SOURCE_IDS = Object.freeze(["PUBLIC_EOD", "KIS"]);
export const PRICE_FIELDS = Object.freeze(["mkp", "hipr", "lopr", "clpr", "trqu", "trPrc"]);
export const RIGHTS = Object.freeze(["apiQuery", "automaticCollection", "localStorage", "cloudStorage", "privateResearch", "derivedCalculation", "websiteDisplay", "thirdPartySharing"]);
const fail = (code) => { throw Object.assign(new Error(code), { code }); };
export const validResearchDate = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(v) && Number.isFinite(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
const validStamp = (v) => typeof v === "string" && /(?:Z|[+-]\d\d:\d\d)$/u.test(v) && Number.isFinite(Date.parse(v));
const number = (v) => {
  if (v === null || v === undefined || v === "") return null;
  if (!(typeof v === "number" || typeof v === "string" && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/u.test(v))) fail("SOURCE_NUMBER_INVALID");
  const n = Number(v); if (!Number.isFinite(n)) fail("SOURCE_NUMBER_INVALID"); return n;
};
const iso = (v) => `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`;
export function requireResearchRights(grants, provider, actions) {
  if (!SOURCE_IDS.includes(provider) || actions.some((action) => !RIGHTS.includes(action) || grants?.[provider]?.[action]?.status !== "ALLOWED" || !/^[A-Za-z0-9_.:-]{1,160}$/u.test(grants[provider][action].evidenceId ?? ""))) fail("SOURCE_RIGHTS_NOT_VERIFIED");
}
export function researchInputBody(observation) {
  const { provider, ticker, market, referenceDate, adjustment, sessionScope, sourceFinality, observationType, rows } = observation;
  return { provider, ticker, market, referenceDate, adjustment, sessionScope, sourceFinality, observationType, rows };
}
export function verifyResearchObservation(value) {
  const { observationHash, ...body } = value ?? {};
  if (body.contractVersion !== MARKET_SOURCE_CONTRACT || sha256Canonical(body) !== observationHash || sha256Canonical(researchInputBody(value)) !== value.inputHash) fail("SOURCE_OBSERVATION_HASH_INVALID");
  // Revalidate the semantic fields too; a hash alone is not a quality certificate.
  const rebuilt = normalizeResearchHistory({ ...body, rawSourceHash: body.rawSourceHash });
  if (rebuilt.observationHash !== observationHash) fail("SOURCE_OBSERVATION_INVALID");
  return value;
}
export function normalizeResearchHistory({ provider, ticker, market = null, referenceDate, rows, requestedAt = null, receivedAt = null,
  adjustment = "UNKNOWN", sessionScope = "UNKNOWN", sourceFinality = "UNKNOWN", observationType = "ACTUAL_RESPONSE",
  rawSourceHash, adapterVersion = `${MARKET_SOURCE_CONTRACT}:normalized`, corporateActionStatus = "UNKNOWN", securityStatus = "UNKNOWN" }) {
  if (!SOURCE_IDS.includes(provider) || normalizeStockCode(ticker) !== ticker || !validResearchDate(referenceDate) || !Array.isArray(rows) || rows.length > 1000) fail("SOURCE_CONTRACT_INVALID");
  if (![null, "KOSPI", "KOSDAQ", "KONEX"].includes(market) || !["UNKNOWN", "unadjusted", "adjusted"].includes(adjustment)
    || !["UNKNOWN", "REGULAR", "REGULAR_AND_AFTER_HOURS"].includes(sessionScope)
    || !["UNKNOWN", "PROVISIONAL", "SUPPLIER_OFFICIAL"].includes(sourceFinality)
    || !["ACTUAL_RESPONSE", "SAVED_ARTIFACT", "TEST_FIXTURE"].includes(observationType)
    || !["UNKNOWN", "NONE_REPORTED", "EVENT_REPORTED"].includes(corporateActionStatus)
    || !["UNKNOWN", "TRADING", "HALTED", "NEW_LISTING", "DELISTED"].includes(securityStatus)
    || !/^[A-Za-z0-9_.:-]{1,100}$/u.test(adapterVersion) || !/^[a-f0-9]{64}$/u.test(rawSourceHash ?? "")) fail("SOURCE_METADATA_INVALID");
  if ((requestedAt !== null && !validStamp(requestedAt)) || (receivedAt !== null && !validStamp(receivedAt)) || (requestedAt && receivedAt && Date.parse(requestedAt) > Date.parse(receivedAt))) fail("SOURCE_TIMESTAMPS_INVALID");
  const normalized = rows.map((row) => {
    const date = String(row?.basDt ?? "");
    if (!/^\d{8}$/u.test(date) || !validResearchDate(iso(date)) || iso(date) > referenceDate || normalizeStockCode(row?.srtnCd) !== ticker) fail("SOURCE_DATE_OR_TICKER_MISMATCH");
    return { basDt: date, srtnCd: ticker, ...Object.fromEntries([...PRICE_FIELDS, "fltRt", "mrktTotAmt"].map((key) => [key, number(row[key])])) };
  }).sort((a, b) => b.basDt.localeCompare(a.basDt));
  if (new Set(normalized.map((row) => row.basDt)).size !== normalized.length) fail("SOURCE_DUPLICATE_DATE");
  const issues = [];
  if (normalized[0]?.basDt !== referenceDate.replaceAll("-", "")) issues.push("EXACT_DATE_UNAVAILABLE");
  normalized.forEach((row, i) => {
    const q = classifyMarketDataRow(row, normalized[i + 1], normalized[i - 1]);
    if (q.type === "invalidTradingRow" || q.postNonTradingPriceDiscontinuity) issues.push("OHLCV_OR_CORPORATE_ACTION_INVALID");
    if (!Number.isSafeInteger(row.trqu)) issues.push("VOLUME_INVALID");
    if (row.trPrc === null || row.trPrc < 0) issues.push("TRADING_VALUE_MISSING_OR_INVALID");
  });
  const body = { contractVersion: MARKET_SOURCE_CONTRACT, provider, ticker, market, referenceDate, rows: normalized,
    adjustment, sessionScope, sourceFinality, observationType, requestedAt, receivedAt, rawSourceHash, adapterVersion,
    corporateActionStatus, securityStatus, quality: { status: issues.length ? "NOT_READY" : "VALIDATED_FIELDS_ONLY", issues: [...new Set(issues)] },
    inputHash: sha256Canonical({ provider, ticker, market, referenceDate, adjustment, sessionScope, sourceFinality, observationType, rows: normalized }) };
  return { ...body, observationHash: sha256Canonical(body) };
}
export function adaptPublicEodResponse(payload, context) {
  if (String(payload?.response?.header?.resultCode) !== "00") fail("PUBLIC_EOD_BUSINESS_FAILURE");
  const rows = normalizePublicEodRows(payload.response.body?.items?.item, { code: context.ticker }).rows;
  return normalizeResearchHistory({ ...context, provider: "PUBLIC_EOD", rows, rawSourceHash: sha256Canonical(payload),
    // The portal does not specify adjusted-price or session equivalence. Do not infer it.
    adjustment: "UNKNOWN", sessionScope: "UNKNOWN", sourceFinality: "SUPPLIER_OFFICIAL", adapterVersion: `${MARKET_SOURCE_CONTRACT}:public` });
}
export function adaptKisEodResponse(payload, context) {
  const parsed = parseKisDailyBarResponse(payload, { code: context.ticker, startDate: context.startDate, endDate: context.referenceDate, adjustment: context.adjustment });
  if (parsed.symbolMapping.status !== "VERIFIED_RESPONSE_TICKER") fail("SOURCE_TICKER_UNVERIFIED");
  return normalizeResearchHistory({ ...context, provider: "KIS", rows: parsed.rows, adjustment: parsed.adjustment,
    rawSourceHash: sha256Canonical(payload), sessionScope: "UNKNOWN", sourceFinality: "PROVISIONAL", adapterVersion: `${MARKET_SOURCE_CONTRACT}:kis`,
    corporateActionStatus: parsed.adjustmentMetadata.some((v) => v.changed === "Y" || v.splitRatio !== null && v.splitRatio !== 0) ? "EVENT_REPORTED" : "UNKNOWN" });
}
export function compareResearchObservations(left, right) {
  verifyResearchObservation(left); verifyResearchObservation(right);
  const reasons = [];
  if (left.ticker !== right.ticker || left.referenceDate !== right.referenceDate) reasons.push("IDENTITY_MISMATCH");
  for (const key of ["adjustment", "sessionScope"]) {
    if ([left[key], right[key]].includes("UNKNOWN")) reasons.push(`${key.toUpperCase()}_UNVERIFIED`);
    else if (left[key] !== right[key]) reasons.push(`${key.toUpperCase()}_MISMATCH`);
  }
  if (left.corporateActionStatus === "EVENT_REPORTED" || right.corporateActionStatus === "EVENT_REPORTED") reasons.push("CORPORATE_ACTION_REVIEW_REQUIRED");
  const date = left.referenceDate.replaceAll("-", "");
  const a = left.rows.find((r) => r.basDt === date), b = right.rows.find((r) => r.basDt === date);
  if (!a || !b) reasons.push("EXACT_DATE_UNAVAILABLE");
  if (left.quality.issues.length || right.quality.issues.length) reasons.push("INPUT_QUALITY_NOT_READY");
  const fields = Object.fromEntries(PRICE_FIELDS.map((key) => {
    const comparable = left.ticker === right.ticker && left.referenceDate === right.referenceDate && a?.[key] != null && b?.[key] != null;
    return [key, { difference: comparable ? b[key] - a[key] : null, relativeDifference: comparable && a[key] !== 0 ? (b[key] - a[key]) / Math.abs(a[key]) : null }];
  }));
  return { namespace: MARKET_SOURCE_CONTRACT, status: reasons.length ? "DIAGNOSTIC_ONLY" : "COMPARABLE", reasons,
    fields, leftInputHash: left.inputHash, rightInputHash: right.inputHash, causeConfirmed: false,
    possibleCauses: PRICE_FIELDS.some((key) => fields[key].difference !== null && fields[key].difference !== 0) ? ["UPDATE_TIMING", "SESSION_SCOPE", "ADJUSTMENT_OR_CORPORATE_ACTION", "PROVIDER_REVISION"] : [],
    officialReplacementAllowed: false, finalityConfirmed: false };
}
