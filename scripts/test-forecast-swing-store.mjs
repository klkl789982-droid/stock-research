import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { NextRequest } from "next/server.js";
import { buildIntradayModelTopSignal, hashIntradayModelTop } from "../lib/intraday-model-top-official-signal.mjs";
import { loadForecastSwingDashboard, loadSwingObservation, prepareSwingLedgerRecord, readSwingLedger, appendSwingPreparation, SWING_LEDGER_DIRECTORY } from "../lib/forecast-swing-store.mjs";

const repository = fileURLToPath(new URL("../", import.meta.url));
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "swing-store-"));
const date = "2026-10-08", now = "2026-10-16T13:00:00.000Z";
const rows = Array.from({ length: 260 }, (_, index) => { const d = new Date("2026-10-02T00:00:00Z"); d.setUTCDate(d.getUTCDate() - index); return [d.toISOString().slice(0, 10).replaceAll("-", ""), 100, 110, 90, 101, 2000]; });
const seed = { requestedDate: "2026-10-02", generatedAt: "2026-10-02T03:00:00Z", contentHash: "a".repeat(64), sourceManifest: { sources: { officialDailyPrice: { normalizedInputHash: "d".repeat(64), availability: { availabilityStatus: "OBSERVED", availabilityEvidence: "SYSTEM_OBSERVED_BATCH_COLLECTION", outcome: "success", referenceDate: "2026-10-02", requestedAt: "2026-10-02T01:00:00Z", observedAt: "2026-10-02T02:00:00Z", normalizedInputHash: "d".repeat(64) } } }, modelFormulaHashes: Object.fromEntries(["A-v1", "B-v1", "C-v1", "D-v1"].map(x => [x, "b".repeat(64)])) }, records: [{ code: "005930", name: "Synthetic stock", market: "KOSPI", eligible: true, rows }] };
const signal = buildIntradayModelTopSignal({ seed, signalDate: date, collectionStartedAt: `${date}T05:00:00.000Z`, collectionCompletedAt: `${date}T05:01:00.000Z`, observationType: "LIVE_OBSERVATION", source: "KIS",
  quotesByCode: new Map([["005930", { code: "005930", source: "KIS", asOfDate: date, asOfTime: "14:00:10", receivedAt: `${date}T05:00:11.000Z`, open: 100, high: 120, low: 90, price: 110, volume: 3000, change: 9, rate: 9 }]]) });
const pointer = value => ({ schemaVersion: 2, observationPolicyId: "intraday-1400-v1", artifactType: "intradayModelTopLatestStatus", status: "READY", signalDate: date, officialSignalTime: "14:00:00", signalPath: `data/intraday-signals/model-top/${date}/1400.json`, contentHash: value.contentHash });
const rehash = value => { const base = { ...value }; delete base.contentHash; return { ...base, contentHash: hashIntradayModelTop(base) }; };
async function json(root, filename, value) { const target = path.join(root, filename); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, JSON.stringify(value)); }
let next = 0;
async function fixture(value = signal, latest = pointer(value)) { const root = path.join(temporary, String(++next)); await json(root, `data/intraday-signals/model-top/${date}/1400.json`, value); await json(root, "data/intraday-signals/model-top/latest.json", latest); return root; }
async function fingerprints(root) {
  const result = {};
  async function walk(dir) { for (const entry of await fs.readdir(path.join(root, dir), { withFileTypes: true })) { const relative = path.join(dir, entry.name); if (entry.isDirectory()) await walk(relative); else result[relative] = hashIntradayModelTop(await fs.readFile(path.join(root, relative), "utf8")); } }
  await walk(""); return result;
}
let passed = 0;
async function test(name, fn) { await fn(); console.log(`ok ${++passed} - ${name}`); }
const originalFetch = globalThis.fetch;
globalThis.fetch = () => { throw new Error("No external requests allowed in fixture tests"); };
try {
  await test("empty storage stays PREPARING with null predictions and explicit blockers", async () => {
    const root = path.join(temporary, "empty"); await fs.mkdir(root);
    const view = await loadForecastSwingDashboard({ root, now });
    assert.equal(view.status, "PREPARING"); assert.equal(view.observation.status, "UNAVAILABLE"); assert.equal(view.observation.referencePrice, null);
    assert.deepEqual(Object.values(view.prediction), [null, null, null]); assert.equal(view.ledger.recordCount, 0); assert.equal(view.evaluation.mature5DayCount, 0);
    assert.equal(view.readiness.eligibleForTraining, false); assert.ok(view.readiness.blockers.length); assert.deepEqual(await fs.readdir(root), []);
  });
  await test("valid saved observations remain observations; date clusters and null values are honest", async () => {
    const root = await fixture(); const before = await fingerprints(root);
    const view = await loadForecastSwingDashboard({ root, now });
    assert.equal(view.observation.signalDate, date); assert.equal(view.observation.referencePrice, 110); assert.equal(view.observation.rowCount, 1); assert.equal(view.observation.independentDateCount, 1);
    assert.equal(view.observation.availableAt, null); assert.equal(view.model.trainingStatus, "NOT_TRAINED"); assert.equal(view.evaluation.costAdjustedReturnPercent, null);
    assert.equal(view.ledger.recordCount, 0); assert.deepEqual(await fingerprints(root), before);
    const tooEarly = await loadForecastSwingDashboard({ root, now: `${date}T05:00:00Z` });
    assert.equal(tooEarly.observation.status, "UNAVAILABLE"); assert.equal(tooEarly.observation.independentDateCount, 0);
    const missing = await loadForecastSwingDashboard({ root, code: "999999", now }); assert.equal(missing.observation.status, "UNAVAILABLE"); assert.equal(missing.observation.referencePrice, null);
    await assert.rejects(loadSwingObservation({ root, code: "../outside" }), /INVALID_STOCK_CODE/);
  });
  await test("bad pointers, unknown states and rehashed invalid observations fail closed", async () => {
    for (const edit of [{ signalPath: "../escape.json" }, { contentHash: "0".repeat(64) }, { schemaVersion: "1" }, { artifactType: "wrong" }, { status: "FAILED" }, { officialSignalTime: "19:00:00" }]) {
      const root = await fixture(signal, { ...pointer(signal), ...edit }); const result = await loadSwingObservation({ root }); assert.equal(result.signal, null); assert.equal(result.independentDateCount, 1);
    }
    for (const change of [x => { x.collection.failed = 1; }, x => { x.records[0].provisionalOhlcv.close = null; }, x => { x.records[0].provisionalOhlcv.close = "110"; }, x => { x.records[0].quote.asOfDate = "2026-10-07"; }, x => { x.collectionCompletedAt = `${date}T10:00:00Z`; }, x => { x.observationType = "TEST_FIXTURE"; }]) {
      const bad = structuredClone(signal); change(bad); const value = rehash(bad), root = await fixture(value); const result = await loadSwingObservation({ root }); assert.equal(result.signal, null); assert.equal(result.invalidArtifactCount, 1);
    }
  });
  await test("preparation issuance is new, hashed and immutable; real zero features stay zero", async () => {
    const changed = structuredClone(signal); changed.records[0].scores["B-v1"] = 0; const root = await fixture(rehash(changed));
    const record = await prepareSwingLedgerRecord({ root, code: "005930", clock: () => now });
    assert.equal(record.status, "PREPARING"); assert.equal(record.createdAt, now); assert.notEqual(record.createdAt.slice(0, 10), date); assert.equal(record.observationMode, "RETROSPECTIVE_OBSERVATION");
    assert.equal(record.observation.provenance.availableAt, now); assert.equal(record.inputs.find(x => x.name === "observedScore:B-v1").value, 0);
    assert.equal(record.eligibility.forTraining, false); assert.deepEqual(Object.values(record.predictions), [null, null, null]);
    assert.equal((await appendSwingPreparation({ root, record })).created, true); assert.equal((await appendSwingPreparation({ root, record })).created, false);
    const ledger = await readSwingLedger({ root, now }); assert.equal(ledger.records.length, 1); assert.equal(ledger.records[0].forecastHash, record.forecastHash);
    const target = path.join(root, SWING_LEDGER_DIRECTORY, `${record.forecastHash}.json`); await fs.writeFile(target, "tampered");
    await assert.rejects(appendSwingPreparation({ root, record }), /IMMUTABLE_LEDGER_CONFLICT/); assert.equal(await fs.readFile(target, "utf8"), "tampered");
    assert.equal((await readSwingLedger({ root, now })).invalidRecordCount, 1);
  });
  await test("CLI previews by default, rejects backdating and writes only opt-in new preparation records", async () => {
    const root = await fixture(), before = await fingerprints(root), script = path.join(repository, "scripts/record-swing-preparation.mjs");
    const execute = args => spawnSync(process.execPath, [script, ...args], { cwd: root, env: { PATH: process.env.PATH, TZ: "UTC" }, encoding: "utf8", timeout: 10000 });
    const preview = execute(["--code=005930"]); assert.equal(preview.status, 0, preview.stderr); assert.equal(JSON.parse(preview.stdout).predictionCreated, false); assert.deepEqual(await fingerprints(root), before);
    for (const args of [["--code=005930", "--created-at=2026-10-08T05:00:00Z"], ["--code=../bad", "--record"], ["--code=005930", "--allow-any-time"]]) { assert.equal(execute(args).status, 1); assert.deepEqual(await fingerprints(root), before); }
    const lower = Date.now(); const recorded = execute(["--code=005930", "--record"]); const upper = Date.now(); assert.equal(recorded.status, 0, recorded.stderr);
    const result = JSON.parse(recorded.stdout); assert.equal(result.preparationRecorded, true); assert.equal(result.predictionCreated, false); assert.ok(Date.parse(result.createdAt) >= lower && Date.parse(result.createdAt) <= upper);
    const after = await fingerprints(root); for (const [file, hash] of Object.entries(before)) assert.equal(after[file], hash); assert.equal(Object.keys(after).filter(file => !(file in before)).length, 1);
  });
  await test("actual GET handler stays read-only, rejects invalid symbols and returns no-store PREPARING", async () => {
    const require = createRequire(import.meta.url); let source = await fs.readFile(path.join(repository, "app/api/forecasts/swing/route.ts"), "utf8");
    assert.match(source, /export const GET = withAdminAccess\(handleGet\)/); assert.doesNotMatch(source, /export (?:const|async function) (?:POST|PUT|PATCH|DELETE)/);
    const bypass = "data:text/javascript," + encodeURIComponent("export const withAdminAccess = fn => fn;");
    source = source.replace(/(["'])@\/([^"']+)\1/gu, (_, q, name) => JSON.stringify(name === "lib/admin-access" ? bypass : pathToFileURL(path.join(repository, name)).href)).replace(/(["'])next\/server\1/gu, JSON.stringify(pathToFileURL(require.resolve("next/server.js")).href));
    const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
    const route = await import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);
    const root = await fixture(), before = await fingerprints(root), cwd = process.cwd(); process.chdir(root);
    try {
      const response = await route.GET(new NextRequest("https://fixture.invalid/api/forecasts/swing?code=005930")); assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store"); assert.equal((await response.json()).status, "PREPARING");
      assert.equal((await route.GET(new NextRequest("https://fixture.invalid/api/forecasts/swing?code=../secret"))).status, 400);
    } finally { process.chdir(cwd); }
    assert.deepEqual(await fingerprints(root), before);
  });
  console.log(`Swing store/API/CLI: ${passed} groups passed using disposable synthetic fixtures.`);
} finally { globalThis.fetch = originalFetch; await fs.rm(temporary, { recursive: true, force: true }); }
