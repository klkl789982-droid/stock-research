import assert from "node:assert/strict";
import {
  assertPromotionFiles,
  classifyLatestProbeFailure,
  classifySameDate,
  createCompactModelHistory,
  createDailyRunManifest,
  DAILY_RUN_STATUS,
  evaluatePromotionCandidate,
  resolveOfficialReferenceDate,
  validateCompactModelHistory,
} from "../lib/daily-production.mjs";

const eligible = (code, rank) => ({
  code, name: `종목${code}`, market: "KOSPI",
  scores: { modelA: 70, modelB: 60, modelC: 50, modelD: 55 },
  scoresByVersion: { "A-v1": 70, "A-v2": 65 },
  ranks: { modelA: rank, modelB: rank, modelC: rank, modelD: rank },
  ranksByVersion: { "A-v1": rank, "A-v2": rank },
  rankingUniverseCount: { modelA: 8, modelB: 8, modelC: 8, modelD: 8 },
  rankingUniverseCountByVersion: { "A-v1": 8, "A-v2": 8 },
  qualityEligibility: { eligible: true, status: "eligible", exclusions: [] },
});
const quarantined = (code) => ({
  code, name: `종목${code}`, market: "KOSDAQ",
  scores: { modelA: null, modelB: null, modelC: null, modelD: null },
  scoresByVersion: { "A-v1": null, "A-v2": null }, ranks: {}, ranksByVersion: {},
  qualityEligibility: { eligible: false, status: "quarantined", exclusions: [{ reason: "postNonTradingPriceDiscontinuity", disposition: "quarantine" }] },
});
const records = [...Array.from({ length: 8 }, (_, index) => eligible(String(index + 1).padStart(6, "0"), index + 1)), quarantined("000009"), quarantined("000010")];
const snapshot = {
  asOfDate: "2026-09-28", records, contentHash: "snapshot-hash",
  modelDefinitions: {}, modelVersionDefinitions: {}, championChallenger: {}, sourceManifest: { safe: true }, sourceAvailabilityStatus: "final",
  signalAvailableAt: "2026-09-28T11:00:00.000Z", excludedFromScoring: [],
  universeSummary: { originalUniverse: { count: 10, codesHash: "original" }, qualityEligibleUniverse: { count: 8, codesHash: "eligible" }, quarantinedUniverse: { count: 2, codesHash: "quarantine" }, rankingUniverse: {} },
};

const compact = createCompactModelHistory(snapshot);
const productionBeforeFailure = JSON.stringify(snapshot);
assert.deepEqual(validateCompactModelHistory(compact, 10), []);
assert.equal(compact.records.length, 10);
assert.equal(compact.universeSummary.originalUniverse.count, 10);
assert.equal(compact.records.filter((record) => record.eligibility.status === "quarantined").length, 2);
assert(compact.records.filter((record) => record.eligibility.status === "quarantined").every((record) => record.eligibility.exclusions[0].reason === "postNonTradingPriceDiscontinuity"));
assert(compact.records.filter((record) => record.eligibility.status === "quarantined").every((record) => Object.values(record.models).every((model) => model.score === null && model.rank === null)));
assert.equal(classifySameDate(null, compact), "create");
assert.equal(classifySameDate(structuredClone(compact), compact), "idempotent");
assert.equal(classifySameDate({ ...compact, contentHash: "different" }, compact), "revisionRequired");

assert.deepEqual(evaluatePromotionCandidate({ collectionCompleted: true, structuralFatalCount: 0, requiredArtifactsPresent: true }), { eligible: true, reasons: [] });
assert.deepEqual(evaluatePromotionCandidate({ collectionCompleted: true, structuralFatalCount: 0, requiredArtifactsPresent: true, snapshotValidationErrors: [] }), { eligible: true, reasons: [] }, "quarantine은 structural fatal이 아니므로 partial ranking 승격을 막지 않습니다.");
assert.deepEqual(evaluatePromotionCandidate({ collectionCompleted: true, structuralFatalCount: 2, requiredArtifactsPresent: true }), { eligible: false, reasons: ["structuralFatal"] });
assert.equal(evaluatePromotionCandidate({ collectionCompleted: false, structuralFatalCount: 0, requiredArtifactsPresent: false }).eligible, false);
assert.equal(JSON.stringify(snapshot), productionBeforeFailure, "실패 판정은 기존 production 입력을 변경하면 안 됩니다.");

const runId = "daily-test";
const manifest = createDailyRunManifest({ referenceDate: snapshot.asOfDate, runId, status: DAILY_RUN_STATUS.NO_NEW_OFFICIAL_EOD, startedAt: "2026-09-29T00:00:00.000Z", completedAt: "2026-09-29T00:00:01.000Z" });
assert.equal(manifest.status, DAILY_RUN_STATUS.NO_NEW_OFFICIAL_EOD);
assert.equal(manifest.promoted, false);

const files = assertPromotionFiles([
  `data/history/${snapshot.asOfDate}.json`, `data/model-history/${snapshot.asOfDate}.json`, `data/daily-runs/${snapshot.asOfDate}/${runId}.json`,
], snapshot.asOfDate, runId);
assert.equal(files.length, 3);
assert.throws(() => assertPromotionFiles([".env.local"], snapshot.asOfDate, runId));
assert.throws(() => assertPromotionFiles(["scripts/run-daily-production.mjs"], snapshot.asOfDate, runId));

const serialized = JSON.stringify({ compact, manifest });
for (const forbidden of ["DATA_GO_KR_SERVICE_KEY=", "DART_API_KEY=", "KIS_APP_SECRET="]) assert(!serialized.includes(forbidden));
assert.equal(classifyLatestProbeFailure(new Error("LATEST_PROBE_HTTP_403")), "LATEST_PROBE_HTTP_403");
assert.equal(classifyLatestProbeFailure(Object.assign(new Error("request"), { cause: { code: "ENOTFOUND" } })), "LATEST_PROBE_NETWORK_DNS");
assert.equal(classifyLatestProbeFailure(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } })), "LATEST_PROBE_NETWORK_CONNECTION_RESET");
assert.equal(classifyLatestProbeFailure(Object.assign(new Error("timeout"), { name: "TimeoutError" })), "LATEST_PROBE_TIMEOUT");
assert.equal(classifyLatestProbeFailure(new SyntaxError("bad json")), "LATEST_PROBE_INVALID_JSON");
assert.equal(classifyLatestProbeFailure(new TypeError("fetch failed")), "LATEST_PROBE_NETWORK_UNKNOWN");

assert.deepEqual(resolveOfficialReferenceDate({ observedDate: "2026-09-29", collectionDate: "2026-09-29", previousProductionReferenceDate: "2026-09-28" }), { status: "candidate", referenceDate: "2026-09-29", reason: null }, "정상 거래일은 관측 basDt를 사용합니다.");
assert.deepEqual(resolveOfficialReferenceDate({ observedDate: "2026-09-25", collectionDate: "2026-09-27", previousProductionReferenceDate: "2026-09-24" }), { status: "candidate", referenceDate: "2026-09-25", reason: null }, "주말 실행도 현재 날짜가 아닌 최신 관측 거래일을 사용합니다.");
assert.deepEqual(resolveOfficialReferenceDate({ observedDate: "2026-10-02", collectionDate: "2026-10-05", previousProductionReferenceDate: "2026-10-01" }), { status: "candidate", referenceDate: "2026-10-02", reason: null }, "공휴일 또는 게시 지연도 확인된 최신 basDt를 사용합니다.");
assert.deepEqual(resolveOfficialReferenceDate({ observedDate: "2026-09-23", collectionDate: "2026-09-28", previousProductionReferenceDate: "2026-09-22" }), { status: "candidate", referenceDate: "2026-09-23", reason: null }, "source lag는 관측 거래일 자체를 referenceDate로 사용합니다.");
assert.deepEqual(resolveOfficialReferenceDate({ observedDate: "2026-09-21", collectionDate: "2026-09-29", previousProductionReferenceDate: "2026-09-22" }), { status: "stale", referenceDate: null, reason: "observedDateOlderThanProduction" }, "production보다 오래된 응답은 차단합니다.");
assert.deepEqual(resolveOfficialReferenceDate({ observedDate: "2026-09-22", collectionDate: "2026-09-29", previousProductionReferenceDate: "2026-09-22" }), { status: "noNewOfficialEod", referenceDate: "2026-09-22", reason: "sameReferenceDate" });
assert.match(await import("node:fs/promises").then((fs) => fs.readFile(new URL("./run-daily-production.mjs", import.meta.url), "utf8")), /--date=\$\{referenceDate\}.*--observed-date=\$\{referenceDate\}/su, "downstream에는 동일 referenceDate를 전달해야 합니다.");

console.log(JSON.stringify({ records: compact.records.length, compactBytes: Buffer.byteLength(JSON.stringify(compact)), statuses: ["create", "idempotent", "revisionRequired", manifest.status], allowlistedFiles: files.length }, null, 2));
