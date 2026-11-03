import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { aggregateProduction } from "../infra/cloudflare-live-kis-diagnostic/production-core.mjs";
import { checkCurrentLiveRelease, createCurrentLiveReader, projectCurrentLiveUniverse } from "../lib/current-live-universe.mjs";
import { deliverPrivateLive, readLatestPublication } from "../lib/private-live-delivery.mjs";
import { intradaySeedHash } from "../lib/intraday-market-seed.mjs";
import { currentTransitionView } from "../lib/live-transition-store.mjs";
import { screenLiveTransitions } from "../lib/live-transition-screener.mjs";
import { observeLiveGoldenTransition, freezeTransitionVerdicts, readTransitionVerdict, LIVE_NEAR_THRESHOLDS } from "../lib/live-transition-verdict.mjs";

const seed = JSON.parse(await readFile(new URL("../data/analysis/market-seeds/2026-11-02.json", import.meta.url)));
const date = "2026-11-03", issued = date + "T06:43:00.000Z";
const targets = seed.records.filter(row => row.eligible);
const prepared = { codes: seed.records.map(r => r.code), eligibleCodes: targets.map(r => r.code), eligible: targets.length,
  targetDate: date, seedReferenceDate: seed.requestedDate, seedHash: seed.contentHash, formulaHashesVerified: true,
  inputCommit: "1".repeat(40), universe: seed.records.length, readiness: "READY", readyAt: date + "T04:58:00.000Z", remoteCheckedAt: date + "T04:57:00.000Z" };
const versions = ["A-v1","B-v1","C-v1","D-v1"];
const rows = targets.slice(0,-1).map((row, index) => ({
  code: row.code, companyName: row.name, status: "AVAILABLE", scores: Object.fromEntries(versions.map((version,n) => [version,(index + n) % 99])),
  observedDate: date, observedTime: "14:00:02", quoteRequestedAt: date + "T05:00:02.000Z", quoteReceivedAt: date + "T05:00:02.020Z",
  minuteRequestedAt: date + "T05:00:03.000Z", minuteReceivedAt: date + "T05:00:03.010Z", originalRecordHash: "a".repeat(64), responseHash:"b".repeat(64),
  ...(index === 0 ? { transitionV1: freezeTransitionVerdicts(row.rows, row.rows[0][4]) } : {}), rawPricesStored: false, modelFormulaUnchanged: true
}));
const { delivery, evidence } = aggregateProduction(prepared,rows,issued,{ firstIssuedAt:issued, revision:1, previousDeliveryHash:null });
const publication = {delivery,publicationTimes:{publishedAt:issued,firstPublishedAt:issued}};
const universe = projectCurrentLiveUniverse(publication,evidence,seed,issued);
assert.equal(universe.records.length,553);
assert.equal(universe.coverage.validCount,targets.length-1);
assert.equal(universe.revision,1);assert.equal(universe.publicationStatus,"PARTIAL");
assert.throws(()=>checkCurrentLiveRelease(publication,{record:{status:"GLOBAL_BLOCKED"}}),/LIVE_GLOBAL_BLOCKED/u);
const withheld = {signalDate:date,coverage:{status:"WITHHELD", universeHash:universe.coverage.universeHash},recordedAt:issued};
checkCurrentLiveRelease(publication,{record:withheld});
assert.throws(()=>checkCurrentLiveRelease(publication,{record:{...withheld,recordedAt:date+"T06:44:00.000Z"}}),/LIVE_PUBLICATION_WITHHELD/u);
for (const version of versions) {
  assert.deepEqual(universe.records.filter(r => r.models[version]).map(r => r.models[version].rank).sort((a,b)=>a-b), Array.from({length:rows.length},(_,i)=>i+1));
  assert.equal(universe.modelDefinitions[version[0]].formulaHash,seed.sourceManifest.modelFormulaHashes[version]);
}
const corrupt = structuredClone(evidence); corrupt.observations[20].scores["A-v1"] += 1;
assert.throws(()=>projectCurrentLiveUniverse(publication,corrupt,seed,issued),/LIVE_SOURCE_MISMATCH/u);
const badSeed = {...seed, contentHash:"0".repeat(64)};
assert.throws(()=>projectCurrentLiveUniverse(publication,evidence,badSeed,issued),/LIVE_SOURCE_MISMATCH/u);
const {contentHash: oldSeedHash, ...otherBase} = structuredClone(seed);
otherBase.sourceManifest.modelFormulaHashes["B-v1"] = "0".repeat(64);
const otherSeed = {...otherBase,contentHash:intradaySeedHash(otherBase)};
assert.notEqual(oldSeedHash,otherSeed.contentHash);
const other = aggregateProduction({...prepared,seedHash:otherSeed.contentHash},rows,issued,{firstIssuedAt:issued,revision:1,previousDeliveryHash:null});
assert.throws(()=>projectCurrentLiveUniverse({...publication,delivery:other.delivery},other.evidence,otherSeed,issued),/LIVE_SOURCE_MISMATCH/u);
const view = currentTransitionView(universe,{ dates:{} },new Date(issued));
const result = screenLiveTransitions(view.rows,{pair:"5-20",state:"all",nearPercent:1,market:"all"});
assert.equal(result.results.length,1);
assert.equal(result.reasonCounts.transitionVerdictNotStored,rows.length-1);
assert.equal(result.results[0].observedPrice,null);
assert.equal(result.results[0].modelReferenceDate,date);
assert.equal(view.rows.at(-1).models["A-v1"],undefined);
for (const pair of ["5-20","20-60"]) {
  for (const close of [500,targets[0].rows[0][4],10000000]) {
    const decision = freezeTransitionVerdicts(targets[0].rows,close);
    for (const threshold of LIVE_NEAR_THRESHOLDS) assert.equal(readTransitionVerdict(decision[pair],threshold),observeLiveGoldenTransition(targets[0].rows,close,pair,threshold).status);
  }
}
assert.throws(()=>currentTransitionView(universe,{dates:{}},new Date("2026-11-04T05:00:00Z")),/LIVE_SNAPSHOT_STALE/u);

// Read the home head and the full Model TOP through their normal selectors across
// three successive publications. The private object store here is memory only.
const objects = new Map();
const store = {
  verifyPrivateRepository: async () => {},
  read: async key => objects.has(key) ? {value: objects.get(key)} : null,
  writeImmutable: async (key, value) => {
    if (objects.has(key)) assert.deepEqual(objects.get(key), value);
    else objects.set(key, value);
  },
  listKeys: async path => {
    const entries = new Map();
    for (const key of objects.keys()) if (key.startsWith(path + "/")) {
      const [name, child] = key.slice(path.length + 1).split("/");
      entries.set(name, {name, type: child ? "dir" : "file"});
    }
    return [...entries.values()];
  },
};
const readTop = createCurrentLiveReader({store, readSeed: async () => seed});
const recovered = (target, score) => ({...rows[0], code: target.code, companyName: target.name,
  scores: Object.fromEntries(versions.map(v => [v, score])), transitionV1: null});
const successive = [
  rows.slice(0,-1),
  [...rows.slice(0,-1), recovered(targets.at(-2), 99)],
  [...rows.slice(0,-1), recovered(targets.at(-2), 99), recovered(targets.at(-1), 100)],
];
let previousHash = null, firstDelivery;
for (let step = 0; step < successive.length; step++) {
  const revision = step + 1, now = new Date(Date.parse(issued) + step * 60_000).toISOString();
  const bundle = aggregateProduction(prepared, successive[step], now, { revision, firstIssuedAt:issued, previousDeliveryHash:previousHash });
  await store.writeImmutable(`cloud-live-score-evidence-v1/${date}/${bundle.evidence.contentHash}.json`, bundle.evidence);
  await deliverPrivateLive(store, bundle.delivery, {now});
  firstDelivery ??= bundle.delivery;
  await deliverPrivateLive(store, firstDelivery, {now}); // Delayed old relay cannot rewind either consumer.
  const [home, top] = await Promise.all([readLatestPublication(store, {now}), readTop({now})]);
  assert.deepEqual([top.signalDate, top.revision, top.deliveryHash, top.sourceHash, top.publishedAt],
    [home.delivery.signalDate, revision, home.delivery.deliveryHash, home.delivery.sourceHash, home.publicationTimes.publishedAt]);
  assert.equal(top.publicationStatus, revision === 3 ? "COMPLETE" : "PARTIAL");
  for (const model of home.delivery.models) {
    const version = model.modelVersion;
    assert.equal(top.modelDefinitions[model.model].formulaHash, seed.sourceManifest.modelFormulaHashes[version]);
    const publishedTop = top.records.filter(row => row.models[version]).toSorted((a,b) => a.models[version].rank - b.models[version].rank).slice(0,5);
    assert.deepEqual(model.records, publishedTop.map(row => ({ticker:row.code,companyName:row.name,...row.models[version]})));
    if (revision > 1) assert.equal(model.records[0].ticker, targets.at(revision === 2 ? -2 : -1).code);
  }
  previousHash = top.deliveryHash;
}
console.log("14:00 whole-universe ranks, frozen model hashes, partial coverage, categorical transitions and cross-session expiry passed");
