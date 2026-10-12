import { normalizeStockCode } from "./stock-code.mjs";
import { sha256Canonical } from "./snapshot-quality-pipeline.mjs";
import { validResearchDate } from "./market-source-contract.mjs";
export const FORENSIC_FIELDS = Object.freeze(["mkp", "hipr", "lopr", "clpr", "trqu", "trPrc"]);
export function decodeOfficialSeedRow(seed, ticker, date) {
  if (seed?.requestedDate !== date || JSON.stringify(seed.tupleFields) !== JSON.stringify(["date", "open", "high", "low", "close", "volume"])) throw new Error("FORENSIC_SEED_CONTRACT_INVALID");
  const records = seed.records.filter((r) => r.code === ticker);
  if (records.length !== 1) throw new Error("FORENSIC_SEED_TICKER_INVALID");
  const matches = records[0].rows.filter((r) => String(r[0]).replaceAll("-", "") === date.replaceAll("-", ""));
  if (matches.length !== 1) throw new Error("FORENSIC_SEED_DATE_INVALID");
  const [basDt, mkp, hipr, lopr, clpr, trqu] = matches[0];
  return { basDt: String(basDt).replaceAll("-", ""), srtnCd: ticker, mkp, hipr, lopr, clpr, trqu, trPrc: null };
}
function validRow(row) {
  return row && /^\d{8}$/u.test(row.basDt ?? "") && validResearchDate(`${row.basDt.slice(0,4)}-${row.basDt.slice(4,6)}-${row.basDt.slice(6,8)}`) && normalizeStockCode(row.srtnCd) === row.srtnCd
    && FORENSIC_FIELDS.slice(0, 5).every((f) => typeof row[f] === "number" && Number.isFinite(row[f]))
    && row.clpr > 0 && Number.isSafeInteger(row.trqu) && row.trqu >= 0
    && (row.mkp === 0 && row.hipr === 0 && row.lopr === 0 && row.trqu === 0 || row.lopr > 0 && row.lopr <= Math.min(row.mkp, row.clpr) && row.hipr >= Math.max(row.mkp, row.clpr))
    && (row.trPrc === null || typeof row.trPrc === "number" && Number.isFinite(row.trPrc) && row.trPrc >= 0);
}
export function forensicComparison(left, right) {
  if (!validRow(left) || !validRow(right) || left.srtnCd !== right.srtnCd || left.basDt !== right.basDt) throw new Error("FORENSIC_IDENTITY_OR_FIELDS_INVALID");
  const fields = Object.fromEntries(FORENSIC_FIELDS.map((f) => [f, left[f] === null || right[f] === null ? null : left[f] === right[f]]));
  return { fields, equalOHLCV: FORENSIC_FIELDS.slice(0, 5).every((f) => fields[f]), comparableFields: Object.values(fields).filter((v) => v !== null).length };
}
export function diagnoseObservationRevision({ cached, fresh, official, saved, rawKisMapped, observationHashVerified }) {
  if (observationHashVerified !== true) throw new Error("FORENSIC_CACHED_HASH_INVALID");
  const priorVsCurrent = forensicComparison(cached, fresh), currentVsOfficial = forensicComparison(fresh, official);
  const currentVsSaved = forensicComparison(fresh, saved), rawVsParsed = forensicComparison(rawKisMapped, fresh);
  return { code: cached.srtnCd, date: cached.basDt, priorVsCurrent, currentVsOfficial, currentVsSaved, rawVsParsed,
    diagnosis: Object.values(rawVsParsed.fields).includes(false) ? "PARSING_OR_MAPPING_MISMATCH" : !currentVsSaved.equalOHLCV && !Object.values(currentVsOfficial.fields).includes(false) ? "SAVED_OFFICIAL_REVISION_OR_PROCESSING_DIFFERENCE"
      : Object.values(priorVsCurrent.fields).includes(false) && !Object.values(currentVsOfficial.fields).includes(false) && currentVsSaved.equalOHLCV ? "PRIOR_OBSERVATION_DIFFERS_CURRENT_RESPONSE" : !Object.values(currentVsOfficial.fields).includes(false) ? "CURRENT_FIELDS_AGREE" : "CURRENT_PROVIDER_DISCREPANCY",
    equivalenceCertified: false, oldRawResponseAvailable: false, supplierInternalCauseConfirmed: false,
    hashes: { cached: sha256Canonical(cached), fresh: sha256Canonical(fresh), official: sha256Canonical(official) }, productionChanged: false };
}
