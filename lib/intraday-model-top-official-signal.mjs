import { createHash } from "node:crypto";
import { calculateTechnicalStrength } from "./technical-strength.mjs";
import { calculateTechnicalModelFeatures } from "./technical-model-features.mjs";
import { calculateTrendStrength } from "./trend-strength.mjs";
import { calculateEntryStrength } from "./entry-strength.mjs";
import { calculateCombinedTechnicalScore } from "./combined-technical-score.mjs";
import { mergeProvisionalCandle } from "./intraday-model-b-official-signal.mjs";
import { OFFICIAL_SIGNAL_TIME, OFFICIAL_SIGNAL_WINDOW_END, CURRENT_LIVE_PROFILE, intradaySignalProfile } from "./intraday-model-top-time-policy.mjs";

export const INTRADAY_MODEL_TOP_SIGNAL_VERSION = CURRENT_LIVE_PROFILE.signalVersion;
export { OFFICIAL_SIGNAL_TIME, OFFICIAL_SIGNAL_WINDOW_END } from "./intraday-model-top-time-policy.mjs";
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
const observationId = ({ signalDate, ticker, modelVersion }) => hashIntradayModelTop({ signalDate, signalTime: OFFICIAL_SIGNAL_TIME, observationPolicyId: CURRENT_LIVE_PROFILE.policyId, ticker, modelVersion });

export function validateIntradaySeedAvailability(seed, signalDate) {
  const source = seed?.sourceManifest?.sources?.officialDailyPrice;
  const receipt = source?.availability;
  const cutoff = Date.parse(`${signalDate}T${OFFICIAL_SIGNAL_TIME}+09:00`);
  const generated = Date.parse(seed?.generatedAt), observed = Date.parse(receipt?.observedAt), requested = Date.parse(receipt?.requestedAt);
  if (![cutoff, generated, observed, requested].every(Number.isFinite) || requested > observed || observed > generated || generated > cutoff
    || receipt?.availabilityStatus !== "OBSERVED" || receipt?.availabilityEvidence !== "SYSTEM_OBSERVED_BATCH_COLLECTION" || receipt?.outcome !== "success"
    || receipt?.referenceDate !== seed?.requestedDate || !/^[a-f0-9]{64}$/u.test(source?.normalizedInputHash ?? "")
    || receipt?.normalizedInputHash !== source.normalizedInputHash) return ["SEED_AVAILABILITY_UNVERIFIED"];
  return [];
}

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
  if (!Number.isFinite(quote.rate)) return "quoteRateMissing";
  return null;
}

export function calculateIntradayModelTopScores(rows, quote) {
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

export function buildIntradayModelTopSignal({ seed, quotesByCode, signalDate, collectionStartedAt, collectionCompletedAt, source = "KIS", observationType = "LIVE_OBSERVATION", inputProvenance = null }) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(signalDate)) throw new Error("SIGNAL_DATE_INVALID");
  if (!["LIVE_OBSERVATION", "TEST_FIXTURE"].includes(observationType)) throw new Error("OBSERVATION_TYPE_INVALID");
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(seed?.requestedDate ?? "") || seed.requestedDate >= signalDate) throw new Error("SEED_NOT_STRICTLY_PRIOR_TO_SIGNAL");
  const seedErrors = validateIntradaySeedAvailability(seed, signalDate);
  if (seedErrors.length) throw new Error(seedErrors[0]);
  const pinnedInputs = inputProvenance === null ? null : {
    inputCommit: inputProvenance.inputCommit, seedHash: inputProvenance.seedHash,
    calendarHash: inputProvenance.calendarHash, refreshedAt: inputProvenance.refreshedAt, readyAt: inputProvenance.readyAt,
  };
  if (pinnedInputs && (!/^[a-f0-9]{40}$/u.test(pinnedInputs.inputCommit ?? "") || pinnedInputs.seedHash !== seed.contentHash
    || !/^[a-f0-9]{64}$/u.test(pinnedInputs.seedHash ?? "") || !/^[a-f0-9]{64}$/u.test(pinnedInputs.calendarHash ?? "")
    || ![pinnedInputs.refreshedAt, pinnedInputs.readyAt].every(value => typeof value === "string" && Number.isFinite(Date.parse(value)))
    || Date.parse(pinnedInputs.refreshedAt) > Date.parse(pinnedInputs.readyAt)
    || Date.parse(pinnedInputs.readyAt) > Date.parse(`${signalDate}T${OFFICIAL_SIGNAL_TIME}+09:00`))) throw new Error("PINNED_INPUT_PROVENANCE_INVALID");
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
    const calculated = calculateIntradayModelTopScores(rows, quote);
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
    schemaVersion: CURRENT_LIVE_PROFILE.schemaVersion,
    observationPolicyId: CURRENT_LIVE_PROFILE.policyId,
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
    source: { provider: source, inputProvenance: pinnedInputs, seedAvailableAt: seed.generatedAt, seedObservedAt: seed.sourceManifest.sources.officialDailyPrice.availability.observedAt, seedAvailabilityEvidence: "SYSTEM_OBSERVED_BATCH_COLLECTION", seedHash: seed.contentHash, seedOfficialDailyHash: seed.sourceManifest?.sources?.officialDailyPrice?.normalizedInputHash ?? null, quoteTimestampSemantics: "KIS inquire-time-itemchartprice stck_bsop_date + stck_cntg_hour, not a client-estimated timestamp", receivedTimestampSemantics: "serverReceivedAt" },
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
  const profile = intradaySignalProfile(signal);
  if (!profile || signal?.artifactType !== "intradayModelTopOfficialSignal") errors.push("schema");
  if (!["LIVE_OBSERVATION", "TEST_FIXTURE"].includes(signal?.observationType)) errors.push("observationType");
  const date = signal?.signalDate;
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(date) || !Number.isFinite(Date.parse(`${date}T00:00:00Z`))
    || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) errors.push("signalTime");
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(signal?.seedReferenceDate ?? "") || signal.seedReferenceDate >= date) errors.push("lookAheadSeed");
  const records = signal?.records;
  if (!Array.isArray(records) || records.some(record => !record || typeof record.ticker !== "string")
    || new Set(records?.map?.((record) => record?.ticker)).size !== records?.length) errors.push("records");
  // The original archive contract is retained. It is not upgraded to current evidence.
  if (profile === CURRENT_LIVE_PROFILE) {
    const from = Date.parse(`${date}T${profile.signalTime}+09:00`), to = Date.parse(`${date}T${profile.windowEnd}+09:00`);
    const start = Date.parse(signal.collectionStartedAt), end = Date.parse(signal.collectionCompletedAt);
    if (signal.timezone !== "Asia/Seoul" || signal.observationWindow?.startsAt !== profile.signalTime || signal.observationWindow?.endsAt !== profile.windowEnd
      || ![from, to, start, end].every(Number.isFinite) || start < from || end < start || end > to) errors.push("collectionWindow");
    const seedAvailable = Date.parse(signal.source?.seedAvailableAt), seedObserved = Date.parse(signal.source?.seedObservedAt);
    if (![seedAvailable, seedObserved].every(Number.isFinite) || seedObserved > seedAvailable || seedAvailable > from
      || signal.source?.seedAvailabilityEvidence !== "SYSTEM_OBSERVED_BATCH_COLLECTION"
      || !/^[a-f0-9]{64}$/u.test(signal.source?.seedOfficialDailyHash ?? "")) errors.push("seedAvailability");
    if (signal.observationType === "LIVE_OBSERVATION") {
      if (signal.source?.provider !== "KIS" || !/^[a-f0-9]{64}$/u.test(signal.source?.seedHash ?? "")) errors.push("sourceIdentity");
      if (Object.keys(MODEL_SPECS).some(model => {
        const actual = signal.modelDefinitions?.[model], expected = MODEL_SPECS[model];
        return !actual || actual.modelVersion !== expected.modelVersion || actual.scoreField !== expected.scoreField
          || actual.name !== expected.name || !/^[a-f0-9]{64}$/u.test(actual.formulaHash ?? "");
      })) errors.push("modelIdentity");
    }
    const pinned = signal.source?.inputProvenance;
    if (pinned != null && (Object.keys(pinned).sort().join(",") !== "calendarHash,inputCommit,readyAt,refreshedAt,seedHash"
      || !/^[a-f0-9]{40}$/u.test(pinned.inputCommit ?? "") || pinned.seedHash !== signal.source?.seedHash
      || !/^[a-f0-9]{64}$/u.test(pinned.seedHash ?? "") || !/^[a-f0-9]{64}$/u.test(pinned.calendarHash ?? "")
      || ![pinned.refreshedAt, pinned.readyAt].every(value => typeof value === "string" && Number.isFinite(Date.parse(value)))
      || Date.parse(pinned.refreshedAt) > Date.parse(pinned.readyAt) || Date.parse(pinned.readyAt) > from)) errors.push("inputProvenance");
    if (Array.isArray(records)) {
      const available = records.filter(row => row?.dataStatus === "AVAILABLE"), missing = records.filter(row => row?.dataStatus === "MISSING"), excluded = records.filter(row => row?.dataStatus === "INELIGIBLE");
      if (available.length + missing.length + excluded.length !== records.length || signal.collection?.successful !== available.length
        || signal.collection?.failed !== missing.length || signal.collection?.ineligible !== excluded.length || signal.universe?.sourceCount !== records.length
        || signal.universe?.eligibleCount !== available.length + missing.length || signal.universe?.eligibleHash !== hashIntradayModelTop(records.filter(row => row?.dataStatus !== "INELIGIBLE").map(row => row.ticker).sort())
        || (signal.status === "READY" && (!available.length || missing.length)) || !["READY", "FAILED_COLLECTION"].includes(signal.status)) errors.push("collectionCounts");
      for (const row of records) {
        if (Object.keys(MODEL_SPECS).some(model => row?.observationIds?.[MODEL_SPECS[model].modelVersion] !== observationId({ signalDate: date, ticker: row?.ticker, modelVersion: MODEL_SPECS[model].modelVersion }))) errors.push("observationIdentity");
      }
      for (const { modelVersion } of Object.values(MODEL_SPECS)) {
        const ranked = available.filter(row => Number.isFinite(row.scores?.[modelVersion])).sort((a, b) => b.scores[modelVersion] - a.scores[modelVersion] || a.ticker.localeCompare(b.ticker));
        if (ranked.length !== available.length || ranked.some((row, index) => row.ranks?.[modelVersion] !== index + 1)
          || signal.rankingUniverse?.[modelVersion]?.count !== ranked.length
          || signal.rankingUniverse?.[modelVersion]?.codesHash !== hashIntradayModelTop(ranked.map(row => row.ticker).sort())) errors.push("rankingIdentity");
      }
      for (const row of available) {
        const quote = row.quote, observed = Date.parse(`${quote?.asOfDate}T${quote?.asOfTime}+09:00`), received = Date.parse(quote?.receivedAt);
        if (!/^[0-9A-Z]{6}$/u.test(row.ticker) || quote?.asOfDate !== date || !/^\d{2}:\d{2}:\d{2}$/u.test(quote?.asOfTime ?? "")
          || ![observed, received].every(Number.isFinite) || observed < from || observed > to || received < observed || received < start || received > end) errors.push("quoteWindow");
        const candle = row.provisionalOhlcv;
        if (!candle || ![candle.open, candle.high, candle.low, candle.close].every(value => Number.isFinite(value) && value > 0)
          || !Number.isFinite(candle.volume) || candle.volume < 0 || !Number.isFinite(candle.change) || !Number.isFinite(candle.rate)
          || candle.high < Math.max(candle.open, candle.close) || candle.low > Math.min(candle.open, candle.close)
          || Object.values(row.scores ?? {}).some(value => !Number.isFinite(value))) errors.push("nonfiniteValues");
      }
    }
  }
  const { contentHash, ...base } = signal ?? {};
  if (contentHash !== hashIntradayModelTop(base)) errors.push("contentHash");
  return [...new Set(errors)];
}

export function isCurrentIntradayModelTopSignal(signal) {
  return intradaySignalProfile(signal) === CURRENT_LIVE_PROFILE && validateIntradayModelTopSignal(signal).length === 0;
}

export function assertImmutableIntradayModelTopSignal(existing, candidate) {
  if (!existing) return "create";
  if (existing.contentHash === candidate.contentHash) return "idempotent";
  throw new Error("OFFICIAL_SIGNAL_IMMUTABLE_CONFLICT");
}
