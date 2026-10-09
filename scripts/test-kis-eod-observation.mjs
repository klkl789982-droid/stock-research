import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { getKisEodObservationWindow, sanitizeKisEodObservationEvent, KIS_EOD_OBSERVATION_TICKERS, KIS_EOD_OBSERVATION_SLOTS } from "../lib/kis-eod-observation.mjs";
import { parseKisEodObservationArgs, runKisEodObservations } from "./observe-kis-eod.mjs";
import { createKisEodProvider } from "../lib/kis-eod-provider.mjs";

const require = createRequire(import.meta.url), yaml = require("js-yaml");
const date = "2026-10-08", stamp = "2026-10-08T06:40:00.000Z";
const sourceRow = (ticker, close = 100) => ({ basDt: "20261008", srtnCd: ticker, mkp: 95, hipr: 110, lopr: 90, clpr: close, trqu: 1000, trPrc: 100000, fltRt: null, observationStatus: "trading" });
async function sandbox(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "kis-eod-observation-test-"));
  await fs.mkdir(path.join(root, "data", "history"), { recursive: true });
  await fs.writeFile(path.join(root, "data", "history", "frozen.json"), "FROZEN_OFFICIAL_DATA\n");
  t.after(async () => {
    const absolute = path.resolve(root);
    assert.ok(absolute.startsWith(`${path.resolve(os.tmpdir())}${path.sep}kis-eod-observation-test-`));
    await fs.rm(absolute, { recursive: true, force: true });
  });
  return root;
}
function fixture({ now = () => stamp, telemetry = [], failTicker = null, calendar = true, changedTicker = null, onHistory = null } = {}) {
  const calls = { calendar: 0, histories: [] };
  return { calls,
    async getTradingDay(referenceDate) {
      calls.calendar += 1;
      return { source: "KIS", operation: "chk-holiday", referenceDate, isTradingDay: calendar, receivedAt: new Date(now()).toISOString(),
        sourceFields: { bass_dt: referenceDate.replaceAll("-", ""), opnd_yn: calendar === false ? "N" : "Y", tr_day_yn: calendar === true ? "Y" : "N" } };
    },
    async getHistory(ticker, referenceDate, options) {
      calls.histories.push(ticker);
      assert.equal(referenceDate, date); assert.deepEqual(options, { adjustment: "unadjusted", requiredRows: 260, maxPages: 5 });
      const requestedAt = new Date(now()).toISOString();
      if (onHistory) await onHistory(ticker);
      const receivedAt = new Date(now()).toISOString();
      telemetry.push({ component: "kis-eod-provider", operation: "inquire-daily-itemchartprice", status: failTicker === ticker ? "ATTEMPT_FAILURE" : "SUCCESS", reason: failTicker === ticker ? "KIS_EOD_RATE_LIMITED" : null,
        attempt: 1, requestStartedAt: requestedAt, receivedAt, durationMs: Date.parse(receivedAt) - Date.parse(requestedAt), httpStatus: failTicker === ticker ? 429 : 200, businessCode: failTicker === ticker ? null : "SUCCESS" });
      if (failTicker === ticker) { const error = new Error("PRIVATE_BODY_MUST_NOT_LEAK"); error.code = "KIS_EOD_RATE_LIMITED"; throw error; }
      return { source: "KIS", sourceOperation: "inquire-daily-itemchartprice", code: ticker, referenceDate, rows: [sourceRow(ticker, changedTicker === ticker ? 101 : 100)], adjustment: "unadjusted", marketDivision: "J", priceBasis: "kisDailyBarUnadjusted",
        requestedAt, receivedAt, historyComplete: false, pageCount: 1, symbolMapping: { requestedCode: ticker, responseCode: ticker, status: "VERIFIED_RESPONSE_TICKER" },
        adjustmentMetadata: [{ date, exDividendCode: "00", splitRatio: 0, changed: "N", reevaluationReason: "00" }], dailyChangeMetadata: [{ date, reportedDifference: 1, reportedSign: "2" }], unexpectedRaw: "PRIVATE_BODY_MUST_NOT_LEAK" };
    } };
}
// Collector behavior fixtures use an isolated in-memory sink. Remote protocol,
// actual configuration gates and persistence failure are tested separately.
const fixtureStore = () => ({ preflight: async () => {}, readCompleted: async () => null, claim: async () => true,
  persistArtifact: async () => {}, readCalendar: async () => null, persistCalendar: async () => {}, recordOutcome: async () => {} });
const run = (root, provider, options = {}) => runKisEodObservations({ root, provider, now: () => stamp, collectPrivate: true, observationEnabled: "true", slot: "15:40", durableStore: fixtureStore(), ...options });
async function artifacts(root, slot = "1540") {
  const directory = path.join(root, ".runtime", "kis-eod", "observations", date, slot);
  const names = (await fs.readdir(directory)).filter((name) => name.endsWith(".json") && name !== "completed.json");
  return Promise.all(names.map(async (name) => ({ name, value: JSON.parse(await fs.readFile(path.join(directory, name), "utf8")) })));
}

test("designated tickers and slots are fixed and close is not inferred from UTC", () => {
  assert.deepEqual(KIS_EOD_OBSERVATION_TICKERS, ["005930", "000660", "064290"]);
  assert.deepEqual(KIS_EOD_OBSERVATION_SLOTS, ["15:40", "16:10", "16:40"]);
  assert.equal(getKisEodObservationWindow("2026-12-31T15:01:00.000Z", "15:40").referenceDate, "2027-01-01");
  assert.equal(getKisEodObservationWindow("2026-12-31T15:01:00.000Z", "15:40").reason, "BEFORE_MARKET_CLOSE");
});

test("slot start windows are inclusive at slot and exclusive at five minutes", () => {
  assert.equal(getKisEodObservationWindow("2026-10-08T06:39:59.999Z", "15:40").reason, "BEFORE_SLOT");
  assert.equal(getKisEodObservationWindow(stamp, "15:40").status, "READY");
  assert.equal(getKisEodObservationWindow("2026-10-08T06:44:59.999Z", "15:40").delayMs, 299999);
  assert.equal(getKisEodObservationWindow("2026-10-08T06:45:00.000Z", "15:40").reason, "MISSED_SLOT_WINDOW");
  assert.equal(getKisEodObservationWindow(stamp, "16:00").reason, "INVALID_SLOT");
});

test("dry-run does not request credentials, network, wait, or write runtime", async (t) => {
  const root = await sandbox(t), provider = fixture();
  const results = await run(root, provider, { collectPrivate: false, waitForSlots: true, slot: null, wait: () => { throw new Error("must not wait"); } });
  assert.equal(results[0].status, "DRY_RUN_READY"); assert.equal(results[0].networkRequests, 0); assert.equal(results[0].filesWritten, 0);
  assert.equal(provider.calls.calendar, 0); assert.deepEqual(provider.calls.histories, []);
  await assert.rejects(fs.access(path.join(root, ".runtime")), { code: "ENOENT" });
});

test("collection must have an exact independent true gate", async (t) => {
  const root = await sandbox(t), provider = fixture();
  for (const observationEnabled of [null, "", "false", "TRUE", true]) assert.equal((await run(root, provider, { observationEnabled }))[0].reason, "OBSERVATION_NOT_ENABLED");
  assert.equal(provider.calls.calendar, 0); await assert.rejects(fs.access(path.join(root, ".runtime")), { code: "ENOENT" });
});

test("early, weekend, missed or undesignated executions cannot make source requests", async (t) => {
  const root = await sandbox(t), provider = fixture();
  for (const [now, reason] of [["2026-10-08T06:29:59Z", "BEFORE_MARKET_CLOSE"], ["2026-10-08T06:39:59Z", "BEFORE_SLOT"], ["2026-10-08T06:45:00Z", "MISSED_SLOT_WINDOW"], ["2026-10-10T06:40:00Z", "WEEKEND"]]) {
    const result = (await run(root, provider, { now: () => now }))[0]; assert.equal(result.reason, reason); assert.equal(result.status, "PENDING");
  }
  assert.equal((await run(root, provider, { slot: "16:00" }))[0].reason, "INVALID_SLOT");
  assert.equal(provider.calls.calendar, 0); assert.deepEqual(provider.calls.histories, []);
  await assert.rejects(fs.access(path.join(root, ".runtime")), { code: "ENOENT" });
});

test("waiting prewarm is bounded and cannot wait from an arbitrary morning", async (t) => {
  const root = await sandbox(t), provider = fixture();
  const result = await run(root, provider, { slot: null, waitForSlots: true, now: () => "2026-10-08T01:00:00Z", wait: () => { throw new Error("must not wait"); } });
  assert.equal(result[0].reason, "BEFORE_MARKET_CLOSE"); assert.equal(result[0].maximumPrewarmMinutes, 30); assert.equal(provider.calls.calendar, 0);
});

test("same-runner actual-clock waiting observes each distinct slot and compares normalized source hashes", async (t) => {
  const root = await sandbox(t); let current = Date.parse("2026-10-08T06:25:00.000Z");
  const now = () => current, telemetry = [], waits = [], callbacks = [], provider = fixture({ now, telemetry });
  const results = await run(root, provider, { now, telemetry, slot: null, waitForSlots: true,
    wait: async (milliseconds) => { waits.push(milliseconds); current += milliseconds; }, onResult: (result) => callbacks.push(result) });
  assert.deepEqual(results.map((result) => result.status), ["OBSERVED", "OBSERVED", "OBSERVED"]);
  assert.deepEqual(results.map((result) => result.observedStartedAt), ["2026-10-08T06:40:00.000Z", "2026-10-08T07:10:00.000Z", "2026-10-08T07:40:00.000Z"]);
  assert.ok(waits.every((milliseconds) => milliseconds > 0 && milliseconds <= 30000));
  assert.equal(provider.calls.calendar, 1); assert.equal(provider.calls.histories.length, 9); assert.equal(callbacks.length, 3);
  assert.deepEqual(results.map((result) => result.unchangedCount), [0, 3, 3]);
  const second = (await artifacts(root, "1610"))[0].value;
  assert.equal(second.comparisons[0].status, "UNCHANGED"); assert.ok(second.comparisons[0].previousArtifactHash);
  assert.equal(second.observations[0].metadata.dateFieldComplete, true); assert.equal(second.observations[0].metadata.adjustmentFlag, "1");
  assert.equal(second.observations[0].metadata.historyComplete, false);
  assert.equal(second.sourceFinality, "NOT_CONFIRMED"); assert.equal(second.publicationEligible, false);
});

test("different real receipt timestamps do not change data or deterministic metadata hashes", async (t) => {
  const root = await sandbox(t), first = fixture(); await run(root, first);
  const later = "2026-10-08T07:10:02.000Z", second = fixture({ now: () => later });
  const result = (await run(root, second, { slot: "16:10", now: () => later }))[0];
  assert.equal(result.delayMs, 2000); assert.equal(result.unchangedCount, 3);
  const a = (await artifacts(root))[0].value, b = (await artifacts(root, "1610"))[0].value;
  assert.notEqual(a.artifactHash, b.artifactHash); assert.notEqual(a.observations[0].receivedAt, b.observations[0].receivedAt);
  assert.equal(a.observations[0].dataHash, b.observations[0].dataHash); assert.equal(a.observations[0].metadataHash, b.observations[0].metadataHash);
});

test("past retention failures occur after all actual slots and cannot suppress today's collection", async (t) => {
  const root = await sandbox(t); let current = Date.parse("2026-10-08T06:25:00.000Z");
  const now = () => current, provider = fixture({ now }), store = fixtureStore(), emitted = [];
  store.auditDay = async () => { assert.equal(provider.calls.histories.length, 9); throw new Error("PAST_PRIVATE_STORE_ERROR"); };
  const results = await run(root, provider, { durableStore: store, now, slot: null, waitForSlots: true,
    wait: async (ms) => { current += ms; }, onResult: (value) => { emitted.push(value); } });
  assert.deepEqual(results.slice(0, 3).map((value) => value.status), ["OBSERVED", "OBSERVED", "OBSERVED"]);
  assert.equal(results[3].reason, "PRIVATE_RETENTION_AUDIT_FAILED"); assert.equal(emitted.length, 4);
  const first = (await artifacts(root))[0].value;
  assert.equal(first.executionStartedAt, "2026-10-08T06:25:00.000Z");
  assert.equal(first.observedStartedAt, stamp); assert.equal(first.executionStartBasis, "NODE_PROCESS_CLOCK");
  assert.equal(first.runnerBootstrapStartBasis, "FIRST_WORKFLOW_STEP_CLOCK_NOT_GITHUB_JOB_CREATED_AT");
  assert.ok(!JSON.stringify(results).includes("PAST_PRIVATE_STORE_ERROR"));
});

test("a changed later bar is compared and never overwrites its earlier private version", async (t) => {
  const root = await sandbox(t); await run(root, fixture());
  const previous = (await artifacts(root))[0], before = JSON.stringify(previous.value), later = "2026-10-08T07:10:00.000Z";
  const result = (await run(root, fixture({ now: () => later, changedTicker: "064290" }), { slot: "16:10", now: () => later }))[0];
  assert.equal(result.changedCount, 1); assert.equal(result.unchangedCount, 2);
  assert.equal(JSON.stringify((await artifacts(root))[0].value), before);
  const changed = (await artifacts(root, "1610"))[0].value.comparisons.find((entry) => entry.ticker === "064290");
  assert.equal(changed.status, "CHANGED"); assert.equal(changed.metadataChanged, false);
  assert.equal(await fs.readFile(path.join(root, "data", "history", "frozen.json"), "utf8"), "FROZEN_OFFICIAL_DATA\n");
});

test("completed slot skips duplicate execution both within and after its original window", async (t) => {
  const root = await sandbox(t); await run(root, fixture());
  const before = await artifacts(root), provider = fixture();
  assert.equal((await run(root, provider))[0].status, "SKIPPED");
  assert.equal((await run(root, provider, { now: () => "2026-10-08T07:40:00.000Z" }))[0].reason, "ALREADY_OBSERVED");
  assert.equal(provider.calls.calendar, 0); assert.deepEqual(provider.calls.histories, []); assert.deepEqual(await artifacts(root), before);
});

test("partial failures retain immutable attempts and same-window retry can complete", async (t) => {
  const root = await sandbox(t), telemetry = [], bad = fixture({ failTicker: "000660", telemetry });
  const first = (await run(root, bad, { telemetry }))[0];
  assert.equal(first.status, "PARTIAL"); assert.equal(first.collectedCount, 2); assert.equal(first.failedCount, 1); assert.equal(first.requestSummary.http429, 1);
  const old = (await artifacts(root))[0];
  assert.ok(!JSON.stringify(old.value).includes("PRIVATE_BODY_MUST_NOT_LEAK"));
  const second = (await run(root, fixture()))[0]; assert.equal(second.status, "OBSERVED");
  const all = await artifacts(root); assert.equal(all.length, 2); assert.ok(all.some((entry) => entry.name === old.name && JSON.stringify(entry.value) === JSON.stringify(old.value)));
  assert.notEqual(all[0].value.artifactHash, all[1].value.artifactHash);
});

test("lock prevents parallel duplicate source calls; stale locks require operator recovery", async (t) => {
  const root = await sandbox(t), directory = path.join(root, ".runtime", "kis-eod", "observations", date, "1540");
  await fs.mkdir(directory, { recursive: true }); await fs.writeFile(path.join(directory, "active.lock"), "");
  const provider = fixture(), result = (await run(root, provider))[0];
  assert.equal(result.reason, "SLOT_LOCKED"); assert.equal(provider.calls.calendar, 0); await fs.access(path.join(directory, "active.lock"));
});

test("closed and unknown exact-date calendars do not collect bars", async (t) => {
  for (const calendar of [false, null]) {
    const root = await sandbox(t), provider = fixture({ calendar });
    const result = (await run(root, provider))[0];
    assert.equal(result.status, "PENDING"); assert.equal(result.reason, calendar === false ? "MARKET_CLOSED" : "CALENDAR_UNKNOWN");
    assert.deepEqual(provider.calls.histories, []); assert.equal((await artifacts(root))[0].value.calendarEvidence.finality, "CALENDAR_ONLY_NOT_BAR_FINALITY");
  }
});

test("calendar rejects inconsistent flags, previous dates and future timestamps", async (t) => {
  for (const mutate of [value => { value.sourceFields.bass_dt = "20261007"; }, value => { value.sourceFields.opnd_yn = "N"; value.sourceFields.tr_day_yn = "N"; }, value => { value.receivedAt = "2026-10-08T06:40:01.000Z"; }]) {
    const root = await sandbox(t), provider = fixture(), original = provider.getTradingDay;
    provider.getTradingDay = async (...args) => { const value = await original(...args); mutate(value); return value; };
    assert.equal((await run(root, provider))[0].reason, "CALENDAR_REQUEST_FAILED"); assert.deepEqual(provider.calls.histories, []);
  }
});

test("crossing a slot window does not request late tickers or represent them as observations", async (t) => {
  const root = await sandbox(t); let current = Date.parse(stamp); const now = () => current;
  const provider = fixture({ now, onHistory: () => { current = Date.parse("2026-10-08T06:45:00.000Z"); } });
  const result = (await run(root, provider, { now }))[0];
  assert.equal(result.status, "PARTIAL"); assert.equal(result.collectedCount, 1); assert.equal(result.pendingCount, 2); assert.deepEqual(provider.calls.histories, ["005930"]);
  const stored = (await artifacts(root))[0].value;
  assert.equal(stored.observations[1].reason, "MISSED_SLOT_WINDOW"); assert.equal(stored.observations[1].rows, undefined);
});

test("future or wrong-date source timestamps fail closed instead of accepting fake observations", async (t) => {
  const root = await sandbox(t), provider = fixture(), original = provider.getHistory;
  provider.getHistory = async (...args) => { const value = await original(...args); value.receivedAt = "2026-10-08T07:40:00.000Z"; return value; };
  const result = (await run(root, provider))[0]; assert.equal(result.status, "FAILED"); assert.equal(result.collectedCount, 0);
  assert.ok((await artifacts(root))[0].value.observations.every((entry) => entry.reason === "KIS_EOD_OBSERVATION_HISTORY_INVALID"));
});

test("safe telemetry and error codes use hard allowlists, never arbitrary exception contents", async (t) => {
  const root = await sandbox(t), telemetry = [], provider = fixture({ telemetry });
  provider.getHistory = async () => { telemetry.push({ component: "kis-eod-provider", operation: "inquire-daily-itemchartprice", status: "ATTEMPT_FAILURE", reason: "KIS_PRIVATE_SECRET", businessCode: "PRIVATE_BODY_MUST_NOT_LEAK", message: "PRIVATE_BODY_MUST_NOT_LEAK", url: "https://secret.invalid" }); const error = new Error("PRIVATE_BODY_MUST_NOT_LEAK"); error.code = "KIS_PRIVATE_SECRET"; throw error; };
  const result = (await run(root, provider, { telemetry }))[0], privateResult = (await artifacts(root))[0].value;
  assert.ok(!JSON.stringify(result).includes("PRIVATE")); assert.ok(!JSON.stringify(privateResult).includes("PRIVATE_BODY_MUST_NOT_LEAK")); assert.ok(!JSON.stringify(privateResult).includes("KIS_PRIVATE_SECRET"));
  assert.equal(privateResult.observations[0].reason, "KIS_EOD_OBSERVATION_SOURCE_FAILED");
  const safe = sanitizeKisEodObservationEvent({ component: "kis-eod-provider", operation: "inquire-daily-itemchartprice", status: "SUCCESS", requestStartedAt: stamp, receivedAt: stamp, attempt: 1, httpStatus: 200, businessCode: "SUCCESS", secret: "PRIVATE_BODY_MUST_NOT_LEAK" });
  assert.equal(safe.secret, undefined); assert.equal(safe.businessCode, "SUCCESS");
});

test("provider transport timestamps and retry events integrate without double-counting requests", async (t) => {
  const root = await sandbox(t); let current = Date.parse(stamp), failed = false; const telemetry = [], now = () => current;
  const client = { async request(url) {
    current += 1;
    if (url.includes("chk-holiday")) return new Response(JSON.stringify({ rt_cd: "0", output: [{ bass_dt: "20261008", opnd_yn: "Y", tr_day_yn: "Y" }] }));
    if (!failed) { failed = true; return new Response(JSON.stringify({ rt_cd: "1", msg_cd: "EGW00201", msg1: "PRIVATE_BODY_MUST_NOT_LEAK" })); }
    const ticker = new URL(url).searchParams.get("FID_INPUT_ISCD");
    return new Response(JSON.stringify({ rt_cd: "0", output1: { stck_shrn_iscd: ticker }, output2: [{ stck_bsop_date: "20261008", stck_oprc: "95", stck_hgpr: "110", stck_lwpr: "90", stck_clpr: "100", acml_vol: "1000", acml_tr_pbmn: "100000", prdy_ctrt: "1", prdy_vrss: "1", prdy_vrss_sign: "2" }] }));
  } };
  const provider = createKisEodProvider({ client, now, delayMs: 0, wait: async (milliseconds) => { current += milliseconds; }, logger: (event) => telemetry.push(event) });
  const result = (await run(root, provider, { now, telemetry }))[0];
  assert.equal(result.status, "OBSERVED"); assert.equal(result.requestSummary.attempts, 5); assert.equal(result.requestSummary.failedAttempts, 1); assert.equal(result.requestSummary.retryableFailures, 1); assert.equal(result.requestSummary.rateLimitBusinessFailures, 1);
  const stored = (await artifacts(root))[0].value; assert.equal(stored.observations[0].requestTimestampBasis, "PROVIDER_HISTORY_INVOCATION");
  assert.ok(stored.observations[0].requestEvents.every((event) => !JSON.stringify(event).includes("PRIVATE_BODY_MUST_NOT_LEAK")));
});

test("CLI has no fake clock, historical date, publication or force options", () => {
  assert.deepEqual(parseKisEodObservationArgs([]), { collectPrivate: false, waitForSlots: false, slot: null });
  assert.deepEqual(parseKisEodObservationArgs(["--collect-private", "--slot=16:10"]), { collectPrivate: true, waitForSlots: false, slot: "16:10" });
  for (const args of [["--now=2026-10-08T06:40:00Z"], ["--date=2026-10-08"], ["--publish"], ["--force"], ["--slot=16:00"], ["--dry-run", "--collect-private"], ["--wait-for-slots", "--slot=16:10"], ["--collect-private", "--collect-private"]]) assert.equal(parseKisEodObservationArgs(args), null);
  const output = spawnSync(process.execPath, ["scripts/observe-kis-eod.mjs", "--now=2026-10-08T06:40:00Z"], { cwd: new URL("../", import.meta.url), encoding: "utf8" });
  assert.equal(output.status, 1); assert.match(output.stdout, /INVALID_CLI_ARGUMENTS/u); assert.doesNotMatch(output.stdout, /2026-10-08T06:40/u);
});

test("prepared observation workflow is statically unarmed, read-only and preserves all slots in one job", async () => {
  const text = await fs.readFile(new URL("../.github/workflows/kis-eod-observation.yml", import.meta.url), "utf8"), workflow = yaml.load(text), job = workflow.jobs.observe;
  assert.deepEqual(workflow.permissions, { contents: "read" }); assert.deepEqual(Object.keys(workflow.jobs), ["observe"]);
  assert.equal(workflow.on.schedule[0].cron, "25 6 * * 1-5"); assert.match(job.if, /false && vars[.]KIS_EOD_OBSERVATION_ENABLED == 'true'/u);
  assert.match(job.if, /inputs[.]mode == 'dry-run'/u); assert.equal(job["timeout-minutes"], 90);
  assert.equal(job.steps.find((step) => step.uses === "actions/checkout@v4").with["persist-credentials"], false);
  assert.match(text, /--collect-private --wait-for-slots/u); assert.match(text, /exact hash readback before completion/u);
  assert.match(text, /secrets[.]KIS_OBSERVATION_STORE_TOKEN/u); assert.match(text, /--storage-preflight/u);
  assert.doesNotMatch(text, /actions\/(?:cache|upload-artifact)|git\s+(?:add|commit|push)|--(?:publish|force|now|date)\b/u);
  assert.doesNotMatch(text, /data\/(?:history|model-history|intraday)|KIS_EOD_OBSERVATION_ENABLED:\s*(?:true|"true"|'true')/u);
  assert.equal(workflow.concurrency.group, "kis-eod-private-three-slot-observation-main");
});
