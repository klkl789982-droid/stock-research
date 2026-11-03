import { createKisEodPrivateStore } from "./kis-eod-private-store.mjs";
import { readLatestPublication, validateLiveDelivery } from "./private-live-delivery.mjs";
import { readTodayExecution } from "./private-live-execution-status.mjs";
import { hashIntradayModelTop as hash, MODEL_SPECS, validateIntradaySeedAvailability } from "./intraday-model-top-official-signal.mjs";
import { validateIntradayMarketSeed } from "./intraday-market-seed.mjs";
import { requiredRowIssues } from "./live-observation-contract.mjs";
import { transitionReplayKey, verifyTransitionReplay } from "./live-transition-replay.mjs";
import { FORMULA_HASHES } from "../infra/cloudflare-live-kis-diagnostic/formula-manifest.mjs";

const files = { A: "technical-strength", B: "trend-strength", C: "entry-strength", D: "combined-technical-score" };
const invalid = () => { throw new Error("LIVE_SOURCE_MISMATCH"); };
const digest = value => /^[a-f0-9]{64}$/u.test(value ?? "");
const equal = (a, b) => hash(a) === hash(b);

// Only a verified private publication head can select this immutable evidence.
// The compact delivery contains five records per model. It cannot establish ranks below five.
export function projectCurrentLiveUniverse({ delivery, publicationTimes }, evidence, seed, now = new Date().toISOString(), replayInputs) {
  validateLiveDelivery(delivery, now);
  if (!evidence || !seed) throw new Error("LIVE_SOURCE_MISSING");
  const { contentHash, ...body } = evidence;
  const p = evidence.prepared, date = delivery.signalDate, ref = delivery.models[0].seedReferenceDate;
  if (contentHash !== delivery.sourceHash || hash(body) !== contentHash || evidence.namespace !== "cloud-live-score-evidence-v1"
    || evidence.observationPolicyId !== delivery.observationPolicyId || evidence.observationType !== delivery.observationType
    || evidence.sourcePricesIncluded !== false || evidence.signalDate !== date || p?.targetDate !== date || p.readiness !== "READY"
    || p.formulaHashesVerified !== true || !/^[a-f0-9]{40}$/u.test(p.inputCommit) || !digest(p.seedHash)
    || p.seedReferenceDate !== ref || seed.requestedDate !== ref || seed.contentHash !== p.seedHash
    || !Number.isSafeInteger(p.universe) || p.universe !== 553 || validateIntradayMarketSeed(seed, p.universe).length
    || validateIntradaySeedAvailability(seed, date).length) invalid();
  const codes = seed.records.map(row => row.code), eligible = seed.records.filter(row => row.eligible).map(row => row.code);
  if (!equal(codes, p.codes) || !equal(eligible, p.eligibleCodes) || p.eligible !== eligible.length || !Array.isArray(evidence.observations)) invalid();
  const missing = new Map(delivery.publication?.missing.map(row => [row.ticker, row.reason]) ?? []);
  const universeHash = hash({ targetDate: date, seedReferenceDate: ref, seedHash: seed.contentHash, codes, eligibleCodes: eligible });
  if (delivery.publication) {
    const { revision, firstIssuedAt, previousDeliveryHash, ...coverage } = delivery.publication;
    void revision; void firstIssuedAt; void previousDeliveryHash;
    if (!equal(coverage, evidence.coverage) || coverage.universeHash !== universeHash || coverage.targetCount !== eligible.length) invalid();
  } else if (evidence.coverage || evidence.observations.length !== codes.length) invalid();
  const byCode = new Map(evidence.observations.map(row => [row.code, row]));
  const pinned = new Set(codes), eligibleSet = new Set(eligible);
  if (byCode.size !== evidence.observations.length || [...byCode.keys()].some(code => !pinned.has(code))
    || [...missing.keys()].some(code => !eligibleSet.has(code))) invalid();
  const available = [];
  const hasReplay = Object.hasOwn(evidence, "transitionReplayHash");
  if (hasReplay !== (p.transitionReplayVersion === 1) || hasReplay && !digest(evidence.transitionReplayHash)
    || (p.transitionReplayVersion !== undefined && p.transitionReplayVersion !== 1)) invalid();
  const replayed = replayInputs === undefined ? null : verifyTransitionReplay(replayInputs, evidence, seed);
  const records = seed.records.map(input => {
    const row = byCode.get(input.code);
    const base = { code: input.code, name: input.name, market: input.market, eligible: input.eligible, models: {} };
    if (!input.eligible || missing.has(input.code)) {
      if (row && (delivery.publication || input.eligible || row.status !== "EXCLUDED")) invalid();
      return { ...base, reason: missing.get(input.code) ?? "PINNED_EOD_INELIGIBLE" };
    }
    if (!row || row.companyName !== input.name || row.reason || requiredRowIssues(row, date).length) invalid();
    const result = { ...base, observedDate: row.observedDate, observedTime: row.observedTime, receivedAt: row.quoteReceivedAt,
      observationHash: row.originalRecordHash, transitionV1: hasReplay ? replayed?.get(row.code) ?? null : row.transitionV1 ?? null };
    available.push({ row, result });
    return result;
  });
  const started = new Date(Math.min(...available.map(({row}) => Date.parse(row.quoteRequestedAt)))).toISOString();
  const completed = new Date(Math.max(...available.map(({row}) => Date.parse(row.minuteReceivedAt)))).toISOString();
  if (started !== evidence.collectionStartedAt || completed !== evidence.collectionCompletedAt
    || started !== delivery.models[0].collectionStartedAt || completed !== delivery.models[0].collectionCompletedAt) invalid();
  const modelDefinitions = {};
  for (const model of delivery.models) {
    const version = model.modelVersion, spec = MODEL_SPECS[model.model], formulaHash = seed.sourceManifest.modelFormulaHashes?.[version];
    if (version !== spec.modelVersion || !digest(formulaHash) || formulaHash !== FORMULA_HASHES[`lib/${files[model.model]}.mjs`]) invalid();
    modelDefinitions[model.model] = { ...spec, formulaHash };
    const ranked = [...available].sort((a, b) => b.row.scores[version] - a.row.scores[version] || a.row.code.localeCompare(b.row.code));
    ranked.forEach(({row, result}, index) => { result.models[version] = { score: row.scores[version], rank: index + 1 }; });
    const top = ranked.slice(0, 5).map(({result}) => ({ ticker: result.code, companyName: result.name, ...result.models[version] }));
    if (!equal(top, model.records)) invalid();
  }
  return { observationPolicyId: delivery.observationPolicyId, observationType: delivery.observationType, signalDate: date, seedReferenceDate: ref,
    officialSignalTime: "14:00:00", collectionStartedAt: started, collectionCompletedAt: completed,
    sourceHash: contentHash, deliveryHash: delivery.deliveryHash, seedHash: seed.contentHash,
    normalizedInputHash: seed.sourceManifest.sources.officialDailyPrice.normalizedInputHash,
    modelDefinitions, revision: delivery.publication?.revision ?? null, publicationStatus: delivery.publication?.status ?? "COMPLETE",
    publishedAt: publicationTimes?.publishedAt ?? null, exportedAt: delivery.exportedAt,
    coverage: { status: delivery.publication?.status ?? "COMPLETE", universeHash, targetCount: eligible.length, validCount: available.length, missing: Array.from(missing, ([ticker, reason]) => ({ ticker, reason })) },
    transitionInputsRetained: hasReplay, transitionReplayed: Boolean(replayed),
    records, sourceQualityGrade: seed.dataQuality?.overallGrade ?? "UNKNOWN" };
}

async function pinnedSeed(prepared) {
  if (!/^[a-f0-9]{40}$/u.test(prepared?.inputCommit ?? "") || !/^\d{4}-\d{2}-\d{2}$/u.test(prepared?.seedReferenceDate ?? "")) invalid();
  // Same immutable Git input as the collector. No private credentials are sent to the public raw host.
  const response = await fetch(`https://raw.githubusercontent.com/klkl789982-droid/stock-research/${prepared.inputCommit}/data/analysis/market-seeds/${prepared.seedReferenceDate}.json`,
    { cache: "no-store", redirect: "error", signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error("LIVE_SEED_MISSING");
  return response.json();
}

export function checkCurrentLiveRelease(selected, execution) {
  const record = execution?.record;
  if (record?.status === "GLOBAL_BLOCKED") throw new Error("LIVE_GLOBAL_BLOCKED");
  if (record?.coverage?.status !== "WITHHELD") return;
  const delivery = selected?.delivery;
  if (delivery?.signalDate === record.signalDate && delivery.publication?.universeHash === record.coverage.universeHash
    && Date.parse(selected.publicationTimes?.publishedAt) >= Date.parse(record.recordedAt)) return;
  throw Object.assign(new Error("LIVE_PUBLICATION_WITHHELD"), {coverage:record.coverage, signalDate:record.signalDate});
}

export function createCurrentLiveReader({ store, readSeed = pinnedSeed }) {
  const cached = new Map();
  const inFlight = new Map();
  const pendingHeads = new Map();
  return async ({ signalDate = null, now = new Date().toISOString(), replayTransitions = false } = {}) => {
    const today = new Date(Date.parse(now) + 9 * 3600000).toISOString().slice(0,10);
    const key = signalDate ?? today + ":latest";
    const heads = pendingHeads.get(key) ?? Promise.all([readLatestPublication(store, { signalDate, now }),
      signalDate && signalDate !== today ? null : readTodayExecution(store,{now})]);
    pendingHeads.set(key,heads);
    let selected;
    try { const [publication,execution] = await heads; checkCurrentLiveRelease(publication,execution); selected = publication; }
    finally { if (pendingHeads.get(key) === heads) pendingHeads.delete(key); }
    if (!selected) throw new Error("LIVE_SNAPSHOT_MISSING");
    const { sourceHash, deliveryHash, signalDate: date } = selected.delivery;
    const previous = cached.get(replayTransitions);
    if (previous?.deliveryHash === deliveryHash) return previous;
    const cacheKey = deliveryHash + "/" + replayTransitions;
    if (inFlight.has(cacheKey)) return inFlight.get(cacheKey);
    const loading = (async () => {
      const evidence = (await store.read(`cloud-live-score-evidence-v1/${date}/${sourceHash}.json`))?.value;
      if (!evidence) throw new Error("LIVE_SOURCE_MISSING");
      const shouldReplay = replayTransitions && Object.hasOwn(evidence, "transitionReplayHash");
      if (shouldReplay && !digest(evidence.transitionReplayHash)) invalid();
      const [seed, inputs] = await Promise.all([readSeed(evidence.prepared),
        shouldReplay ? store.read(transitionReplayKey(date, evidence.transitionReplayHash)) : null]);
      if (shouldReplay && !inputs?.value) throw new Error("LIVE_TRANSITION_REPLAY_UNAVAILABLE");
      const result = projectCurrentLiveUniverse(selected, evidence, seed, now, shouldReplay ? inputs.value : undefined);
      cached.set(replayTransitions, result);
      return result;
    })();
    inFlight.set(cacheKey, loading);
    try { return await loading; } finally { inFlight.delete(cacheKey); }
  };
}

let liveReader;
export async function loadCurrentLiveUniverse(options = {}) {
  if (process.env.PRIVATE_LIVE_DELIVERY_READ_ENABLED !== "true" || process.env.PRIVATE_LIVE_DELIVERY_FIXTURE_ID) throw new Error("LIVE_SOURCE_MISSING");
  liveReader ??= createCurrentLiveReader({ store: createKisEodPrivateStore({ repository: process.env.PRIVATE_LIVE_DELIVERY_REPOSITORY, token: process.env.PRIVATE_LIVE_DELIVERY_READ_TOKEN }) });
  return liveReader(options);
}
