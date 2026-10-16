import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { createLiveObservationFetch } from "../lib/live-observation-request.mjs";
import { assertLiveSeedSession } from "../lib/live-seed-policy.mjs";
import { createKisApiClient } from "../lib/kis-api-client-core.mjs";
import { intradaySeedHash } from "../lib/intraday-market-seed.mjs";
import { buildIntradayModelTopSignal } from "../lib/intraday-model-top-official-signal.mjs";
import { CURRENT_LIVE_PROFILE } from "../lib/intraday-model-top-time-policy.mjs";
import { inspectLiveProductionDeployment } from "../lib/daily-production-deployment-verifier.mjs";
import { loadPinnedLiveInputs } from "../lib/live-pinned-inputs.mjs";
import { startPrivateApi } from "../infra/live-executor/api.mjs";
import { repositoryInputs } from "../infra/live-executor/runtime.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const date = "2026-10-13", previous = "2026-10-12", hash = "a".repeat(64);
const start = Date.parse(`${date}T14:00:00+09:00`), end = Date.parse(`${date}T14:05:00+09:00`);
const endpoint = "https://openapi.koreainvestment.com:9443/uapi/domestic-stock/v1/quotations/inquire-price";
const calendar = { dates: { [previous]: { status: "tradingDay", observedBasDt: previous } } };
function seedFixture(seedDate = previous) {
  const base = { schemaVersion: 1, seedType: "intradayMarketAnalysisSeed", rowOrder: "descending", requestedDate: seedDate, generatedAt: `${date}T04:50:00Z`,
    sourceManifest: { modelFormulaHashes: { "A-v1": hash, "B-v1": hash, "C-v1": hash, "D-v1": hash }, sources: { officialDailyPrice: { normalizedInputHash: hash,
      availability: { referenceDate: seedDate, requestedAt: `${date}T04:48:00Z`, observedAt: `${date}T04:49:00Z`, normalizedInputHash: hash,
        availabilityStatus: "OBSERVED", availabilityEvidence: "SYSTEM_OBSERVED_BATCH_COLLECTION", outcome: "success" } } } },
    records: [{ code: "005930", name: "Synthetic", market: "KOSPI", eligible: true, officialAsOfDate: seedDate, sourceHash: hash, rows: Array.from({ length: 260 }, (_, i) => {
      const tradingDate = new Date(Date.parse(`${seedDate}T00:00:00Z`) - i * 86400000).toISOString().slice(0, 10).replaceAll("-", "");
      return [tradingDate, 100, 102, 98, 101, 10000];
    }) }] };
  return { ...base, contentHash: intradaySeedHash(base) };
}
const rehashSeed = (seed) => { const { contentHash, ...base } = seed; void contentHash; return { ...base, contentHash: intradaySeedHash(base) }; };
function signalFixture() {
  return buildIntradayModelTopSignal({ seed: seedFixture(), signalDate: date, collectionStartedAt: `${date}T05:00:00Z`, collectionCompletedAt: `${date}T05:01:00Z`,
    quotesByCode: new Map([["005930", { source: "KIS", asOfDate: date, asOfTime: "14:00:10", receivedAt: `${date}T05:00:11Z`, open: 101, high: 104, low: 100, price: 103, volume: 12000, change: 2, rate: 1.98 }]]) });
}
async function sandbox(t, time = "14:30:00") {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "tb-live-cutover-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const marker = path.join(directory, "network-attempts.txt"), preload = path.join(directory, "preload.cjs");
  await fs.writeFile(preload, `const fs=require('node:fs');const OriginalDate=Date;const fixed=${JSON.stringify(`${date}T${time}+09:00`)};globalThis.Date=class extends OriginalDate {constructor(...args){super(...(args.length?args:[fixed]));}static now(){return OriginalDate.parse(fixed);}};globalThis.fetch=async()=>{fs.appendFileSync(${JSON.stringify(marker)},'attempt\\n');throw new Error('UNEXPECTED_NETWORK');};`);
  const json = async (relative, value) => { const file = path.join(directory, relative); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, JSON.stringify(value)); };
  const run = (script = "run-intraday-model-top-official-signal.mjs", args = []) => spawnSync(process.execPath, ["--require", preload, path.join(root, "scripts", script), ...args], { cwd: directory, env: { ...process.env, KIS_APP_KEY: "synthetic-key", KIS_APP_SECRET: "synthetic-secret" }, encoding: "utf8" });
  const noNetwork = async () => assert.rejects(fs.access(marker), { code: "ENOENT" });
  return { directory, json, run, noNetwork };
}

test("source schedules use 14:00 only and the duplicate B collector has no cron or secrets", async () => {
  const yaml = createRequire(import.meta.url)("js-yaml");
  const top = yaml.load(await fs.readFile(path.join(root, ".github/workflows/intraday-model-top-official-signal.yml"), "utf8"));
  assert.deepEqual(top.on.schedule, [{ cron: "45 4 * * 1-5" }]);
  const b = yaml.load(await fs.readFile(path.join(root, ".github/workflows/intraday-model-b-official-signal.yml"), "utf8"));
  assert.equal(b.on.schedule, undefined); assert.deepEqual(b.permissions, {}); assert.equal(b.jobs.retired.env, undefined);
  const worker = JSON.parse(await fs.readFile(path.join(root, "infra/cloudflare-live-signal/wrangler.jsonc"), "utf8"));
  assert.deepEqual(worker.triggers.crons, ["42,52 4 * * MON-FRI"]);
  assert.equal(CURRENT_LIVE_PROFILE.slot, "1400");
});

test("transport rejects late requests, including an internal 401 retry after token refresh", async () => {
  let clock = end - 1000, calls = 0, tokens = 0;
  const guarded = createLiveObservationFetch({ signalDate: date, now: () => clock, fetchImpl: async () => { calls++; return new Response("{}", { status: 401 }); } });
  const client = createKisApiClient({ getCredentials: () => ({ appKey: "test", appSecret: "test" }), fetchImpl: guarded,
    tokenManager: { getToken: async () => { if (++tokens === 2) clock = end + 1; return { accessToken: "test" }; }, invalidateIfCurrent: () => {} } });
  await assert.rejects(client.request(endpoint));
  assert.equal(calls, 1); assert.equal(tokens, 2);
  await assert.rejects(guarded(endpoint), /WINDOW_EXPIRED/u); assert.equal(calls, 1);
});

test("transport rejects a response body arriving past deadline, and bounds in-window calls", async () => {
  let clock = start, calls = 0;
  const guarded = createLiveObservationFetch({ signalDate: date, now: () => clock, fetchImpl: async (_, init) => {
    calls++; assert.ok(init.signal instanceof AbortSignal);
    return { status: 200, statusText: "OK", headers: {}, text: async () => { clock = end + 1; return "{}"; } };
  } });
  await assert.rejects(guarded(endpoint), /WINDOW_EXPIRED/u); assert.equal(calls, 1);
  let requested = false;
  await assert.rejects(createLiveObservationFetch({ signalDate: date, now: () => start - 1, fetchImpl: async () => { requested = true; } })(endpoint), /WINDOW_EXPIRED/u);
  assert.equal(requested, false);
});

test("seed cutoff and immediately previous verified session fail closed", () => {
  assert.equal(assertLiveSeedSession(seedFixture(), date, calendar), previous);
  const late = seedFixture(); late.generatedAt = `${date}T05:00:01Z`;
  assert.throws(() => assertLiveSeedSession(late, date, calendar), /SEED_AVAILABILITY/u);
  assert.throws(() => assertLiveSeedSession(seedFixture("2026-10-09"), date, calendar), /PREVIOUS_SESSION_MISSING/u);
  assert.throws(() => assertLiveSeedSession(seedFixture(), date, { dates: {} }), /PREVIOUS_SESSION_UNVERIFIED/u);
  const missing = seedFixture(); delete missing.sourceManifest.sources.officialDailyPrice.availability;
  assert.throws(() => assertLiveSeedSession(missing, date, calendar), /SEED_AVAILABILITY/u);
  const staleRows = seedFixture(); staleRows.records[0].rows = staleRows.records[0].rows.map(([day, ...values]) => {
    const parsed = `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}T00:00:00Z`;
    return [new Date(Date.parse(parsed) - 86400000).toISOString().slice(0, 10).replaceAll("-", ""), ...values];
  });
  assert.throws(() => assertLiveSeedSession(rehashSeed(staleRows), date, calendar), /HISTORY_GAP/u);
  const wrongAsOf = seedFixture(); wrongAsOf.records[0].officialAsOfDate = "2026-10-09";
  assert.throws(() => assertLiveSeedSession(rehashSeed(wrongAsOf), date, calendar), /PREVIOUS_SESSION_MISSING/u);
  const hole = seedFixture(); hole.records[0].rows.splice(1, 1);
  hole.records[0].rows.push(["20251001", 100, 102, 98, 101, 10000]);
  assert.equal(assertLiveSeedSession(rehashSeed(hole), date, { dates: { ...calendar.dates, "2026-10-11": { status: "tradingDay", observedBasDt: "2026-10-11" } } }), previous);
});

test("unchanged real prior-session seed passes readiness checks without any source request", async () => {
  const seed = JSON.parse(await fs.readFile(path.join(root, "data/analysis/market-seeds/2026-10-12.json"), "utf8"));
  const savedCalendar = JSON.parse(await fs.readFile(path.join(root, "data/trading-calendar/status.json"), "utf8"));
  assert.equal(assertLiveSeedSession(seed, "2026-10-13", savedCalendar), "2026-10-12");
  assert.equal(seed.records.filter((record) => record.eligible).length, 508);
});

test("late CLI creates no prices, authentication requests or 1430 artifact and preserves archives", async (t) => {
  const f = await sandbox(t), archivePath = `data/intraday-signals/model-top/${date}/1430.json`;
  await f.json(archivePath, { archived: "unchanged" });
  const before = await fs.readFile(path.join(f.directory, archivePath), "utf8");
  const result = f.run();
  assert.equal(result.status, 1); assert.match(result.stdout, /OFFICIAL_SIGNAL_OUTSIDE_COLLECTION_WINDOW/u); await f.noNetwork();
  assert.equal(await fs.readFile(path.join(f.directory, archivePath), "utf8"), before);
  await assert.rejects(fs.access(path.join(f.directory, `data/intraday-signals/model-top/${date}/1400.json`)), { code: "ENOENT" });
});

test("unavailable or missing prior-session input returns WAITING before any authentication", async (t) => {
  for (const kind of ["late", "gap", "unknown"]) {
    const f = await sandbox(t, "13:45:00"), seed = seedFixture(kind === "gap" ? "2026-10-09" : previous);
    if (kind === "late") seed.generatedAt = `${date}T05:01:00Z`;
    await f.json(`data/analysis/market-seeds/${seed.requestedDate}.json`, rehashSeed(seed));
    await f.json("data/trading-calendar/status.json", kind === "unknown" ? { dates: {} } : calendar);
    const result = f.run(); assert.equal(result.status, 1); assert.match(result.stdout, /"status":"WAITING"/u); await f.noNetwork();
    assert.match(result.stdout, /LIVE_INPUT_NOT_READY_/u);
  }
});

test("ALREADY_STORED preserves original signal and latest metadata even after the window", async (t) => {
  const f = await sandbox(t, "18:00:00"), artifact = signalFixture(), signalPath = `data/intraday-signals/model-top/${date}/1400.json`;
  const latestPath = "data/intraday-signals/model-top/latest.json";
  await f.json(signalPath, artifact); await f.json(latestPath, { status: "READY", contentHash: artifact.contentHash, operations: { storedAt: `${date}T05:01:01Z`, producer: "original" } });
  const before = await fs.readFile(path.join(f.directory, latestPath), "utf8"), signalBefore = await fs.readFile(path.join(f.directory, signalPath), "utf8");
  const result = f.run(); assert.equal(result.status, 0); assert.match(result.stdout, /"status":"ALREADY_STORED"/u); await f.noNetwork();
  assert.equal(await fs.readFile(path.join(f.directory, latestPath), "utf8"), before); assert.equal(await fs.readFile(path.join(f.directory, signalPath), "utf8"), signalBefore);
});

test("retired B CLI cannot collect even when given the old unrestricted flag", async (t) => {
  const f = await sandbox(t);
  const before = await fs.readdir(f.directory);
  const result = f.run("run-intraday-model-b-official-signal.mjs", ["--allow-any-time", "--signal-date=2020-01-01"]);
  assert.equal(result.status, 1); assert.match(result.stdout, /"status":"RETIRED"/u); await f.noNetwork();
  assert.deepEqual(await fs.readdir(f.directory), before);
});

test("deployment verification rejects same-day archive, wrong hash and after-window body", async () => {
  const active = { signalDate: date, observationType: "LIVE_OBSERVATION", archived: false, officialSignalTime: CURRENT_LIVE_PROFILE.signalTime,
    signalVersion: CURRENT_LIVE_PROFILE.signalVersion, observationPolicyId: CURRENT_LIVE_PROFILE.policyId, contentHash: hash,
    signalPath: `data/intraday-signals/model-top/${date}/1400.json`, collectionStartedAt: `${date}T05:00:00Z`, collectionCompletedAt: `${date}T05:04:00Z` };
  for (const [changes, expected] of [[{}, true], [{ archived: true }, false], [{ contentHash: "b".repeat(64) }, false], [{ officialSignalTime: "14:30:00" }, false], [{ collectionCompletedAt: `${date}T05:05:01Z` }, false]]) {
    assert.equal(await inspectLiveProductionDeployment({ siteUrl: "https://example.invalid", expectedSignalDate: date, expectedContentHash: hash,
      fetchImpl: async () => Response.json({ ...active, ...changes }) }), expected);
  }
});

function pinnedFixture({ changedCode = "", missingCalendar = false, late = false, dirty = "", wrongFormula = false } = {}) {
  let clock = Date.parse(`${date}T04:45:00Z`);
  const seed = seedFixture(), formula = "synthetic formula v1\n", commit = "b".repeat(40), commands = [];
  seed.generatedAt = `${date}T04:56:00Z`;
  seed.sourceManifest.sources.officialDailyPrice.availability.observedAt = `${date}T04:55:59Z`;
  for (const version of Object.keys(seed.sourceManifest.modelFormulaHashes)) seed.sourceManifest.modelFormulaHashes[version] = createHash("sha256").update(formula).digest("hex");
  const frozenSeed = rehashSeed(seed), seedPath = `data/analysis/market-seeds/${previous}.json`;
  const git = async (args) => {
    commands.push(args);
    if (args[0] === "remote") return "https://github.com/klkl789982-droid/stock-research.git\n";
    if (args[0] === "diff") return args.length === 4 ? dirty : changedCode;
    if (args[0] === "ls-files") return "";
    if (args[0] === "fetch") { if (late) clock = start + 1; return ""; }
    if (args[0] === "rev-parse") return `${commit}\n`;
    if (args[0] === "ls-tree") return `${seedPath}\n`;
    if (args[0] === "show") {
      assert.ok(args[1].startsWith(`${commit}:`), "All reads must use the pinned SHA, never mutable origin/main");
      if (args[1].endsWith(seedPath)) return JSON.stringify(frozenSeed);
      if (args[1].endsWith("data/trading-calendar/status.json")) return JSON.stringify(missingCalendar ? { dates: {} } : calendar);
      if (args[1].includes(":lib/")) return wrongFormula ? "wrong formula" : formula;
    }
    throw new Error(`UNEXPECTED_FIXTURE_GIT_COMMAND:${args[0]}`);
  };
  return { seed: frozenSeed, commit, commands, options: { signalDate: date, now: () => clock, wait: async (ms) => { clock += ms; }, git } };
}

test("13:59 pinned refresh recovers a 13:56 EOD with one SHA and no working-tree mutations", async (t) => {
  const fixture = pinnedFixture(), directory = await fs.mkdtemp(path.join(os.tmpdir(), "tb-pinned-read-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, "sentinel.txt"), "unchanged");
  const result = await loadPinnedLiveInputs({ root: directory, ...fixture.options });
  assert.equal(result.seed.contentHash, fixture.seed.contentHash); assert.equal(result.inputProvenance.inputCommit, fixture.commit);
  assert.equal(result.inputProvenance.refreshedAt, `${date}T04:59:00.000Z`);
  assert.equal(result.inputProvenance.readyAt, `${date}T04:59:00.000Z`);
  assert.equal(fixture.commands.filter(([verb]) => verb === "fetch").length, 1);
  assert.equal(fixture.commands.some(([verb]) => ["checkout", "reset", "add", "commit", "push"].includes(verb)), false);
  assert.deepEqual(await fs.readdir(directory), ["sentinel.txt"]); assert.equal(await fs.readFile(path.join(directory, "sentinel.txt"), "utf8"), "unchanged");
  const signal = buildIntradayModelTopSignal({ seed: result.seed, signalDate: date, collectionStartedAt: `${date}T05:00:00Z`, collectionCompletedAt: `${date}T05:01:00Z`,
    quotesByCode: new Map([["005930", { source: "KIS", asOfDate: date, asOfTime: "14:00:10", receivedAt: `${date}T05:00:11Z`, open: 101, high: 104, low: 100, price: 103, volume: 12000, change: 2, rate: 1.98 }]]), inputProvenance: result.inputProvenance });
  assert.equal(signal.source.inputProvenance.inputCommit, fixture.commit); assert.equal(signal.source.inputProvenance.seedHash, result.seed.contentHash);
});

test("pinned refresh rejects code/package drift, late completion, formula mismatch and unknown sessions", async () => {
  for (const changedCode of ["lib/technical-strength.mjs\0", "package-lock.json\0"]) await assert.rejects(loadPinnedLiveInputs(pinnedFixture({ changedCode }).options), /REFRESH_CODE_MISMATCH/u);
  await assert.rejects(loadPinnedLiveInputs(pinnedFixture({ dirty: "scripts/run-intraday-model-top-official-signal.mjs\0" }).options), /REFRESH_CODE_MISMATCH/u);
  const late = pinnedFixture({ late: true }); await assert.rejects(loadPinnedLiveInputs(late.options), /REFRESH_LATE/u);
  assert.equal(late.commands.some(([verb]) => verb === "show"), false);
  await assert.rejects(loadPinnedLiveInputs(pinnedFixture({ missingCalendar: true }).options), /PREVIOUS_SESSION_UNVERIFIED/u);
  await assert.rejects(loadPinnedLiveInputs(pinnedFixture({ wrongFormula: true }).options), /REFRESH_FORMULA_MISMATCH/u);
});

test("daemon seed and calendar share one pinned commit and retain provenance on restart", async () => {
  const fixture = pinnedFixture(), formula = "synthetic formula v1\n", commands = [];
  const git = async (args) => {
    commands.push(args);
    if (args[0] === "show" && args[1].startsWith("HEAD:")) return formula;
    return fixture.options.git(args);
  };
  const options = { remote: true, git, readFile: async () => formula, now: () => Date.parse(`${date}T04:56:10Z`) };
  const loader = repositoryInputs("/synthetic-read-only-checkout", options), seed = await loader.loadSeed(date);
  assert.equal(await loader.verifySeedSession(seed, date), previous);
  const evidence = loader.getInputProvenance(seed);
  assert.equal(evidence.inputCommit, fixture.commit); assert.equal(evidence.seedHash, fixture.seed.contentHash);
  assert.equal(evidence.readyAt, `${date}T04:56:10.000Z`);
  assert.equal(commands.filter(([verb]) => verb === "rev-parse").length, 1);
  assert.equal(commands.some(([verb, value]) => verb === "show" && value.startsWith("origin/main:")), false);
  const restarted = repositoryInputs("/synthetic-read-only-checkout", { ...options, now: () => Date.parse(`${date}T09:00:00Z`) });
  assert.equal(await restarted.verifySeedSession(seed, date, evidence), previous);
  assert.deepEqual(restarted.getInputProvenance(seed), evidence);
  await assert.rejects(restarted.verifySeedSession(seed, date, { ...evidence, calendarHash: "c".repeat(64) }), /REFRESH_INPUT_INVALID/u);
});

test("refresh is opt-in and cannot be combined with dry-run", async (t) => {
  const f = await sandbox(t, "13:45:00");
  const result = f.run("run-intraday-model-top-official-signal.mjs", ["--dry-run", "--wait-for-window", "--refresh-inputs"]);
  assert.equal(result.status, 1); assert.match(result.stdout, /REFRESH_REQUIRES_LIVE_WAIT/u); await f.noNetwork();
  await assert.rejects(fs.access(path.join(f.directory, "data")), { code: "ENOENT" });
});

test("private LIVE readback rejects an unchanged 1430 archive without mutating its pointer", async (t) => {
  const archive = JSON.parse(await fs.readFile(path.join(root, "data/intraday-signals/model-top/2026-10-13/1430.json"), "utf8"));
  const pointer = { signalDate: archive.signalDate, artifactKey: "live/archive/result.json", contentHash: archive.contentHash };
  const original = JSON.stringify(pointer), token = "synthetic-private-api-token-1234567890";
  const store = { read: async (key) => key === "live/latest.json" ? pointer : archive };
  const api = await startPrivateApi({ store, mode: "live", token }); t.after(() => api.close());
  assert.equal((await fetch(`${api.url}/top`)).status, 401);
  const response = await fetch(`${api.url}/top`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(response.status, 503); assert.equal((await response.json()).status, "NO_CURRENT_POLICY_OBSERVATION");
  assert.equal(JSON.stringify(pointer), original);
});

test("private 14:00 result is explicitly stored readback with no certified market freshness", async (t) => {
  const artifact = signalFixture(), token = "synthetic-private-api-token-1234567890";
  const pointer = { signalDate: date, artifactKey: "live/current/result.json", contentHash: artifact.contentHash };
  const api = await startPrivateApi({ mode: "live", token, store: { read: async (key) => key === "live/latest.json" ? pointer : artifact } }); t.after(() => api.close());
  const response = await fetch(`${api.url}/top`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(response.status, 200); const body = await response.json();
  assert.equal(body.officialSignalTime, "14:00:00"); assert.equal(body.observationPolicyId, "intraday-1400-v1");
  assert.equal(body.view, "STORED_OBSERVATION_READBACK"); assert.equal(body.freshnessStatus, "NOT_EVALUATED"); assert.equal(body.currentSessionVerified, false);
});
