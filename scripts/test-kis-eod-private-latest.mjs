import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import fs from "node:fs/promises";
import { selectLatestClosedKisDate, runPrivateLatest } from "./run-kis-eod-private-latest.mjs";
import { memoryPrivateStore, modelFixture } from "./test-kis-eod-private-models.mjs";
import { persistPrivateModelBundle, queryLatestPrivateModelTop } from "../lib/kis-eod-private-models.mjs";
import { sha256Canonical } from "../lib/snapshot-quality-pipeline.mjs";
import { verifyRemotePrivateTop } from "./verify-kis-eod-private-remote-top.mjs";
import { createPrivateTopServer } from "./serve-kis-eod-private-top.mjs";
import { createPrivateAuthFetch } from "../lib/kis-private-auth-fetch.mjs";

const now = () => "2026-10-09T08:00:00.000Z";
test("private token issuance retry is one bounded 65s retry for EGW00133 only", async () => {
  const endpoint = "https://openapi.koreainvestment.com:9443/oauth2/tokenP";
  for (const code of ["EGW00133", "EGW00102"]) {
    let calls = 0; const waits = [];
    const transport = createPrivateAuthFetch({ wait: async (ms) => waits.push(ms), fetchImpl: async () => {
      calls += 1; return calls === 1 ? Response.json({ error_code: code }, { status: 403 }) : Response.json({ access_token: "FIXTURE_ONLY" });
    } });
    const response = await transport(endpoint, { method: "POST" });
    assert.equal(calls, code === "EGW00133" ? 2 : 1); assert.deepEqual(waits, code === "EGW00133" ? [65000] : []);
    assert.equal(response.status, code === "EGW00133" ? 200 : 403);
  }
  let calls = 0;
  const exhausted = createPrivateAuthFetch({ wait: async () => {}, fetchImpl: async () => { calls += 1; return Response.json({ error_code: "EGW00133" }, { status: 403 }); } });
  assert.equal((await exhausted(endpoint, { method: "POST" })).status, 403); assert.equal(calls, 2);
  calls = 0; await exhausted("https://openapi.koreainvestment.com:9443/other", { method: "GET" }); assert.equal(calls, 1);
});
const providerFor = (openDate) => ({ async getTradingDay(date) { const open = date === openDate;
  return { source: "KIS", operation: "chk-holiday", referenceDate: date, receivedAt: now(), isTradingDay: open,
    sourceFields: { bass_dt: date.replaceAll("-", ""), opnd_yn: open ? "Y" : "N", tr_day_yn: open ? "Y" : "N" } }; } });
function researchFixture(date) {
  const { candidate } = modelFixture(date, 25);
  const raw = { namespace: "kis-private-model-research-inputs", referenceDate: date, fixtureOnly: true };
  const research = { namespace: "kis-eod-private-research-models", observationType: "HISTORICAL_RESEARCH_REQUEST", referenceDate: date,
    collectionStartedAt: "2026-10-09T07:00:00Z", collectionCompletedAt: "2026-10-09T07:10:00Z",
    records: candidate.records, modelFormulaHashes: candidate.modelFormulaHashes, inputHash: sha256Canonical(raw),
    sourceFinality: "NOT_CONFIRMED", publicationEligible: false };
  return { raw, research, summary: { rankingCounts: Object.fromEntries(Object.keys(candidate.rankingUniverse).map((version) => [version, 25])) } };
}
test("latest selection is exact-calendar bounded, no date guessing or preclose requests", async () => {
  const calls = [], provider = providerFor("2026-10-08"), original = provider.getTradingDay;
  provider.getTradingDay = async (date) => { calls.push(date); return original(date); };
  assert.equal((await selectLatestClosedKisDate(provider, now)).referenceDate, "2026-10-08");
  assert.deepEqual(calls, ["2026-10-09", "2026-10-08"]);
  calls.length = 0;
  assert.equal((await selectLatestClosedKisDate(provider, () => "2026-10-09T06:29:59Z")).reason, "BEFORE_MARKET_CLOSE");
  assert.equal(calls.length, 0);
  provider.getTradingDay = async (date) => date === "2026-10-09" ? { ...await original(date), isTradingDay: null, sourceFields: { bass_dt: "20261009", opnd_yn: "N", tr_day_yn: "Y" } } : original(date);
  assert.equal((await selectLatestClosedKisDate(provider, now)).referenceDate, "2026-10-08");
  provider.getTradingDay = async (date) => ({ ...await original(date), isTradingDay: null, sourceFields: { bass_dt: date.replaceAll("-", ""), opnd_yn: "Y", tr_day_yn: "N" } });
  assert.equal((await selectLatestClosedKisDate(provider, now)).reason, "CALENDAR_UNKNOWN");
  assert.equal((await selectLatestClosedKisDate(providerFor("never"), now)).reason, "LATEST_TRADING_DAY_NOT_FOUND");
});
test("holiday catch-up uses strict original audit, remote research head, idempotent query and real receipt times", async () => {
  const store = memoryPrivateStore(), bundle = researchFixture("2026-10-08"); let calls = 0;
  const options = { root: process.cwd(), now, enabled: "true", collectPrivate: true, store, provider: providerFor("2026-10-08"),
    audit: async () => { calls += 1; return { referenceDate: "2026-10-08", requestedCount: 25, attemptedCount: 25, collectedCount: 25,
      failedCount: 0, quarantineCount: 0, failures: [], unattemptedCount: 0, privateReportPath: ".runtime/kis-eod/audits/2026-10-08/hash/attempts/run/report.json" }; },
    replay: async ({ directory }) => { assert.match(directory.replaceAll("\\", "/"), /audits\/2026-10-08\/hash$/u); return bundle; },
    runCurrent: async () => { throw new Error("MUST_NOT_SPOOF_LIVE"); } };
  assert.equal((await runPrivateLatest(options)).status, "PRIVATE_STORED_AND_VERIFIED");
  assert.equal((await runPrivateLatest(options)).status, "ALREADY_STORED"); assert.equal(calls, 1);
  const result = await queryLatestPrivateModelTop(store);
  assert.equal(result.dataMode, "kisPrivate-research"); assert.equal(result.collectedAt, bundle.research.collectionCompletedAt);
  assert.ok(![...store.files.keys()].some((key) => key.includes("model-top/live/heads")));
  const verified = await verifyRemotePrivateTop(store);
  assert.equal(verified.httpQueryCount, 15); assert.equal(verified.unauthenticatedStatus, 401);
  await assert.rejects(verifyRemotePrivateTop(store, "2026-10-09"), /EXPECTED_DATE_MISMATCH/u);
});
test("today stays today's collector; unavailable bars do not fall back to an earlier day", async () => {
  const store = memoryPrivateStore(); let auditCalls = 0;
  const result = await runPrivateLatest({ now, enabled: "true", collectPrivate: true, store, provider: providerFor("2026-10-09"),
    audit: async () => { auditCalls += 1; }, runCurrent: async () => ({ status: "PENDING", reason: "CURRENT_DATE_BARS_NOT_AVAILABLE" }) });
  assert.equal(result.reason, "CURRENT_DATE_BARS_NOT_AVAILABLE"); assert.equal(auditCalls, 0);
  assert.equal((await queryLatestPrivateModelTop(store)).status, "DATA_ACCUMULATING");
});
test("latest selects one namespace without score mixing and refuses corrupted prior data", async () => {
  const store = memoryPrivateStore();
  await persistPrivateModelBundle({ store, ...modelFixture("2026-10-08", 25) });
  await persistPrivateModelBundle({ store, ...researchFixture("2026-10-07"), mode: "research" });
  assert.equal((await queryLatestPrivateModelTop(store)).dataMode, "kisPrivate-live");
  await persistPrivateModelBundle({ store, ...researchFixture("2026-10-09"), mode: "research" });
  assert.equal((await queryLatestPrivateModelTop(store)).referenceDate, "2026-10-09");
  assert.throws(() => createPrivateTopServer({ store }), /ACCESS_TOKEN_REQUIRED/u);
});
test("manual authorization never arms scheduled collection; independent readback has no KIS secret", async () => {
  const yaml = createRequire(import.meta.url)("js-yaml");
  const text = await fs.readFile(new URL("../.github/workflows/kis-eod-private-models.yml", import.meta.url), "utf8"), workflow = yaml.load(text);
  assert.match(workflow.jobs.collect.if, /false &&/u);
  assert.match(workflow.jobs.collect.env.KIS_EOD_COLLECTION_ENABLED, /workflow_dispatch.*private-collect/u);
  assert.equal(workflow.jobs["verify-retention"].needs, "collect");
  assert.ok(!Object.keys(workflow.jobs["verify-retention"].env).some((key) => key.startsWith("KIS_APP")));
  assert.deepEqual(workflow.on.schedule.map((item) => item.cron), ["40 6 * * 1-5", "10,40 7-11 * * 1-5"]);
  assert.doesNotMatch(text, /upload-artifact|git\s+(?:add|commit|push)/u);
});
