import { sha256Canonical } from "./snapshot-quality-pipeline.mjs";
import { validateIntradayMarketSeed } from "./intraday-market-seed.mjs";
import { KIS_EOD_OBSERVATION_SLOTS, KIS_EOD_OBSERVATION_TICKERS } from "./kis-eod-observation.mjs";

export const KIS_EOD_OBSERVATION_COMPARISON_NAMESPACE = "kis-eod-private-official-comparison";
export const KIS_EOD_COMPARISON_FIELDS = Object.freeze(["mkp", "hipr", "lopr", "clpr", "trqu", "trPrc"]);
const hashPattern = /^[a-f0-9]{64}$/u;
const finite = (value) => typeof value === "number" && Number.isFinite(value);
const fail = (reason) => { throw new Error(reason); };
const validDate = (value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(value)
  && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const validStamp = (value) => typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

function observationValid(artifact) {
  const { artifactHash, ...body } = artifact ?? {};
  if (artifact?.schemaVersion !== 1 || artifact.namespace !== "kis-eod-private-slot-observation"
    || !validDate(artifact.referenceDate) || !KIS_EOD_OBSERVATION_SLOTS.includes(artifact.slot)
    || !Array.isArray(artifact.observations) || !hashPattern.test(artifactHash ?? "") || sha256Canonical(body) !== artifactHash
    || artifact.sourceFinality !== "NOT_CONFIRMED" || artifact.publicationEligible !== false || artifact.productionChanged !== false
    || artifact.observationType !== "ACTUAL_CLOCK_SLOT_COLLECTION" || !["OBSERVED", "PARTIAL", "FAILED", "PENDING"].includes(artifact.status)
    || !validStamp(artifact.completedAt)) fail("KIS_EOD_COMPARISON_OBSERVATION_INVALID");
  const tickers = artifact.observations.map((entry) => entry?.ticker);
  if (new Set(tickers).size !== tickers.length || tickers.some((ticker) => !KIS_EOD_OBSERVATION_TICKERS.includes(ticker))) fail("KIS_EOD_COMPARISON_OBSERVATION_INVALID");
  for (const entry of artifact.observations.filter((value) => value.status === "SUCCESS")) {
    if (!Array.isArray(entry.rows) || !Array.isArray(entry.adjustmentMetadata) || !Array.isArray(entry.dailyChangeMetadata)
      || entry.dataHash !== sha256Canonical({ rows: entry.rows, adjustmentMetadata: entry.adjustmentMetadata, dailyChangeMetadata: entry.dailyChangeMetadata })
      || entry.metadataHash !== sha256Canonical(entry.metadata) || entry.metadata?.ticker !== entry.ticker
      || entry.metadata.referenceDate !== artifact.referenceDate || entry.metadata.adjustment !== "unadjusted"
      || entry.metadata.priceBasis !== "kisDailyBarUnadjusted") fail("KIS_EOD_COMPARISON_OBSERVATION_INVALID");
    const rows = entry.rows.filter((row) => row.basDt === artifact.referenceDate.replaceAll("-", ""));
    if (rows.length !== 1 || rows[0].srtnCd !== entry.ticker
      || !KIS_EOD_COMPARISON_FIELDS.slice(0, 5).every((key) => finite(rows[0][key]) && rows[0][key] >= 0)
      || rows[0].clpr <= 0 || !Number.isSafeInteger(rows[0].trqu)
      || (rows[0].trPrc !== null && (!finite(rows[0].trPrc) || rows[0].trPrc < 0))) fail("KIS_EOD_COMPARISON_OBSERVATION_INVALID");
    if (new Set(entry.rows.map((row) => row.basDt)).size !== entry.rows.length
      || entry.rows.some((row) => !validDate(`${row.basDt?.slice(0, 4)}-${row.basDt?.slice(4, 6)}-${row.basDt?.slice(6, 8)}`)
        || row.basDt > artifact.referenceDate.replaceAll("-", "") || row.srtnCd !== entry.ticker)) fail("KIS_EOD_COMPARISON_OBSERVATION_INVALID");
  }
}

// An existing official seed lacks trading value and an explicit adjustment
// contract. Keep those omissions visible rather than assuming KIS equivalence.
function officialEvidence(official, referenceDate) {
  if (official === null || official === undefined) return null;
  const isSeed = official.seedType === "intradayMarketAnalysisSeed";
  const date = official.requestedDate ?? official.referenceDate ?? official.date;
  if (!validDate(date) || date !== referenceDate) fail("KIS_EOD_COMPARISON_OFFICIAL_DATE_MISMATCH");
  if (!Array.isArray(official.records)) fail("KIS_EOD_COMPARISON_OFFICIAL_INVALID");
  if (isSeed) {
    if (validateIntradayMarketSeed(official, official.records.length).length
      || official.sourceManifest?.sources?.officialDailyPrice?.service !== "getStockPriceInfo") fail("KIS_EOD_COMPARISON_OFFICIAL_INVALID");
  } else if (official.source !== "data-go-kr-official-daily-price"
    || official.operation !== "getStockPriceInfo") fail("KIS_EOD_COMPARISON_OFFICIAL_SOURCE_UNVERIFIED");
  const codes = official.records.map((record) => record?.code);
  if (new Set(codes).size !== codes.length || codes.some((code) => typeof code !== "string" || !/^[0-9A-Z]{6}$/u.test(code))) fail("KIS_EOD_COMPARISON_OFFICIAL_INVALID");
  const sourceMetadata = isSeed ? official.sourceManifest.sources.officialDailyPrice : official;
  const adjustment = ["adjusted", "unadjusted"].includes(sourceMetadata.adjustment) ? sourceMetadata.adjustment : "UNKNOWN";
  const compactDate = referenceDate.replaceAll("-", "");
  const records = KIS_EOD_OBSERVATION_TICKERS.map((ticker) => {
    const source = official.records.find((record) => record.code === ticker);
    const rawRows = source?.rows ?? [];
    if (!Array.isArray(rawRows)) fail("KIS_EOD_COMPARISON_OFFICIAL_INVALID");
    const matching = rawRows.filter((row) => (isSeed ? row?.[0] : row?.basDt) === compactDate);
    if (matching.length > 1) fail("KIS_EOD_COMPARISON_OFFICIAL_DUPLICATE_DATE");
    if (!matching.length) return { ticker, row: null, reason: source ? "OFFICIAL_EXACT_DATE_MISSING" : "OFFICIAL_TICKER_MISSING" };
    const raw = matching[0];
    if (!isSeed && raw.srtnCd !== ticker) fail("KIS_EOD_COMPARISON_OFFICIAL_TICKER_MISMATCH");
    const row = Object.fromEntries(KIS_EOD_COMPARISON_FIELDS.map((field, index) => [field, isSeed ? raw[index + 1] ?? null : raw[field] ?? null]));
    if (Object.values(row).some((value) => value !== null && (!finite(value) || value < 0))
      || (row.trqu !== null && !Number.isSafeInteger(row.trqu))) fail("KIS_EOD_COMPARISON_OFFICIAL_NUMBER_INVALID");
    if (KIS_EOD_COMPARISON_FIELDS.slice(0, 4).every((field) => finite(row[field]))
      && (row.clpr <= 0 || row.hipr < row.lopr || (row.trqu > 0 && (row.hipr < Math.max(row.mkp, row.clpr) || row.lopr > Math.min(row.mkp, row.clpr)))))
      fail("KIS_EOD_COMPARISON_OFFICIAL_OHLCV_INVALID");
    return { ticker, row, reason: null };
  });
  const observedAt = isSeed ? sourceMetadata.availability?.observedAt ?? official.generatedAt ?? null : official.receivedAt ?? null;
  if (observedAt !== null && !validStamp(observedAt)) fail("KIS_EOD_COMPARISON_OFFICIAL_TIMESTAMP_INVALID");
  return { referenceDate, source: "data-go-kr-official-daily-price", operation: "getStockPriceInfo", representation: isSeed ? "EXISTING_OFFICIAL_MARKET_SEED" : "NORMALIZED_OFFICIAL_SOURCE_ROWS",
    sourceArtifactHash: isSeed ? official.contentHash : sha256Canonical(official), observedAt,
    adjustment, priceBasis: adjustment === "UNKNOWN" ? "UNKNOWN" : adjustment === "unadjusted" ? "officialDailyBarUnadjusted" : "officialDailyBarAdjusted",
    tradingValueStored: !isSeed, records };
}

export function kisEodObservationComparisonHash(report) {
  const { comparisonHash: omittedHash, comparedAt: omittedTime, ...body } = report;
  void omittedHash; void omittedTime;
  return sha256Canonical(body);
}

export function compareKisEodObservationWithOfficial({ observation, official = null, comparedAt = new Date().toISOString() } = {}) {
  observationValid(observation);
  if (!validStamp(comparedAt) || Date.parse(comparedAt) < Date.parse(observation.completedAt)) fail("KIS_EOD_COMPARISON_TIMESTAMP_INVALID");
  const evidence = officialEvidence(official, observation.referenceDate);
  if (evidence?.observedAt && Date.parse(evidence.observedAt) > Date.parse(comparedAt)) fail("KIS_EOD_COMPARISON_OFFICIAL_TIMESTAMP_INVALID");
  const records = KIS_EOD_OBSERVATION_TICKERS.map((ticker) => {
    const entry = observation.observations.find((value) => value.ticker === ticker && value.status === "SUCCESS");
    const raw = entry?.rows.find((row) => row.basDt === observation.referenceDate.replaceAll("-", ""));
    const saved = evidence?.records.find((record) => record.ticker === ticker);
    const fields = Object.fromEntries(KIS_EOD_COMPARISON_FIELDS.map((field) => {
      const kisValue = raw?.[field] ?? null, officialValue = saved?.row?.[field] ?? null;
      const status = !entry ? "OBSERVATION_UNAVAILABLE" : !evidence ? "OFFICIAL_PENDING" : !saved?.row ? "OFFICIAL_ROW_MISSING"
        : !finite(kisValue) ? "OBSERVATION_FIELD_MISSING" : !finite(officialValue) ? "OFFICIAL_FIELD_MISSING" : kisValue === officialValue ? "EQUAL" : "DIFFERENT";
      return [field, { status, kisValue, officialValue, difference: finite(kisValue) && finite(officialValue) ? kisValue - officialValue : null }];
    }));
    const pairCount = Object.values(fields).filter((field) => ["EQUAL", "DIFFERENT"].includes(field.status)).length;
    const changedFields = KIS_EOD_COMPARISON_FIELDS.filter((field) => fields[field].status === "DIFFERENT");
    const categories = [];
    if (!entry) categories.push("OBSERVATION_UNAVAILABLE");
    if (!evidence) categories.push("OFFICIAL_SOURCE_PENDING");
    else if (!saved?.row) categories.push(saved?.reason ?? "OFFICIAL_ROW_MISSING");
    if (evidence?.adjustment === "UNKNOWN") categories.push("ADJUSTMENT_BASIS_UNVERIFIED");
    if (evidence?.adjustment === "adjusted") categories.push("ADJUSTMENT_BASIS_DIFFERS");
    if (changedFields.some((field) => ["mkp", "hipr", "lopr", "clpr"].includes(field))) categories.push("PRICE_DIFFERENCE");
    if (changedFields.includes("trqu")) categories.push("VOLUME_DIFFERENCE");
    if (changedFields.includes("trPrc")) categories.push("TRADING_VALUE_DIFFERENCE");
    if (changedFields.length) categories.push("UPDATE_TIMING_OR_SESSION_SCOPE_REQUIRES_REVIEW");
    if (evidence && fields.trPrc.status === "OFFICIAL_FIELD_MISSING") categories.push("OFFICIAL_TRADING_VALUE_NOT_STORED");
    return { ticker, referenceDate: observation.referenceDate, status: pairCount ? "COMPARED" : "PENDING", pairCount,
      dataHash: entry?.dataHash ?? null, adjustmentBasis: { kis: entry?.metadata.adjustment ?? null, official: evidence?.adjustment ?? null,
        status: !evidence ? "PENDING" : evidence.adjustment === "UNKNOWN" ? "UNVERIFIED" : evidence.adjustment === "unadjusted" ? "ALIGNED" : "DIFFERENT" },
      fields, changedFields, possibleCauseCategories: categories, causeConfirmed: false, sourceFinality: "NOT_CONFIRMED_BY_COMPARISON" };
  });
  const base = { schemaVersion: 1, namespace: KIS_EOD_OBSERVATION_COMPARISON_NAMESPACE, referenceDate: observation.referenceDate, slot: observation.slot,
    comparedAt, status: records.some((record) => record.pairCount > 0) ? "COMPARED" : "PENDING", observationArtifactHash: observation.artifactHash,
    officialEvidenceHash: evidence ? sha256Canonical(evidence) : null, officialSource: evidence ? { referenceDate: evidence.referenceDate, source: evidence.source,
      operation: evidence.operation, representation: evidence.representation, sourceArtifactHash: evidence.sourceArtifactHash, observedAt: evidence.observedAt,
      adjustment: evidence.adjustment, priceBasis: evidence.priceBasis, tradingValueStored: evidence.tradingValueStored } : null,
    sourceFinality: "NOT_CONFIRMED_BY_COMPARISON", publicationEligible: false, productionChanged: false,
    summary: { observedCount: records.filter((record) => record.dataHash !== null).length, comparedCount: records.filter((record) => record.pairCount > 0).length,
      pendingCount: records.filter((record) => record.pairCount === 0).length, differingTickerCount: records.filter((record) => record.changedFields.length > 0).length,
      allAvailableFieldsEqualCount: records.filter((record) => record.pairCount > 0 && record.changedFields.length === 0).length,
      adjustmentBasisVerifiedCount: records.filter((record) => record.adjustmentBasis.status === "ALIGNED").length }, records };
  return { ...base, comparisonHash: kisEodObservationComparisonHash(base) };
}

export function toSafeKisEodObservationComparisonSummary(report) {
  return { namespace: report.namespace, referenceDate: report.referenceDate, slot: report.slot, status: report.status, comparisonHash: report.comparisonHash,
    observationArtifactHash: report.observationArtifactHash, officialEvidenceHash: report.officialEvidenceHash,
    sourceFinality: report.sourceFinality, publicationEligible: false, productionChanged: false, ...report.summary };
}
