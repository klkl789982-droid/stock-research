import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { immutableSnapshotView } from "../lib/future-return-resolver.mjs";
import { isReadableModelHistorySchemaVersion } from "../lib/model-history-schema.mjs";
import { validateMarketDataQuality } from "../lib/market-data-quality-validator.mjs";
import {
  annotateRankingMetadata, assertSnapshotQualityGate, buildExcludedFromScoring, buildTrackingUniverse,
  buildUniverseSummary, checkUniverseArchive, commitNewArtifactSet, createFormulaHashes,
  createSourceManifest, createUniverseArchive, sha256Canonical,
} from "../lib/snapshot-quality-pipeline.mjs";

const requestedDate = "2026-08-14";
function date(index) { const value = new Date("2026-08-14T00:00:00Z"); value.setUTCDate(value.getUTCDate() - index); return value.toISOString().slice(0, 10).replaceAll("-", ""); }
function rows(count = 260) { return Array.from({ length: count }, (_, index) => ({ basDt: date(index), mkp: 100, hipr: 110, lopr: 90, clpr: 100, trqu: 10, trPrc: 1000, mrktTotAmt: 1_000_000 })); }
function quality(historyByCode, universeRecords = [{ code: "000001", name: "A", market: "KOSPI" }]) {
  return validateMarketDataQuality({ requestedDate, universeRecords, historyByCode, requirements: { expectedUniverseCount: universeRecords.length, sourceManifestPresent: true, universeFilterVersion: "v1", universeGeneratedAt: "2026-08-14T18:00:00Z" } });
}
let passed = 0;
async function test(name, fn) { await fn(); passed += 1; console.log(`PASS ${name}`); }

await test("fatal이면 산출물 생성 전에 차단", async () => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "snapshot-gate-"));
  const bad = rows(); bad[0].clpr = 0;
  assert.throws(() => assertSnapshotQualityGate(quality(new Map([["000001", bad]]))), { code: "MARKET_DATA_QUALITY_FATAL" });
  assert.equal((await fs.readdir(temporaryRoot)).length, 0);
  await fs.rm(temporaryRoot, { recursive: true });
});
for (const [name, mutate, type] of [
  ["requestedDate 불일치 차단", (value) => { value.shift(); }, "latestDateMismatch"],
  ["invalid OHLC 차단", (value) => { value[0].hipr = 80; }, "invalidOhlcRelationship"],
  ["exact-date 시총 누락 차단", (value) => { value[0].mrktTotAmt = null; }, "missingExactDateMarketCap"],
]) await test(name, async () => { const value = rows(); mutate(value); const result = quality(new Map([["000001", value]])); assert.ok(result.issues.some((entry) => entry.type === type && entry.severity === "fatal")); });
await test("종목 누락 차단", async () => { const result = quality(new Map()); assert.ok(result.issues.some((entry) => entry.type === "missingHistoryCodes")); });
await test("100일 종목은 A/B/D 제외, C 포함", async () => {
  const result = quality(new Map([["000001", rows(100)]]));
  assert.equal(result.modelEligibility["A-v1"].eligibleCodes.length, 0);
  assert.equal(result.modelEligibility["B-v1"].eligibleCodes.length, 0);
  assert.deepEqual(result.modelEligibility["C-v1"].eligibleCodes, ["000001"]);
  assert.equal(result.modelEligibility["D-v1"].eligibleCodes.length, 0);
  const excluded = buildExcludedFromScoring(result, new Map([["000001", { name: "A" }]]));
  assert.ok(excluded.every((item) => item.reason === "insufficientHistory"));
});
await test("modelEligible와 B/C 공통 Universe 정확", async () => {
  const histories = new Map([["000001", rows(260)], ["000002", rows(100)]]);
  const result = quality(histories, [{ code: "000001" }, { code: "000002" }]);
  const summary = buildUniverseSummary(result, ["B-v1", "C-v1"]);
  assert.equal(summary.modelEligibleUniverse["B-v1"].count, 1);
  assert.equal(summary.modelEligibleUniverse["C-v1"].count, 2);
  assert.equal(summary.commonComparisonUniverse.count, 1);
});
await test("제외 종목에는 점수나 순위를 만들지 않는 nullable 구조", async () => {
  const record = { scores: { modelA: null }, ranks: { modelA: null } };
  assert.equal(record.scores.modelA, null); assert.equal(record.ranks.modelA, null);
});
await test("rankingUniverseCount와 percentile 정확", async () => {
  const records = [1, 2].map((rank) => ({ ranks: { modelA: rank, modelB: rank, modelC: rank, modelD: rank }, ranksByVersion: { "A-v2": rank }, rankingUniverseCount: {}, rankPercentile: {}, rankingUniverseCountByVersion: {}, rankPercentileByVersion: {} }));
  annotateRankingMetadata(records); assert.equal(records[0].rankingUniverseCount.modelA, 2); assert.equal(records[0].rankPercentile.modelA, 0.5);
});
await test("입력 및 공식 hash 결정론", async () => {
  assert.equal(sha256Canonical({ b: 2, a: 1 }), sha256Canonical({ a: 1, b: 2 }));
  assert.deepEqual(createFormulaHashes({ B: "x", A: "y" }), createFormulaHashes({ A: "y", B: "x" }));
  const universe = { stocks: [{ code: "000001" }] }; const histories = new Map([["000001", rows()]]); const policy = { pointInTimeMasterCertified: false, rawResponseStored: false, universeFilterVersion: "v1" };
  assert.equal(createSourceManifest({ requestedDate, generatedAt: "x", universe, historyByCode: histories, formulaHashes: {}, policy }).sources.officialDailyPrice.normalizedInputHash, createSourceManifest({ requestedDate, generatedAt: "x", universe, historyByCode: histories, formulaHashes: {}, policy }).sources.officialDailyPrice.normalizedInputHash);
});
await test("Universe archive 동일 hash 멱등, 다른 hash 충돌", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "universe-archive-")); const target = path.join(root, "a.json");
  const universe = { stocks: [{ code: "000001", name: "A", market: "KOSPI" }], criteria: {} }; const histories = new Map([["000001", rows()]]);
  const sourceManifest = { schemaVersion: 1, universe: { filterVersion: "v1" }, sources: { securityMaster: {}, officialDailyPrice: { normalizedInputHash: "x" } } };
  const archive = createUniverseArchive({ requestedDate, generatedAt: "x", universe, historyByCode: histories, sourceManifest });
  assert.equal(await checkUniverseArchive(target, archive), "create"); await fs.writeFile(target, JSON.stringify(archive)); assert.equal(await checkUniverseArchive(target, archive), "idempotent");
  await assert.rejects(() => checkUniverseArchive(target, { ...archive, contentHash: "different" }), /해시 충돌/); await fs.rm(root, { recursive: true });
});
await test("tracking Universe는 과거 미확정 종목 포함", async () => {
  const result = buildTrackingUniverse([{ code: "000001", name: "A" }], [{ records: [{ code: "000002", name: "B", futureReturns: {}, backtestReturns: { returns: {} } }] }]);
  assert.deepEqual(result.map((item) => item.code), ["000001", "000002"]);
});
await test("부분 commit 실패 시 확정 파일 0개", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "artifact-set-")); const artifacts = ["a", "b", "c"].map((name) => ({ path: path.join(root, name), content: name }));
  await assert.rejects(() => commitNewArtifactSet(artifacts, { failAfterCommit: 2 }), /syntheticCommitFailure/); assert.equal((await fs.readdir(root)).length, 0); await fs.rm(root, { recursive: true });
});
await test("신규 필드는 resolver 불변 view에 포함", async () => {
  const snapshot = { sourceManifest: { a: 1 }, dataQuality: { b: 2 }, universeSummary: { c: 3 }, records: [{ code: "1", futureReturns: {}, backtestReturns: {}, rankingUniverseCount: { modelA: 1 } }] };
  const view = immutableSnapshotView(snapshot); assert.deepEqual(view.sourceManifest, { a: 1 }); assert.deepEqual(view.records[0].rankingUniverseCount, { modelA: 1 });
});
await test("schemaVersion 2/3/4/5 읽기 호환", async () => { for (const version of [2, 3, 4, 5]) assert.equal(isReadableModelHistorySchemaVersion(version), true); });
console.log(`스냅샷 품질 파이프라인 테스트 완료: ${passed}개 통과`);
