import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import * as performance from "../lib/model-top-performance.mjs";

// Execute the actual route with fixture-only file IO. No data writes or API requests.
const source = await readFile(new URL("../app/api/model-performance/route.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
const normalize = (value) => value.replaceAll("\\", "/");
const snapshot = {
  asOfDate: "2026-10-01", contentHash: "frozen-snapshot",
  records: [1, 2].map((index) => ({ code: `00000${index}`, name: `종목 ${index}`, scores: { modelA: 90, modelB: 90, modelC: 90, modelD: 90 }, ranks: { modelA: index, modelB: index, modelC: index, modelD: index },
    futureReturns: { future1dReturn: 999, future5dReturn: index, future20dReturn: null, future60dReturn: index * 2, resolvedAt: { future1dDate: "2026-10-02", future5dDate: index === 1 ? "2026-10-12" : null, future60dDate: "2027-01-04" } },
  })),
};
const files = {
  "/fixture/data/history/2026-10-01.json": snapshot,
  "/fixture/data/historical-outcomes/1d/2026-10-01.json": { signalDate: snapshot.asOfDate, targetTradingDate: "2026-10-02", dataset: "historical-one-day-outcomes", contentHash: "immutable-outcome", records: [{ ticker: "000001", status: "MATURE", returnPercent: -3 }, { ticker: "000002", status: "PENDING", returnPercent: 1000 }] },
  "/fixture/data/intraday-outcomes/model-top/2026-10-01.json": { signalDate: snapshot.asOfDate, signalTime: "14:30:00", records: [{ modelVersion: "B-v1", rank: 1, ticker: "000001", companyName: "종목 1", entry: { tradingDate: "2026-10-02", priceBasis: "nextTradingDayOfficialOpen" }, horizons: { "1DAY": { status: "MATURE", targetTradingDate: "2026-10-02", returnPercent: 7 } } }] },
};
async function loadRoute(fixtureFiles) {
  const exports = {};
  const require = (name) => {
    if (name === "node:fs/promises") return {
      readdir: async (dir) => Object.keys(fixtureFiles).filter((file) => normalize(path.dirname(file)) === normalize(dir)).map((file) => path.basename(file)),
      readFile: async (file) => JSON.stringify(fixtureFiles[normalize(file)]),
    };
    if (name === "node:path") return path;
    if (name === "next/server") return { NextResponse: { json: (body, options) => ({ body, options }) } };
    if (name === "@/lib/model-top-performance.mjs") return performance;
    throw new Error(`Unexpected dependency: ${name}`);
  };
  new Function("require", "exports", "process", compiled)(require, exports, { cwd: () => "/fixture" });
  return exports.GET();
}
const { body, options } = await loadRoute(files);
const metrics = (summary, horizon) => summary.find((m) => m.modelVersion === "B-v1").groups.find((g) => g.topN === 5).horizons.find((h) => h.horizon === horizon);
const daily = metrics(body.summary, "1DAY");
assert.equal(daily.meanReturn, -3, "immutable outcome must take priority over embedded returns");
assert.equal(daily.observationCount, 1);
assert.equal(daily.minObservation.source.contentHash, "immutable-outcome");
assert.equal(daily.minObservation.companyName, "종목 1");
assert.equal(daily.minObservation.entryDate, "2026-10-01");
assert.equal(daily.maxObservation.evaluationEndDate, "2026-10-02");
assert.equal(metrics(body.summary, "5DAY").meanReturn, 1.5);
assert.equal(metrics(body.summary, "5DAY").maxObservation.evaluationEndDate, null, "missing ticker-specific date must not borrow another ticker's date");
assert.equal(metrics(body.summary, "60DAY").meanReturn, 3);
assert.equal(metrics(body.summary, "60DAY").maxObservation.evaluationEndDate, "2027-01-04");
assert.equal(metrics(body.live.summary, "1DAY").meanReturn, 7, "Daily and LIVE must remain isolated");
assert.equal(metrics(body.live.summary, "1DAY").minObservation.entryDate, "2026-10-02");
assert.equal(metrics(body.live.summary, "60DAY").status, "ACCUMULATING");
assert.equal(body.performanceLayer, "DAILY_EOD");
assert.equal(body.latestEodReferenceDate, snapshot.asOfDate);
assert.equal(options.headers["Cache-Control"], "no-store");
assert.deepEqual(await loadRoute(files), { body, options });
const empty = await loadRoute({});
assert.equal(empty.body.totalOutcomeObservationCount, 0);
assert.equal(metrics(empty.body.live.summary, "1DAY").meanReturn, null);
assert.equal(metrics(empty.body.summary, "60DAY").minObservation, null);
console.log("model performance actual route fixture: immutable precedence/60D/per-ticker dates/Daily-LIVE isolation/empty/determinism passed");
