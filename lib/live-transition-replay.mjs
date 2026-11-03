import { canonicalContentHash as hash } from "./canonical-content-hash.mjs";
import { freezeTransitionVerdicts, LIVE_NEAR_THRESHOLDS } from "./live-transition-verdict.mjs";
import { intradaySeedHash } from "./intraday-market-seed.mjs";
import { STOCK_CODE_PATTERN } from "./stock-code.mjs";

const namespace = "cloud-live-transition-inputs-v1";
const digest = value => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
const date = value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(value) && Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString().slice(0, 10) === value;
const invalid = () => { throw new Error("LIVE_TRANSITION_REPLAY_INVALID"); };
const exact = (value, keys) => value && typeof value === "object" &&
  Object.keys(value).sort().join(",") === [...keys].sort().join(",");
export const TRANSITION_REPLAY_POLICY = Object.freeze({
  version: "live-golden-close-v1",
  algorithmCommit: "64a59daf08e23862cc9b7f2c8eaef7f452cfdb1c",
  algorithmFiles: Object.freeze(["lib/live-transition-verdict.mjs", "lib/transition-rule-policy.mjs"]),
  algorithmHashBasis: "sha256 of ordered filename + LF + UTF-8 LF-normalized source + LF",
  algorithmSha256: "48223b9a32d14a0afce62b50fda9e3af17546d752681ebda7539c006b2906d31",
  seedRepository: "klkl789982-droid/stock-research", seedPath: "data/analysis/market-seeds/{seedReferenceDate}.json",
  lookback: "first 60 prior daily closes; seed records keyed by code, rows newest first, close at index 4",
  pairs: Object.freeze(["5-20", "20-60"]), nearThresholdsPct: LIVE_NEAR_THRESHOLDS,
  priceBasis: "KIS inquire-price stck_prpr (KRW) used as provisional candle close",
  observedTimeBasis: "KIS minute response stck_bsop_date/stck_cntg_hour (Asia/Seoul); exact quote execution time unknown",
  receivedTimeBasis: "server receipt of inquire-price response (UTC)",
});
export function transitionReplayKey(signalDate, contentHash) {
  if (!date(signalDate) || !digest(contentHash)) invalid();
  return `${namespace}/${signalDate}/${contentHash}.json`;
}
const observationKeys = ["code", "price", "observedDate", "observedTime", "quoteReceivedAt", "originalRecordHash"];

export function assertTransitionReplay(bundle) {
  if (!exact(bundle, ["namespace","signalDate","inputCommit","seedHash","seedReferenceDate","policy","observations","contentHash"]) ||
      bundle.namespace !== namespace || !date(bundle.signalDate) || !date(bundle.seedReferenceDate) ||
      bundle.seedReferenceDate >= bundle.signalDate || !/^[a-f0-9]{40}$/u.test(bundle.inputCommit) ||
      !digest(bundle.seedHash) || hash(bundle.policy) !== hash(TRANSITION_REPLAY_POLICY) ||
      !Array.isArray(bundle.observations) || !bundle.observations.length || bundle.observations.length > 553) invalid();
  const { contentHash, ...body } = bundle;
  if (!digest(contentHash) || hash(body) !== contentHash) invalid();
  let previous = "";
  for (const row of bundle.observations) {
    if (!exact(row, observationKeys) || typeof row.code !== "string" || !STOCK_CODE_PATTERN.test(row.code) || row.code <= previous ||
        !Number.isFinite(row.price) || row.price <= 0 || row.observedDate !== bundle.signalDate ||
        !/^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/u.test(row.observedTime) ||
        !Number.isFinite(Date.parse(row.quoteReceivedAt)) || new Date(row.quoteReceivedAt).toISOString() !== row.quoteReceivedAt ||
        Date.parse(row.observedDate+"T"+row.observedTime+"+09:00") > Date.parse(row.quoteReceivedAt) ||
        !digest(row.originalRecordHash)) invalid();
    previous = row.code;
  }
}

export function buildTransitionReplay(prepared, observations, readPrice) {
  const body = { namespace, signalDate: prepared.targetDate, seedReferenceDate: prepared.seedReferenceDate,
    inputCommit: prepared.inputCommit, seedHash: prepared.seedHash, policy: TRANSITION_REPLAY_POLICY,
    observations: observations.map(row => ({ code: row.code, price: readPrice(row), observedDate: row.observedDate,
      observedTime: row.observedTime, quoteReceivedAt: row.quoteReceivedAt, originalRecordHash: row.originalRecordHash }))
      .sort((a, b) => a.code.localeCompare(b.code)) };
  const value = { ...body, contentHash: hash(body) };
  assertTransitionReplay(value);
  return value;
}

// Return only independently recomputed decisions. A price, envelope, hash or
// rule mismatch cannot be turned into either a fresh ranking or a public quote.
export function verifyTransitionReplay(bundle, evidence, seed) {
  assertTransitionReplay(bundle);
  const p = evidence?.prepared;
  if (evidence?.transitionReplayHash !== bundle.contentHash || p?.inputCommit !== bundle.inputCommit ||
      p?.targetDate !== bundle.signalDate || p.seedHash !== bundle.seedHash || p.seedReferenceDate !== bundle.seedReferenceDate ||
      seed?.contentHash !== bundle.seedHash || seed.requestedDate !== bundle.seedReferenceDate) invalid();
  const { contentHash, ...body } = seed;
  if (intradaySeedHash(body) !== contentHash) invalid();
  const records = evidence.observations.filter(r => r.status === "AVAILABLE");
  const byCode = new Map(records.map(row => [row.code, row]));
  const seeds = new Map(seed.records.map(row => [row.code, row]));
  if (byCode.size !== records.length || records.length !== bundle.observations.length || seeds.size !== seed.records.length) invalid();
  const verified = new Map();
  for (const row of bundle.observations) {
    const saved = byCode.get(row.code), input = seeds.get(row.code);
    if (!saved || !input?.eligible || ["observedDate", "observedTime", "quoteReceivedAt", "originalRecordHash"].some(k => saved[k] !== row[k])) invalid();
    const closes = input.rows?.slice(0, 60);
    if (closes?.length !== 60 || closes.some((r, i) => !/^\d{8}$/u.test(r?.[0]) ||
      r[0] > bundle.seedReferenceDate.replaceAll("-", "") || i > 0 && r[0] >= closes[i - 1][0] ||
      !Number.isFinite(r[4]) || r[4] <= 0)) invalid();
    const decision = freezeTransitionVerdicts(closes, row.price);
    if (!saved.transitionV1 || hash(decision) !== hash(saved.transitionV1)) invalid();
    verified.set(row.code, decision);
  }
  return verified;
}
