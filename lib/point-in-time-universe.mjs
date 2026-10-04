import fs from "node:fs/promises";
import path from "node:path";
import { normalizeStockCode } from "./stock-code.mjs";
import { sha256Canonical } from "./snapshot-quality-pipeline.mjs";

const DATE = /^\d{4}-\d{2}-\d{2}$/u;
const timestamp = (value) => typeof value === "string" && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
const codesHash = (stocks) => sha256Canonical(stocks.map((stock) => normalizeStockCode(stock.code)).sort());

function validatedStocks(stocks, count) {
  if (!Array.isArray(stocks) || !stocks.length || count !== stocks.length) throw new Error("UNIVERSE_COUNT_MISMATCH");
  const codes = stocks.map((stock) => normalizeStockCode(stock.code));
  if (codes.some((code) => !code) || new Set(codes).size !== codes.length) throw new Error("UNIVERSE_CODE_INVALID_OR_DUPLICATE");
  return stocks.map((stock, index) => ({ ...stock, code: codes[index] }));
}

function fromArchive(archive, referenceDate, artifactPath, evaluationTime) {
  if (archive.requestedDate !== referenceDate || archive.referenceDate && archive.referenceDate !== referenceDate) throw new Error("UNIVERSE_REFERENCE_DATE_MISMATCH");
  const { contentHash, ...base } = archive;
  if (contentHash !== sha256Canonical(base)) throw new Error("UNIVERSE_ARTIFACT_HASH_MISMATCH");
  const stocks = validatedStocks(archive.observedUniverse, archive.universeCount ?? archive.observedUniverse?.length);
  const hash = codesHash(stocks);
  if (archive.universeCodesHash && archive.universeCodesHash !== hash) throw new Error("UNIVERSE_CODES_HASH_MISMATCH");
  const effective = archive.effectiveAt == null ? null : timestamp(archive.effectiveAt);
  if (archive.effectiveAt != null && effective == null) throw new Error("UNIVERSE_EFFECTIVE_AT_INVALID");
  if (effective != null && effective > evaluationTime) throw new Error("UNIVERSE_FUTURE_KNOWLEDGE");
  const verified = archive.provenanceVerification?.status === "VERIFIED"
    && effective != null
    && timestamp(archive.createdAt) != null
    && timestamp(archive.createdAt) <= evaluationTime
    && effective >= timestamp(archive.createdAt)
    && Boolean(archive.filterVersion && archive.criteria && archive.universeCodesHash)
    && archive.sourceManifest?.securityMaster?.pointInTimeCertified === true
    && archive.sourceManifest.securityMaster.asOfDate != null
    && Boolean(archive.sourceManifest.securityMaster.contentHash && archive.sourceManifest.officialDailyPriceHash)
    && archive.sourceManifest.securityMaster.asOfDate <= referenceDate;
  return {
    universe: { generatedAt: archive.createdAt ?? archive.generatedAt ?? null, latestTradingDate: referenceDate.replaceAll("-", ""), criteria: archive.criteria, finalCount: stocks.length, stocks },
    artifact: archive,
    provenance: { referenceDate, artifactPath, effectiveAt: archive.effectiveAt ?? null, count: stocks.length, codesHash: hash, verificationStatus: verified ? "VERIFIED" : "UNVERIFIED", selectionReason: verified ? "EXACT_DATE_VERIFIED_ARCHIVE" : "EXACT_DATE_LEGACY_ARCHIVE" },
  };
}

export async function resolveUniverseForDate(referenceDate, { root = process.cwd() } = {}) {
  if (!DATE.test(referenceDate)) throw new Error("UNIVERSE_REFERENCE_DATE_INVALID");
  const evaluationTime = Date.parse(`${referenceDate}T23:59:59.999+09:00`);
  const relativeArchive = `data/universe-history/${referenceDate}.json`;
  try {
    const archive = JSON.parse(await fs.readFile(path.join(root, relativeArchive), "utf8"));
    return fromArchive(archive, referenceDate, relativeArchive, evaluationTime);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const relativeCurrent = "data/universe.json";
  const current = JSON.parse(await fs.readFile(path.join(root, relativeCurrent), "utf8"));
  const stocks = validatedStocks(current.stocks, current.finalCount);
  const generatedAt = timestamp(current.generatedAt);
  if (generatedAt == null) throw new Error("UNIVERSE_AVAILABILITY_UNKNOWN");
  if (generatedAt != null && generatedAt > evaluationTime) throw new Error("UNIVERSE_FUTURE_KNOWLEDGE");
  if (current.latestTradingDate && current.latestTradingDate > referenceDate.replaceAll("-", "")) throw new Error("UNIVERSE_FUTURE_KNOWLEDGE");
  return {
    universe: { ...current, stocks },
    artifact: null,
    provenance: { referenceDate, artifactPath: relativeCurrent, effectiveAt: current.generatedAt ?? null, count: stocks.length, codesHash: codesHash(stocks), verificationStatus: "UNVERIFIED", selectionReason: "CURRENT_UNIVERSE_LEGACY_FALLBACK" },
  };
}
