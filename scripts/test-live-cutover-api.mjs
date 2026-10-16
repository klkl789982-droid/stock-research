// Synthetic, read-only handler regression. No market collection or artifact writes.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import * as signalModule from "../lib/intraday-model-top-official-signal.mjs";
import * as timePolicy from "../lib/intraday-model-top-time-policy.mjs";
import * as transitions from "../lib/live-transition-screener.mjs";
import * as identity from "../lib/publication-identity.mjs";
import * as codes from "../lib/stock-code.mjs";
import * as quality from "../lib/snapshot-quality-pipeline.mjs";

const source = await readFile(new URL("../app/api/intraday-model-top/route.ts", import.meta.url), "utf8");
const root = process.cwd(), date = "2026-10-16";
let now = `${date}T05:10:00.000Z`;
class FixtureDate extends Date { constructor(...args) { super(...(args.length ? args : [now])); } }
const compile = (source, dependencies) => {
  const exports = {};
  const require = name => {
    if (name === "next/server") return { NextResponse: { json: (body, init) => ({ body, status: init?.status ?? 200, headers: init?.headers }) } };
    if (name === "@/lib/admin-access") return { withAdminAccess: handler => handler };
    if (name === "node:path") return path;
    if (Object.hasOwn(dependencies, name)) return dependencies[name];
    throw new Error(`Unexpected route dependency: ${name}`);
  };
  new Function("require", "exports", "Date", ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText)(require, exports, FixtureDate);
  return exports.GET;
};
const rows = Array.from({ length: 260 }, (_, index) => {
  const day = new Date("2026-10-15T00:00:00Z"); day.setUTCDate(day.getUTCDate() - index);
  return [day.toISOString().slice(0, 10).replaceAll("-", ""), 100 + index / 10, 102 + index / 10, 98 + index / 10, 100 + index / 10, 1000 + index];
});
const seed = { requestedDate: "2026-10-15", contentHash: "e".repeat(64), sourceManifest: { modelFormulaHashes: { "A-v1": "a".repeat(64), "B-v1": "b".repeat(64), "C-v1": "c".repeat(64), "D-v1": "d".repeat(64) }, sources: { officialDailyPrice: { normalizedInputHash: "synthetic-daily" } } }, records: [{ code: "000001", name: "Synthetic current observation", market: "KOSPI", eligible: true, rows }] };
// Synthetic source receipts are explicit and precede the nominal observation.
seed.generatedAt = `${date}T04:00:02.000Z`;
seed.sourceManifest.sources.officialDailyPrice = { normalizedInputHash: "d".repeat(64), availability: {
  availabilityStatus: "OBSERVED", availabilityEvidence: "SYSTEM_OBSERVED_BATCH_COLLECTION", outcome: "success", referenceDate: seed.requestedDate,
  requestedAt: `${date}T04:00:00.000Z`, observedAt: `${date}T04:00:01.000Z`, normalizedInputHash: "d".repeat(64),
} };
const signal = signalModule.buildIntradayModelTopSignal({ seed, signalDate: date, collectionStartedAt: `${date}T05:00:00.000Z`, collectionCompletedAt: `${date}T05:01:00.000Z`, source: "KIS", quotesByCode: new Map([["000001", { code: "000001", source: "KIS", asOfDate: date, asOfTime: "14:00:10", receivedAt: `${date}T05:00:11.000Z`, open: 199, high: 202, low: 198, price: 200, volume: 2000, change: 5, rate: 2.5 }]]) });
assert.ok(signalModule.isCurrentIntradayModelTopSignal(signal));
const currentPath = `data/intraday-signals/model-top/${date}/1400.json`;
const currentPointer = { schemaVersion: 2, artifactType: "intradayModelTopLatestStatus", observationPolicyId: "intraday-1400-v1", signalDate: date, officialSignalTime: "14:00:00", status: "READY", signalPath: currentPath, contentHash: signal.contentHash };
const archivePath = "data/intraday-signals/model-top/2026-10-13/1430.json";
const archive = JSON.parse(await readFile(new URL(`../${archivePath}`, import.meta.url), "utf8"));
assert.deepEqual(signalModule.validateIntradayModelTopSignal(archive), []);
assert.equal(signalModule.isCurrentIntradayModelTopSignal(archive), false);
const archivePointer = { schemaVersion: 1, artifactType: "intradayModelTopLatestStatus", signalDate: archive.signalDate, officialSignalTime: "14:30:00", status: "READY", signalPath: archivePath, contentHash: archive.contentHash };
const files = new Map([[currentPath, signal], [archivePath, archive], ["data/intraday-signals/model-top/latest.json", currentPointer], ["data/trading-calendar/status.json", { dates: { "2026-10-15": { status: "tradingDay" }, [date]: { status: "tradingDay" } } }]]);
const reads = [];
const get = compile(source, {
  "@/lib/intraday-model-top-official-signal.mjs": signalModule,
  "@/lib/intraday-model-top-time-policy.mjs": timePolicy,
  "@/lib/live-transition-screener.mjs": transitions,
  "node:fs/promises": { readFile: async name => { const relative = path.relative(root, name).split(path.sep).join("/"); reads.push(relative); if (!files.has(relative)) throw new Error("ENOENT"); return JSON.stringify(files.get(relative)); } },
});
const request = query => ({ nextUrl: new URL(`http://fixture/api/intraday-model-top?${query}`) });
let result = await get(request("model=B"));
assert.equal(result.status, 200); assert.equal(result.body.officialSignalTime, "14:00:00"); assert.equal(result.body.observationPolicyId, "intraday-1400-v1"); assert.equal(result.body.archived, false); assert.equal(result.body.contentHash, signal.contentHash); assert.equal(result.body.stocks[0].name, "Synthetic current observation");
files.set("data/intraday-signals/model-top/latest.json", archivePointer); reads.length = 0;
result = await get(request("model=B"));
assert.equal(result.status, 503); assert.equal(result.body.error.reason, "OFFICIAL_SIGNAL_NOT_READY"); assert.ok(!reads.includes(archivePath));
assert.equal((await get(request("date=2026-10-13"))).status, 503, "date-only never falls back to 1430");
assert.equal((await get(request("time=1430"))).status, 400, "archives require an explicit date");
result = await get(request("date=2026-10-13&time=1430"));
assert.equal(result.status, 200); assert.equal(result.body.dataMode, "intradayArchivedSignal"); assert.equal(result.body.archived, true); assert.equal(result.body.officialSignalTime, "14:30:00"); assert.equal(result.body.signalVersion, "intraday-model-top-official-signal-v1");
for (const change of [{ status: "WAITING" }, { status: "FAILED" }, { signalPath: archivePath }, { signalPath: "../../outside.json" }, { signalDate: "2026-10-15" }, { contentHash: "wrong" }, { observationPolicyId: "intraday-1430-v1" }]) {
  files.set("data/intraday-signals/model-top/latest.json", { ...currentPointer, ...change });
  assert.equal((await get(request(""))).status, 503, JSON.stringify(change));
}
for (const reason of timePolicy.LIVE_INPUT_WAIT_REASONS) {
  files.set("data/intraday-signals/model-top/latest.json", { ...currentPointer, status: "WAITING", reason });
  const waiting = await get(request("")); assert.equal(waiting.status, 503); assert.equal(waiting.body.error.reason, reason); assert.match(waiting.body.error.message, /직전 공식 EOD 입력 확인 대기/u);
}
const goodLast = { signalDate: "2026-10-15", signalPath: "data/intraday-signals/model-top/2026-10-15/1400.json", observationPolicyId: "intraday-1400-v1", officialSignalTime: "14:00:00" };
const failedAttempt = { ...currentPointer, status: "FAILED", failureStage: "collection", reason: "raw-private-exception-must-not-leak", lastGood: goodLast };
files.set("data/intraday-signals/model-top/latest.json", failedAttempt);
const failedDiagnostic = await get(request(""));
assert.deepEqual(failedDiagnostic.body.error.currentAttempt, { observationPolicyId: "intraday-1400-v1", officialSignalTime: "14:00:00", attemptDate: date, failureStageLabel: "수집", lastGoodDate: "2026-10-15" });
assert.equal(failedDiagnostic.headers["Cache-Control"], "no-store"); assert.doesNotMatch(JSON.stringify(failedDiagnostic), /raw-private/);
for (const lastGood of [
  { ...goodLast, signalDate: "2026-02-30", signalPath: "data/intraday-signals/model-top/2026-02-30/1400.json" },
  { ...goodLast, signalPath: "data/intraday-signals/model-top/2026-10-15/1430.json", officialSignalTime: "14:30:00", observationPolicyId: "intraday-1430-v1" },
  { ...goodLast, signalPath: "../../private.json" }, { ...goodLast, observationPolicyId: undefined },
]) {
  files.set("data/intraday-signals/model-top/latest.json", { ...failedAttempt, signalDate: "2026-02-30", failureStage: "secret-stage", lastGood });
  const badDiagnostic = await get(request("")); assert.equal(badDiagnostic.status, 503);
  assert.equal(badDiagnostic.body.error.currentAttempt.attemptDate, null); assert.equal(badDiagnostic.body.error.currentAttempt.failureStageLabel, null); assert.equal(badDiagnostic.body.error.currentAttempt.lastGoodDate, null);
  assert.doesNotMatch(JSON.stringify(badDiagnostic), /secret-stage|raw-private|private.json|2026-02-30/);
}
files.set("data/intraday-signals/model-top/latest.json", { ...archivePointer, status: "FAILED", failureStage: "collection", lastGood: goodLast });
assert.equal((await get(request(""))).body.error.currentAttempt, null, "old-policy attempt cannot supply current diagnostics");
files.set("data/intraday-signals/model-top/latest.json", currentPointer);
files.set(currentPath, archive); assert.equal((await get(request(""))).status, 503, "archive payload under a 1400 path remains invalid"); files.set(currentPath, signal);
now = "2026-10-19T04:59:59.999Z"; assert.equal((await get(request(""))).status, 200);
now = "2026-10-19T05:00:00.000Z"; assert.equal((await get(request(""))).body.error.reason, "LIVE_SNAPSHOT_STALE", "unknown next weekday is conservatively due at 14:00");
for (const query of ["date=2026-02-30", "date=../outside", "time=1430.json", "time=1330", "model=__proto__"]) assert.equal((await get(request(query))).status, 400);

// The official EOD endpoint never reads legacy Model B LIVE files, even if a
// READY archive remains on disk. This is the TOP client's explicit EOD fallback.
const dailySource = await readFile(new URL("../app/api/top-stocks/route.ts", import.meta.url), "utf8");
const daily = { asOfDate: "2026-10-15", contentHash: "synthetic-history", modelDefinitions: { B: { modelVersion: "B-v1", name: "trendStrength" } }, records: [{ code: "000002", name: "Synthetic official EOD", market: "KOSPI", closePrice: 100, scores: { modelB: 88 }, ranks: { modelB: 1 } }] };
const dailyReads = [];
const dailyGet = compile(dailySource, {
  "@/lib/publication-identity.mjs": identity, "@/lib/stock-code.mjs": codes, "@/lib/snapshot-quality-pipeline.mjs": quality,
  "node:fs/promises": {
    readdir: async () => ["2026-10-15.json"],
    readFile: async name => { const relative = path.relative(root, name).split(path.sep).join("/"); dailyReads.push(relative); if (relative === "data/history/2026-10-15.json") return JSON.stringify(daily); if (relative === "data/daily-production-status/latest.json") return JSON.stringify({ snapshotReferenceDate: daily.asOfDate, observedOfficialDate: daily.asOfDate, freshnessStatus: "fresh" }); throw new Error(`Unexpected read: ${relative}`); },
  },
});
result = await dailyGet(request("model=B"));
assert.equal(result.status, 200); assert.equal(result.body.dataMode, "historySnapshot"); assert.equal(result.body.rankingAsOfDate, "2026-10-15"); assert.equal(result.body.priceBasis, "officialDailyClose"); assert.equal(result.body.stocks[0].name, "Synthetic official EOD");
assert.ok(dailyReads.every(name => !name.includes("intraday-signals")));
console.log("14:00 API cutover: current identity, archive-only opt-in, path/hash/date guards, freshness boundary, and explicit EOD B fallback passed");
