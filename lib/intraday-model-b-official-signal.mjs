import { createHash } from "node:crypto";
import { calculateTechnicalModelFeatures } from "./technical-model-features.mjs";
import { calculateTrendStrength } from "./trend-strength.mjs";

export const INTRADAY_MODEL_B_SIGNAL_VERSION = "intraday-model-b-official-signal-v1";
export const OFFICIAL_SIGNAL_TIME = "14:30:00";

const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
const hash = (value) => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
const compact = (date) => String(date ?? "").replaceAll("-", "");
const finitePositive = (value) => Number.isFinite(Number(value)) && Number(value) > 0;

export function mergeProvisionalCandle(seedRows, quote) {
  const date = compact(quote?.asOfDate);
  if (!/^\d{8}$/u.test(date) || ![quote?.open, quote?.high, quote?.low, quote?.price].every(finitePositive) || !Number.isFinite(Number(quote?.volume)) || Number(quote.volume) < 0) return null;
  const rows = seedRows.map(([basDt, mkp, hipr, lopr, clpr, trqu]) => ({ basDt, mkp, hipr, lopr, clpr, trqu }));
  const provisional = { basDt: date, mkp: Number(quote.open), hipr: Number(quote.high), lopr: Number(quote.low), clpr: Number(quote.price), trqu: Number(quote.volume) };
  if (rows[0]?.basDt === date) rows[0] = provisional;
  else if (!rows[0] || date > rows[0].basDt) rows.unshift(provisional);
  else return null;
  return rows.slice(0, 260);
}

function quoteFailure(quote, signalDate) {
  if (!quote) return "quoteMissing";
  if (quote.asOfDate !== signalDate) return "quoteDateMismatch";
  if (!quote.asOfTime) return "quoteTimeMissing";
  if (!mergeProvisionalCandle([["20261001", 1, 1, 1, 1, 1]], quote)) return "invalidQuoteOhlcv";
  return null;
}

export function buildIntradayModelBSignal({ seed, quotesByCode, signalDate, collectionStartedAt, collectionCompletedAt, source = "KIS" }) {
  const records = [];
  for (const item of seed.records) {
    if (!item.eligible) {
      records.push({ ticker: item.code, companyName: item.name, dataStatus: "INELIGIBLE", reason: item.ineligibleReasons, score: null, rank: null });
      continue;
    }
    const quote = quotesByCode.get(item.code) ?? null;
    const failure = quoteFailure(quote, signalDate);
    if (failure) {
      records.push({ ticker: item.code, companyName: item.name, dataStatus: "MISSING", reason: failure, score: null, rank: null, observedAt: quote?.receivedAt ?? null, provisionalOhlcv: null });
      continue;
    }
    const rows = mergeProvisionalCandle(item.rows, quote);
    const features = calculateTechnicalModelFeatures(rows, null);
    const model = calculateTrendStrength(features);
    records.push({ ticker: item.code, companyName: item.name, dataStatus: "AVAILABLE", reason: null, score: model.trendStrength, rank: null, observedAt: quote.receivedAt, quoteAsOfTime: quote.asOfTime, provisionalOhlcv: { open: quote.open, high: quote.high, low: quote.low, close: quote.price, volume: quote.volume }, indicators: features, source: quote.source ?? source });
  }
  const ranked = records.filter((record) => record.dataStatus === "AVAILABLE").sort((a, b) => b.score - a.score || a.ticker.localeCompare(b.ticker));
  ranked.forEach((record, index) => { record.rank = index + 1; });
  const base = {
    schemaVersion: 1, artifactType: "intradayModelBOfficialSignal", signalDate, officialSignalTime: OFFICIAL_SIGNAL_TIME, timezone: "Asia/Seoul",
    collectionStartedAt, collectionCompletedAt, collectionWindow: { startedAt: collectionStartedAt, completedAt: collectionCompletedAt },
    model: "B", modelVersion: "B-v1", calculatorVersion: "trend-strength-v1", seedReferenceDate: seed.requestedDate,
    universe: { count: seed.records.length, eligibleCount: seed.records.filter((item) => item.eligible).length, eligibleHash: hash(seed.records.filter((item) => item.eligible).map((item) => item.code).sort()) },
    source: { provider: source, seedHash: seed.contentHash, seedOfficialDailyHash: seed.sourceManifest?.sources?.officialDailyPrice?.normalizedInputHash ?? null },
    collection: { successful: ranked.length, failed: records.filter((record) => record.dataStatus === "MISSING").length, ineligible: records.filter((record) => record.dataStatus === "INELIGIBLE").length },
    status: ranked.length === seed.records.filter((item) => item.eligible).length ? "READY" : "FAILED_COLLECTION",
    records: [...records].sort((a, b) => a.ticker.localeCompare(b.ticker)),
  };
  return { ...base, contentHash: hash(base) };
}

export function assertImmutableOfficialSignal(existing, candidate) {
  if (!existing) return "create";
  if (existing.contentHash === candidate.contentHash) return "idempotent";
  throw new Error("OFFICIAL_SIGNAL_IMMUTABLE_CONFLICT");
}
