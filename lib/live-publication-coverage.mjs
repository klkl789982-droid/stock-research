import { isLiveMissingReason } from "./live-collection-reason.mjs";
import { STOCK_CODE_PATTERN } from "./stock-code.mjs";

const digest = value => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
const exact = (value, fields) => value && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).sort().join() === [...fields].sort().join();
const iso = value => typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const coverageFields = ["status", "targetCount", "validCount", "missing", "universeHash"];
const publicationFields = ["revision", "previousDeliveryHash", "firstIssuedAt"];

export function validLiveCoverage(value, published = false) {
  if (!exact(value, published ? [...coverageFields, ...publicationFields] : coverageFields)
    || !digest(value.universeHash) || !Number.isSafeInteger(value.targetCount) || value.targetCount < 0 || value.targetCount > 553
    || !Number.isSafeInteger(value.validCount) || value.validCount < 0 || !Array.isArray(value.missing)
    || value.validCount + value.missing.length !== value.targetCount) return false;
  const missing = value.missing;
  return value.status === (missing.length === 0 ? "COMPLETE" : missing.length <= 4 ? "PARTIAL" : "WITHHELD")
    && missing.every((row, i) => exact(row, ["ticker", "reason"]) && typeof row.ticker === "string"
      && STOCK_CODE_PATTERN.test(row.ticker) && isLiveMissingReason(row.reason) && (i === 0 || missing[i - 1].ticker < row.ticker));
}

export function validLivePublication(value, exportedAt) {
  return validLiveCoverage(value, true) && value.status !== "WITHHELD" && value.validCount >= 5
    && Number.isSafeInteger(value.revision) && value.revision >= 1 && value.revision <= 5 - value.missing.length
    && iso(value.firstIssuedAt) && value.firstIssuedAt <= exportedAt
    && (value.revision === 1 ? value.previousDeliveryHash === null && value.firstIssuedAt === exportedAt : digest(value.previousDeliveryHash));
}

export function validLiveSuccessor(previous, next) {
  const a = previous.publication, b = next.publication;
  const oldMissing = new Set(a.missing.map(row => row.ticker));
  return previous.signalDate === next.signalDate && previous.models[0].seedReferenceDate === next.models[0].seedReferenceDate
    && previous.sourceHash !== next.sourceHash && a.universeHash === b.universeHash && a.targetCount === b.targetCount
    && b.revision === a.revision + 1 && b.previousDeliveryHash === previous.deliveryHash
    && b.firstIssuedAt === a.firstIssuedAt && previous.exportedAt <= next.exportedAt
    && Date.parse(next.models[0].collectionStartedAt) <= Date.parse(previous.models[0].collectionStartedAt)
    && Date.parse(next.models[0].collectionCompletedAt) >= Date.parse(previous.models[0].collectionCompletedAt)
    && b.validCount > a.validCount && b.missing.every(row => oldMissing.has(row.ticker));
}
