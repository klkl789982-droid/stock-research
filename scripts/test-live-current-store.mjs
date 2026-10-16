// Pure/local fixtures only. No 14:00 observation is written to repository data.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildIntradayModelTopSignal, isCurrentIntradayModelTopSignal, validateIntradayModelTopSignal, hashIntradayModelTop, validateIntradaySeedAvailability } from "../lib/intraday-model-top-official-signal.mjs";
import { CURRENT_LIVE_PROFILE, LEGACY_LIVE_PROFILE } from "../lib/intraday-model-top-time-policy.mjs";
import { createLiveTransitionStore } from "../lib/live-transition-store.mjs";
import { validateLiveTransitionFreshness } from "../lib/live-transition-screener.mjs";
import { loadForecastSwingDashboard } from "../lib/forecast-swing-store.mjs";

const repo = process.cwd(), date = "2026-10-13", prior = "2026-10-12";
const archivePath = `data/intraday-signals/model-top/${date}/1430.json`;
const archiveBytes = await fs.readFile(path.join(repo, archivePath));
const archiveHash = createHash("sha256").update(archiveBytes).digest("hex");
const archive = JSON.parse(archiveBytes);
assert.deepEqual(validateIntradayModelTopSignal(archive), []);
assert.equal(isCurrentIntradayModelTopSignal(archive), false);
assert.equal(LEGACY_LIVE_PROFILE.signalTime, "14:30:00");
assert.equal(CURRENT_LIVE_PROFILE.signalTime, "14:00:00");
const seed = JSON.parse(await fs.readFile(`data/analysis/market-seeds/${prior}.json`, "utf8"));
const history = JSON.parse(await fs.readFile(`data/history/${prior}.json`, "utf8"));
const calendar = JSON.parse(await fs.readFile("data/trading-calendar/status.json", "utf8"));
assert.deepEqual(validateIntradaySeedAvailability(seed, date), []);
const quotes = new Map(seed.records.filter(row => row.eligible).map((row, index) => [row.code, {
  source: "KIS", asOfDate: date, asOfTime: "14:00:20", receivedAt: `${date}T05:00:21.000Z`,
  open: 99 + index, high: 102 + index, low: 98 + index, price: 100 + index, volume: 2000, change: 1, rate: 1,
}]));
// Explicitly synthetic quote inputs; the historical EOD seed itself is not edited.
const signal = buildIntradayModelTopSignal({ seed, quotesByCode: quotes, signalDate: date,
  collectionStartedAt: `${date}T05:00:00.000Z`, collectionCompletedAt: `${date}T05:02:00.000Z` });
assert.ok(isCurrentIntradayModelTopSignal(signal));
const rehash = value => { const { contentHash: ignored, ...base } = value; void ignored; return { ...base, contentHash: hashIntradayModelTop(base) }; };
for (const change of [
  s => { s.records.push(null); }, s => { s.records = null; }, s => { s.source.provider = "UNKNOWN"; },
  s => { s.schemaVersion = 1; }, s => { s.schemaVersion = "2"; }, s => { delete s.observationPolicyId; },
  s => { s.officialSignalTime = "14:30:00"; }, s => { s.collectionCompletedAt = `${date}T05:05:00.001Z`; },
  s => { s.source.seedAvailableAt = `${date}T05:00:00.001Z`; }, s => { s.source.seedObservedAt = null; },
  s => { s.records.find(row => row.dataStatus === "AVAILABLE").quote.receivedAt = `${date}T05:05:01Z`; },
  s => { s.records.find(row => row.dataStatus === "AVAILABLE").provisionalOhlcv.close = "100"; },
  s => { s.records.find(row => row.dataStatus === "AVAILABLE").scores["B-v1"] = null; },
  s => { s.records.find(row => row.dataStatus === "AVAILABLE").observationIds["B-v1"] = "f".repeat(64); },
  s => { s.records.find(row => row.dataStatus === "AVAILABLE").ranks["B-v1"] = 999; },
]) { const bad = structuredClone(signal); change(bad); assert.equal(isCurrentIntradayModelTopSignal(rehash(bad)), false); }
for (const key of ["generatedAt", "observedAt", "normalizedInputHash"]) {
  const bad = structuredClone(seed);
  if (key === "generatedAt") bad.generatedAt = `${date}T05:00:00.001Z`;
  else bad.sourceManifest.sources.officialDailyPrice.availability[key] = key === "observedAt" ? `${date}T05:00:01Z` : "bad";
  assert.ok(validateIntradaySeedAvailability(bad, date).length);
}
const root = await fs.mkdtemp(path.join(os.tmpdir(), "live-1400-store-"));
async function write(relative, value) { const target = path.join(root, relative); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, JSON.stringify(value)); }
const pointerPath = "data/intraday-signals/model-top/latest.json";
const currentPath = `data/intraday-signals/model-top/${date}/1400.json`;
const pointer = { schemaVersion: 2, artifactType: "intradayModelTopLatestStatus", observationPolicyId: "intraday-1400-v1", officialSignalTime: "14:00:00",
  status: "READY", signalDate: date, signalPath: currentPath, contentHash: signal.contentHash };
try {
  await write(archivePath, archive);
  await write(pointerPath, { schemaVersion: 1, status: "READY", signalDate: date, officialSignalTime: "14:30:00", signalPath: archivePath, contentHash: archive.contentHash });
  await assert.rejects(createLiveTransitionStore({ root })(), /LIVE_SNAPSHOT_WAITING/);
  const empty = await loadForecastSwingDashboard({ root, now: `${date}T05:06:00Z` });
  assert.equal(empty.observation.status, "UNAVAILABLE"); assert.equal(empty.observation.independentDateCount, 0);
  assert.ok(!empty.readiness.blockers.some(item => item.code === "INVALID_SAVED_RECORDS"), "Preserved legacy archives are not corrupt current data");
  await write(currentPath, signal); await write(pointerPath, pointer);
  await write(`data/analysis/market-seeds/${prior}.json`, seed); await write(`data/history/${prior}.json`, history);
  await write("data/trading-calendar/status.json", calendar);
  let now = `${date}T05:06:00Z`;
  const load = createLiveTransitionStore({ root, now: () => new Date(now) });
  const result = await load(); assert.equal(result.mode, "LIVE"); assert.equal(result.snapshotTime, "14:00:00");
  assert.equal(result.observationPolicyId, "intraday-1400-v1"); assert.equal(result.signalVersion, CURRENT_LIVE_PROFILE.signalVersion);
  assert.equal(result.source.signalPath, currentPath); assert.strictEqual(await load(), result);
  now = "2026-10-14T04:59:59.999Z"; assert.strictEqual(await load(), result);
  now = "2026-10-14T05:00:00.000Z"; await assert.rejects(load(), /LIVE_SNAPSHOT_STALE/);
  assert.throws(() => validateLiveTransitionFreshness(archive, calendar, `${date}T06:00:00Z`), /LIVE_SNAPSHOT_INVALID/);
  await write(pointerPath, { ...pointer, status: "FAILED", lastGood: pointer }); await assert.rejects(load(), /LIVE_SNAPSHOT_FAILED/);
  const staleAttempt = await loadForecastSwingDashboard({ root, now }); assert.equal(staleAttempt.observation.status, "UNAVAILABLE");
} finally { await fs.rm(root, { recursive: true, force: true }); }
assert.equal(createHash("sha256").update(await fs.readFile(path.join(repo, archivePath))).digest("hex"), archiveHash);
console.log("Current 14:00 store: strict policy/timing/seed receipts, cached cutoff, legacy archive isolation and no repository writes passed");
