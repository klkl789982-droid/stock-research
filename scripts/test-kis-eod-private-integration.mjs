import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { runPrivateKisModels, classifyPrivateCollectionResult } from "./run-kis-eod-private-models.mjs";
import { preflightPrivateIntegration } from "./preflight-kis-eod-private-integration.mjs";
import { memoryPrivateStore, modelFixture } from "./test-kis-eod-private-models.mjs";
import { createLocalPrivateModelStore } from "../lib/kis-eod-private-local-store.mjs";

const yaml = createRequire(import.meta.url)("js-yaml");
test("prior-date and partly available current bars are distinguished without manufacturing a date", () => {
  assert.deepEqual(classifyPrivateCollectionResult({ status: "FAILED", collectedCount: 0, failures: [{ reason: "KIS_EOD_REFERENCE_DATE_MISSING" }] }), { status: "PENDING", reason: "CURRENT_DATE_BARS_NOT_AVAILABLE" });
  assert.deepEqual(classifyPrivateCollectionResult({ status: "VALIDATED", collectedCount: 12, failures: [{ reason: "KIS_EOD_REFERENCE_DATE_MISSING" }] }), { status: "PENDING", reason: "PARTIAL_LATEST_DATE_AVAILABILITY" });
  assert.equal(classifyPrivateCollectionResult({ failures: [{ reason: "KIS_EOD_RATE_LIMITED" }] }).reason, "KIS_RATE_LIMIT_RETRY_NEXT_RUN");
});
test("actual-day selection distinguishes pre-close, weekends, old/partial bars and closed calendar", async () => {
  for (const [now, reason] of [["2026-10-08T06:29:59Z", "BEFORE_MARKET_CLOSE"], ["2026-10-10T07:00:00Z", "WEEKEND"]]) {
    let calls = 0;
    const result = await runPrivateKisModels({ now: () => now, store: memoryPrivateStore(), collectPrivate: true, enabled: "true", runCollector: async () => { calls += 1; } });
    assert.equal(result.reason, reason); assert.equal(calls, 0);
  }
  for (const reason of ["MARKET_CLOSED", "CALENDAR_UNKNOWN", "PARTIAL_COLLECTION_RETRY_REQUIRED", "NO_VALID_MODEL_INPUTS"]) {
    const store = memoryPrivateStore();
    const result = await runPrivateKisModels({ now: () => "2026-10-08T07:00:00Z", store, collectPrivate: true, enabled: "true",
      runCollector: async () => ({ status: "PENDING", reason }) });
    assert.equal(result.reason, reason); assert.ok(![...store.files.keys()].some((key) => key.includes("/heads/")));
  }
});

test("full integrated fixture collects, stores, queries and skips a duplicate date", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "kis-private-integration-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const folder = path.join(root, ".runtime", "kis-eod"); await fs.mkdir(folder, { recursive: true });
  const bundle = modelFixture("2026-10-08", 553);
  await fs.writeFile(path.join(folder, "candidate.json"), JSON.stringify(bundle.candidate));
  await fs.writeFile(path.join(folder, "raw.json"), JSON.stringify(bundle.raw));
  const store = memoryPrivateStore(); let calls = 0;
  const options = { root, now: () => "2026-10-08T07:00:00Z", collectPrivate: true, enabled: "true", store,
    runCollector: async () => { calls += 1; return { status: "VALIDATED", reason: "PRIVATE_CANDIDATE_READY", collectionComplete: true,
      rawPath: ".runtime/kis-eod/raw.json", candidatePath: ".runtime/kis-eod/candidate.json" }; } };
  assert.equal((await runPrivateKisModels(options)).status, "PRIVATE_STORED_AND_VERIFIED");
  assert.equal((await runPrivateKisModels(options)).status, "ALREADY_STORED"); assert.equal(calls, 1);
});

test("dry-run, disabled collection and unavailable storage never authenticate KIS", async () => {
  let calls = 0;
  assert.equal((await runPrivateKisModels({ collectPrivate: true, enabled: "false", runCollector: async () => { calls += 1; } })).status, "BLOCKED");
  const store = memoryPrivateStore(); store.preflight = async () => { throw new Error("PRIVATE_ERROR"); };
  assert.equal((await runPrivateKisModels({ collectPrivate: true, enabled: "true", store, runCollector: async () => { calls += 1; } })).status, "BLOCKED");
  assert.equal(calls, 0);
});

test("price-free activation preflight validates real binding contracts without fake slot records", async () => {
  const store = memoryPrivateStore(), calls = [], now = "2026-10-09T10:00:00.000Z";
  const provider = { async getTradingDay(date) { return { isTradingDay: true, referenceDate: date, sourceFields: { bass_dt: date.replaceAll("-", ""), opnd_yn: "Y", tr_day_yn: "Y" } }; },
    async getHistory(ticker, date) {
      calls.push(ticker);
      return { adjustment: "unadjusted", marketDivision: "J", requestedAt: now, receivedAt: now,
        symbolMapping: { status: "VERIFIED_RESPONSE_TICKER", requestedCode: ticker, responseCode: ticker },
        rows: [{ basDt: date.replaceAll("-", ""), mkp: 100, hipr: 110, lopr: 90, clpr: 105, trqu: 1000, trPrc: 105000 }] };
    } };
  const options = { store, provider, now: () => now, env: { KIS_APP_KEY: "FIXTURE", KIS_APP_SECRET: "FIXTURE", GITHUB_RUN_ID: "1", GITHUB_RUN_ATTEMPT: "1" },
    verifyStorage: async () => ({ status: "VERIFIED", sha256: "a".repeat(64) }), loadInputs: async () => ({ officialSnapshot: { asOfDate: "2026-10-08" } }) };
  const result = await preflightPrivateIntegration(options);
  assert.equal(result.status, "READY"); assert.deepEqual(calls, ["005930", "000660", "064290"]);
  assert.equal(result.designatedSlotObservationsCreated, 0); assert.equal(result.sourcePricesIncluded, false);
  assert.ok(![...store.files.keys()].some((key) => key.includes("journal") || key.includes("/heads/")));
  provider.getTradingDay = async () => ({ isTradingDay: null });
  await assert.rejects(preflightPrivateIntegration(options), { code: "KIS_CALENDAR_NOT_VERIFIED" });
});

test("full schedule remains unarmed; preflight cannot publish or upload raw data", async () => {
  const fullText = await fs.readFile(new URL("../.github/workflows/kis-eod-private-models.yml", import.meta.url), "utf8"), full = yaml.load(fullText);
  assert.match(full.jobs.collect.if, /false && vars[.]KIS_EOD_COLLECTION_ENABLED/u);
  assert.equal(full.concurrency.group, "kis-provisional-eod-main"); assert.deepEqual(full.permissions, { contents: "read" });
  const text = await fs.readFile(new URL("../.github/workflows/kis-eod-private-integration-preflight.yml", import.meta.url), "utf8"), preflight = yaml.load(text);
  assert.deepEqual(preflight.permissions, { contents: "read" });
  assert.ok(preflight.on.push.paths.includes("scripts/preflight-kis-eod-private-integration.mjs"));
  assert.ok(preflight.on.push.paths.every((item) => /(?:kis-eod-private|kis-eod-private-top)/u.test(item)));
  for (const content of [text, fullText]) assert.doesNotMatch(content, /upload-artifact|git\s+(?:add|commit|push)|--(?:date|now|publish|force)\b/u);
});

test("local private persistence is create-only and rejects path escape, changed bytes and secrets", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "kis-private-local-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = createLocalPrivateModelStore(root), key = "model-top/fixture/probe.json";
  const written = await store.writeImmutable(key, { fixtureOnly: true });
  assert.equal((await store.read(key)).contentHash, written.contentHash);
  assert.equal((await store.writeImmutable(key, { fixtureOnly: true })).status, "ALREADY_STORED");
  await assert.rejects(store.writeImmutable(key, { fixtureOnly: false }), { code: "PRIVATE_STORE_IMMUTABLE_CONFLICT" });
  await assert.rejects(store.read("../outside.json"), { code: "PRIVATE_LOCAL_STORE_INVALID" });
  await assert.rejects(store.writeImmutable("probe.json", { token: "NOT_ALLOWED" }), { code: "PRIVATE_STORE_SECRET_REJECTED" });
});
