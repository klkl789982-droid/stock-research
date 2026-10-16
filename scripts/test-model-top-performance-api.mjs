import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import * as performance from "../lib/model-top-performance.mjs";
import * as publicationIdentity from "../lib/publication-identity.mjs";
import { currentOutcome, legacyOutcomeFixture, rehash } from "./fixtures/intraday-1400-outcomes.mjs";

// Execute the actual route with fixture-only file IO. No data writes or API requests.
const source = await readFile(new URL("../app/api/model-performance/route.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
const normalize = (value) => value.replaceAll("\\", "/");
const snapshot = {
  asOfDate: "2026-10-06", contentHash: "frozen-snapshot",
  records: [1, 2].map((index) => ({ code: `00000${index}`, name: `종목 ${index}`, scores: { modelA: 90, modelB: 90, modelC: 90, modelD: 90 }, ranks: { modelA: index, modelB: index, modelC: index, modelD: index },
    futureReturns: { future1dReturn: 999, future5dReturn: index, future20dReturn: null, future60dReturn: index * 2, resolvedAt: { future1dDate: "2026-10-07", future5dDate: index === 1 ? "2026-10-12" : null, future60dDate: "2027-01-04" } },
  })),
};
const live = currentOutcome();
const legacy = legacyOutcomeFixture(live);
legacy.records.forEach((record) => { record.horizons["1DAY"].returnPercent = 999; });
const files = {
  "/fixture/data/history/2026-10-06.json": snapshot,
  "/fixture/data/historical-outcomes/1d/2026-10-06.json": { signalDate: snapshot.asOfDate, targetTradingDate: "2026-10-07", dataset: "historical-one-day-outcomes", contentHash: "immutable-outcome", records: [{ ticker: "000001", status: "MATURE", returnPercent: -3 }, { ticker: "000002", status: "PENDING", returnPercent: 1000 }] },
  "/fixture/data/intraday-outcomes/model-top/2026-10-06.json": rehash(legacy),
  "/fixture/data/intraday-outcomes/model-top/1400/2026-10-06.json": live,
};
async function loadRoute(fixtureFiles, reads = []) {
  const exports = {};
  const require = (name) => {
    if (name === "@/lib/admin-access") return { withAdminAccess: handler => handler }; // Authorized data-contract fixture; auth independently tested.
    if (name === "@/lib/publication-identity.mjs") return publicationIdentity; // Real hash semantics; no fabricated identity.
    if (name === "node:fs/promises") return {
      readdir: async (dir) => Object.keys(fixtureFiles).filter((file) => normalize(path.dirname(file)) === normalize(dir)).map((file) => path.basename(file)),
      readFile: async (file) => { reads.push(normalize(file)); return JSON.stringify(fixtureFiles[normalize(file)]); },
    };
    if (name === "node:path") return path;
    if (name === "next/server") return { NextResponse: { json: (body, options) => ({ body, options }) } };
    if (name === "@/lib/model-top-performance.mjs") return performance;
    throw new Error(`Unexpected dependency: ${name}`);
  };
  new Function("require", "exports", "process", compiled)(require, exports, { cwd: () => "/fixture" });
  return exports.GET();
}
const reads = [];
const { body, options } = await loadRoute(files, reads);
const metrics = (summary, horizon) => summary.find((m) => m.modelVersion === "B-v1").groups.find((g) => g.topN === 5).horizons.find((h) => h.horizon === horizon);
const daily = metrics(body.summary, "1DAY");
assert.equal(daily.meanReturn, -3, "immutable outcome must take priority over embedded returns");
assert.equal(daily.observationCount, 1);
assert.equal(daily.minObservation.source.contentHash, "immutable-outcome");
assert.equal(daily.minObservation.companyName, "종목 1");
assert.equal(daily.minObservation.entryDate, "2026-10-06");
assert.equal(daily.maxObservation.evaluationEndDate, "2026-10-07");
assert.equal(metrics(body.summary, "5DAY").meanReturn, 1.5);
assert.equal(metrics(body.summary, "5DAY").maxObservation.evaluationEndDate, null, "missing ticker-specific date must not borrow another ticker's date");
assert.equal(metrics(body.summary, "60DAY").meanReturn, 3);
assert.equal(metrics(body.summary, "60DAY").maxObservation.evaluationEndDate, "2027-01-04");
assert.equal(metrics(body.live.summary, "1DAY").meanReturn, 7, "Daily and LIVE must remain isolated");
assert.equal(metrics(body.live.summary, "1DAY").minObservation.entryDate, "2026-10-07");
assert.equal(metrics(body.live.summary, "1DAY").minObservation.signalTime, "14:00:00");
assert.equal(body.live.layer, "INTRADAY_1400_LIVE");
assert.equal(body.live.executionPolicyId, "intraday-1400-t1-open-v1");
assert.equal(body.live.archiveOnly, false);
assert.equal(metrics(body.live.summary, "60DAY").status, "ACCUMULATING");
assert.equal(body.performanceLayer, "DAILY_EOD");
assert.equal(body.latestEodReferenceDate, snapshot.asOfDate);
assert.deepEqual(body.dataIdentity, publicationIdentity.dataIdentity(snapshot));
assert.equal(reads.some((file) => /^\/fixture\/data\/intraday-outcomes\/model-top\/\d{4}-\d{2}-\d{2}\.json$/u.test(file)), false, "current route must never read old date-only files");
assert.equal(options.headers["Cache-Control"], "no-store");
assert.deepEqual(await loadRoute(files), { body, options });
const empty = await loadRoute({});
assert.equal(empty.body.totalOutcomeObservationCount, 0);
assert.equal(metrics(empty.body.live.summary, "1DAY").meanReturn, null);
assert.equal(metrics(empty.body.summary, "60DAY").minObservation, null);
const oldFilesOnly = Object.fromEntries(Object.entries(files).filter(([file]) => !file.includes("/model-top/1400/")));
const oldOnly = await loadRoute(oldFilesOnly);
assert.equal(oldOnly.body.live.totalOutcomeObservationCount, 0);
assert.equal(oldOnly.body.live.layer, "INTRADAY_1400_LIVE");
assert.equal(metrics(oldOnly.body.live.summary, "1DAY").status, "ACCUMULATING");
assert.equal(metrics(oldOnly.body.live.summary, "1DAY").meanReturn, null, "old MATURE rows cannot populate the new empty cohort");
for (const invalid of [rehash(legacy), { ...live, contentHash: "tampered" }, rehash({ ...live, source: { ...live.source, signalAvailability: null } })]) {
  const rejected = await loadRoute({ ...oldFilesOnly, "/fixture/data/intraday-outcomes/model-top/1400/2026-10-06.json": invalid });
  assert.equal(rejected.body.live.totalOutcomeObservationCount, 0);
  assert.equal(metrics(rejected.body.live.summary, "1DAY").meanReturn, null);
  assert.equal(metrics(rejected.body.summary, "1DAY").meanReturn, -3, "invalid LIVE input must not damage the independent EOD cohort");
}
console.log("model performance actual route fixture: immutable precedence/60D/per-ticker dates/Daily-LIVE isolation/empty/determinism passed");
