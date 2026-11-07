import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";
import { prepareModelPerformance } from "./prepare-model-performance.mjs";
import { latestOneDayPerformance } from "../lib/home-dashboard.mjs";
import * as directories from "../lib/private-report-directory.mjs";
import * as publicationIdentity from "../lib/publication-identity.mjs";

// Compile using a synthetic private build directory, then exercise the real route.
const source = await readFile(new URL("../app/api/model-performance/route.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
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
const temporary = await mkdtemp(path.join(tmpdir(), "tb-model-performance-report-"));
process.on("exit", () => rmSync(temporary, { recursive: true, force: true }));
let sequence = 0;
async function loadRoute(fixtureFiles, asOf = "2027-01-05T04:00:00Z", buildSha = "b".repeat(40), runtimeSha = "b".repeat(40)) {
  const root = path.join(temporary, String(++sequence));
  for (const [name, value] of Object.entries(fixtureFiles)) {
    const file = path.join(root, path.relative("/fixture", name));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(value));
  }
  await prepareModelPerformance({ root, asOf: Date.parse(asOf), commitSha: buildSha });
  const exports = {}, reads = [];
  const require = name => {
    if (name === "@/lib/admin-auth.mjs") return { isAutomationRequest: request => request.headers.has("authorization") };
    if (name === "@/lib/private-report-directory.mjs") return directories;
    if (name === "@/lib/publication-identity.mjs") return publicationIdentity;
    if (name === "@/lib/admin-access") return { withAdminAccess: handler => handler };
    if (name === "node:fs/promises") return { readFile: (file, encoding) => {
      assert.equal(path.dirname(file), path.join(root, "build", "private-model-performance"));
      reads.push(path.basename(file)); return readFile(file, encoding);
    } };
    if (name === "node:path") return path;
    throw new Error("Unexpected dependency: " + name);
  };
  new Function("require", "exports", "process", compiled)(require, exports, { cwd: () => root, env: { VERCEL_GIT_COMMIT_SHA: runtimeSha } });
  const request = new Request("https://example.invalid/api/model-performance");
  if (buildSha && buildSha !== runtimeSha) return exports.GET(request);
  const body = await (await exports.GET(request)).json();
  const repeat = await exports.GET(request);
  assert.deepEqual(await repeat.json(), body);
  const options = { headers: { "Cache-Control": repeat.headers.get("cache-control") } };
  const home = await (await exports.GET(new Request(request.url + "?view=home"))).json();
  const identity = await (await exports.GET(new Request(request.url + "?view=home", { headers: { authorization: "fixture" } }))).json();
  assert.deepEqual(identity, { dataIdentity: body.dataIdentity, latestEodReferenceDate: body.latestEodReferenceDate, publicationReady: body.publicationReady });
  assert.deepEqual(latestOneDayPerformance(home, 5), latestOneDayPerformance(body, 5));
  assert.deepEqual(home.dataIdentity, body.dataIdentity);
  assert.deepEqual(reads, ["report.json", "home.json", "identity.json"], "Every view reads only its private built response once");
  return { body, options };
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
assert.equal(metrics(body.summary, "5DAY").meanReturn, 1);
assert.equal(metrics(body.summary, "5DAY").maxObservation.evaluationEndDate, "2026-10-12", "missing ticker-specific date must not borrow another ticker's date");
assert.equal(metrics(body.summary, "60DAY").meanReturn, 3);
assert.equal(metrics(body.summary, "60DAY").maxObservation.evaluationEndDate, "2027-01-04");
assert.equal(metrics(body.live.summary, "1DAY").meanReturn, 7, "Daily and LIVE must remain isolated");
assert.equal(metrics(body.live.summary, "1DAY").minObservation.entryDate, "2026-10-02");
assert.equal(metrics(body.live.summary, "60DAY").status, "ACCUMULATING");
assert.equal(body.performanceLayer, "DAILY_EOD");
assert.equal(body.latestEodReferenceDate, snapshot.asOfDate);
assert.equal(options.headers["Cache-Control"], "private, no-store");
const beforeClose = await loadRoute(files, "2026-10-02T06:29:59Z");
assert.equal(metrics(beforeClose.body.summary, "1DAY").observationCount, 0);
assert.equal(metrics(beforeClose.body.summary, "60DAY").observationCount, 0);
assert.equal(metrics(beforeClose.body.live.summary, "1DAY").observationCount, 0);
assert.equal(metrics(beforeClose.body.live.summary, "1DAY").maturity.PENDING, 1);
assert.equal((await loadRoute(files, undefined, null)).body.dataIdentity.commitSha, "b".repeat(40));
assert.equal((await loadRoute(files, undefined, "c".repeat(40))).status, 503);
assert.equal(directories.privateReportDirectory("/root", { NODE_ENV: "production", TB_AUTH_TEST_BUILD: "1" }), path.join("/root", "build"));
assert.deepEqual(await loadRoute(files), { body, options });
const empty = await loadRoute({});
assert.equal(empty.body.totalOutcomeObservationCount, 0);
assert.equal(metrics(empty.body.live.summary, "1DAY").meanReturn, null);
assert.equal(metrics(empty.body.summary, "60DAY").minObservation, null);
console.log("model performance actual route fixture: immutable precedence/60D/per-ticker dates/Daily-LIVE isolation/empty/determinism passed");
