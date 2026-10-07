import { createHash } from "node:crypto";
import { calculateTechnicalStrength } from "./technical-strength.mjs";
import { calculateTechnicalModelFeatures } from "./technical-model-features.mjs";
import { calculateTrendStrength } from "./trend-strength.mjs";
import { calculateEntryStrength } from "./entry-strength.mjs";
import { calculateCombinedTechnicalScore } from "./combined-technical-score.mjs";
import { mergeProvisionalCandle } from "./intraday-model-b-official-signal.mjs";

export const INTRADAY_MODEL_TOP_SIGNAL_VERSION = "intraday-model-top-official-signal-v1";
export const OFFICIAL_SIGNAL_TIME = "14:30:00";
export const OFFICIAL_SIGNAL_WINDOW_END = "14:35:00";
export const MODEL_SPECS = Object.freeze({
  A: { modelVersion: "A-v1", scoreField: "finalTechnicalScore", name: "technicalStrength" },
  B: { modelVersion: "B-v1", scoreField: "trendStrength", name: "trendStrength" },
  C: { modelVersion: "C-v1", scoreField: "entryStrength", name: "entryStrength" },
  D: { modelVersion: "D-v1", scoreField: null, name: "combinedTechnicalScore" },
});

const canonical = (value) => Array.isArray(value)
  ? value.map(canonical)
  : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
    : value;
export const hashIntradayModelTop = (value) => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
const observationId = ({ signalDate, ticker, modelVersion }) => hashIntradayModelTop({ signalDate, signalTime: OFFICIAL_SIGNAL_TIME, ticker, modelVersion });

function quoteFailure(quote, signalDate) {
  if (!quote) return "quoteMissing";
  if (quote.asOfDate !== signalDate) return "quoteDateMismatch";
  if (!quote.asOfTime) return "quoteTimeMissing";
  if (quote.asOfTime < OFFICIAL_SIGNAL_TIME || quote.asOfTime > OFFICIAL_SIGNAL_WINDOW_END) return "quoteOutsideSignalWindow";
  const quoteTimestamp = Date.parse(`${quote.asOfDate}T${quote.asOfTime}+09:00`);
  const receivedTimestamp = Date.parse(quote.receivedAt);
  if (!Number.isFinite(quoteTimestamp) || !Number.isFinite(receivedTimestamp)) return "quoteTimestampInvalid";
  if (receivedTimestamp < quoteTimestamp) return "quoteFromFuture";
  if (!mergeProvisionalCandle([["20000101", 1, 1, 1, 1, 1]], quote)) return "invalidQuoteOhlcv";
  if (!Number.isFinite(Number(quote.rate))) return "quoteRateMissing";
  return null;
}

function calculateModels(rows, quote) {
  const modelA = calculateTechnicalStrength(rows, null);
  const features = calculateTechnicalModelFeatures(rows, quote);
  const modelB = calculateTrendStrength(features);
  const modelC = calculateEntryStrength(features);
  const modelD = calculateCombinedTechnicalScore(modelB.trendStrength, modelC.entryStrength);
  return {
    scores: {
      "A-v1": modelA.finalTechnicalScore,
      "B-v1": modelB.trendStrength,
      "C-v1": modelC.entryStrength,
      "D-v1": modelD,
    },
    indicators: features,
    modelDetails: { "A-v1": modelA, "B-v1": modelB, "C-v1": modelC, "D-v1": { combinedTechnicalScore: modelD } },
  };
}

const emptyValues = () => Object.fromEntries(Object.values(MODEL_SPECS).map(({ modelVersion }) => [modelVersion, null]));
const idsFor = (signalDate, ticker) => Object.fromEntries(Object.values(MODEL_SPECS).map(({ modelVersion }) => [modelVersion, observationId({ signalDate, ticker, modelVersion })]));

export function buildIntradayModelTopSignal({ seed, quotesByCode, signalDate, collectionStartedAt, collectionCompletedAt, source = "KIS", observationType = "LIVE_OBSERVATION" }) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(signalDate)) throw new Error("SIGNAL_DATE_INVALID");
  if (!["LIVE_OBSERVATION", "TEST_FIXTURE"].includes(observationType)) throw new Error("OBSERVATION_TYPE_INVALID");
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(seed?.requestedDate ?? "") || seed.requestedDate >= signalDate) throw new Error("SEED_NOT_STRICTLY_PRIOR_TO_SIGNAL");
  const formulaHashes = seed.sourceManifest?.modelFormulaHashes ?? {};
  for (const { modelVersion } of Object.values(MODEL_SPECS)) if (typeof formulaHashes[modelVersion] !== "string") throw new Error(`FORMULA_HASH_MISSING:${modelVersion}`);

  const records = [];
  for (const item of seed.records) {
    const base = { ticker: item.code, companyName: item.name, market: item.market ?? null };
    if (!item.eligible) {
      records.push({ ...base, dataStatus: "INELIGIBLE", reason: item.ineligibleReasons ?? ["seedIneligible"], quote: null, provisionalOhlcv: null, scores: emptyValues(), ranks: emptyValues(), observationIds: idsFor(signalDate, item.code) });
      continue;
    }
    const quote = quotesByCode.get(item.code) ?? null;
    const failure = quoteFailure(quote, signalDate);
    if (failure) {
      records.push({ ...base, dataStatus: "MISSING", reason: failure, quote: quote ? { asOfDate: quote.asOfDate ?? null, asOfTime: quote.asOfTime ?? null, receivedAt: quote.receivedAt ?? null } : null, provisionalOhlcv: null, scores: emptyValues(), ranks: emptyValues(), observationIds: idsFor(signalDate, item.code) });
      continue;
    }
    const rows = mergeProvisionalCandle(item.rows, quote);
    const calculated = calculateModels(rows, quote);
    records.push({
      ...base,
      dataStatus: "AVAILABLE",
      reason: null,
      quote: { source: quote.source ?? source, priceBasis: quote.priceBasis ?? "lastQuotedPrice", asOfDate: quote.asOfDate, asOfTime: quote.asOfTime, receivedAt: quote.receivedAt },
      provisionalOhlcv: { open: Number(quote.open), high: Number(quote.high), low: Number(quote.low), close: Number(quote.price), volume: Number(quote.volume), change: Number(quote.change), rate: Number(quote.rate) },
      scores: calculated.scores,
      ranks: emptyValues(),
      observationIds: idsFor(signalDate, item.code),
      indicators: calculated.indicators,
      modelDetails: calculated.modelDetails,
    });
  }

  const top5 = {};
  const rankingUniverse = {};
  for (const { modelVersion } of Object.values(MODEL_SPECS)) {
    const ranked = records
      .filter((record) => record.dataStatus === "AVAILABLE" && Number.isFinite(record.scores[modelVersion]))
      .sort((left, right) => right.scores[modelVersion] - left.scores[modelVersion] || left.ticker.localeCompare(right.ticker));
    ranked.forEach((record, index) => { record.ranks[modelVersion] = index + 1; });
    rankingUniverse[modelVersion] = { count: ranked.length, codesHash: hashIntradayModelTop(ranked.map((record) => record.ticker).sort()), tieBreak: "scoreDescThenTickerAsc" };
    top5[modelVersion] = ranked.slice(0, 5).map((record) => ({ rank: record.ranks[modelVersion], ticker: record.ticker, companyName: record.companyName, score: record.scores[modelVersion], observationId: record.observationIds[modelVersion] }));
  }

  const eligibleCount = seed.records.filter((item) => item.eligible).length;
  const availableCount = records.filter((record) => record.dataStatus === "AVAILABLE").length;
  const base = {
    schemaVersion: 1,
    artifactType: "intradayModelTopOfficialSignal",
    signalVersion: INTRADAY_MODEL_TOP_SIGNAL_VERSION,
    signalDate,
    officialSignalTime: OFFICIAL_SIGNAL_TIME,
    timezone: "Asia/Seoul",
    observationWindow: { startsAt: OFFICIAL_SIGNAL_TIME, endsAt: OFFICIAL_SIGNAL_WINDOW_END },
    collectionStartedAt,
    collectionCompletedAt,
    immutable: true,
    observationType,
    calculationBasis: "priorOfficialDailyHistoryPlusSameDayKisProvisionalCandle",
    priceBasis: "kisLastQuoteAtCollection",
    seedReferenceDate: seed.requestedDate,
    modelDefinitions: Object.fromEntries(Object.entries(MODEL_SPECS).map(([model, spec]) => [model, { ...spec, formulaHash: formulaHashes[spec.modelVersion] }])),
    universe: { sourceCount: seed.records.length, eligibleCount, eligibleHash: hashIntradayModelTop(seed.records.filter((item) => item.eligible).map((item) => item.code).sort()), policy: "intradaySeedEligibleCommonUniverse" },
    rankingUniverse,
    source: { provider: source, seedHash: seed.contentHash, seedOfficialDailyHash: seed.sourceManifest?.sources?.officialDailyPrice?.normalizedInputHash ?? null, quoteTimestampSemantics: "KIS stck_bsop_date + stck_cntg_hour", receivedTimestampSemantics: "serverReceivedAt" },
    collection: { successful: availableCount, failed: records.filter((record) => record.dataStatus === "MISSING").length, ineligible: records.filter((record) => record.dataStatus === "INELIGIBLE").length },
    quality: { exactSignalDateRequired: true, signalWindowRequired: true, perQuoteTimestampPreserved: true, noEstimatedInputs: true },
    outcomeTracking: { status: "PENDING", horizons: ["1D", "5D", "20D", "60D"], joinKey: "observationId", outcomesStoredSeparately: true },
    status: availableCount === eligibleCount ? "READY" : "FAILED_COLLECTION",
    top5,
    records: [...records].sort((left, right) => left.ticker.localeCompare(right.ticker)),
  };
  return { ...base, contentHash: hashIntradayModelTop(base) };
}

export function validateIntradayModelTopSignal(signal) {
  const errors = [];
  if (signal?.schemaVersion !== 1 || signal?.artifactType !== "intradayModelTopOfficialSignal" || signal?.signalVersion !== INTRADAY_MODEL_TOP_SIGNAL_VERSION) errors.push("schema");
  if (!["LIVE_OBSERVATION", "TEST_FIXTURE"].includes(signal?.observationType)) errors.push("observationType");
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(signal?.signalDate ?? "") || signal?.officialSignalTime !== OFFICIAL_SIGNAL_TIME) errors.push("signalTime");
  if (signal?.seedReferenceDate >= signal?.signalDate) errors.push("lookAheadSeed");
  if (!Array.isArray(signal?.records) || new Set(signal?.records?.map((record) => record.ticker)).size !== signal?.records?.length) errors.push("records");
  const { contentHash, ...base } = signal ?? {};
  if (contentHash !== hashIntradayModelTop(base)) errors.push("contentHash");
  return [...new Set(errors)];
}

export function assertImmutableIntradayModelTopSignal(existing, candidate) {
  if (!existing) return "create";
  if (existing.contentHash === candidate.contentHash) return "idempotent";
  throw new Error("OFFICIAL_SIGNAL_IMMUTABLE_CONFLICT");
}
