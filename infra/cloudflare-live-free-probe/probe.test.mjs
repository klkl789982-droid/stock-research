import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { fixture, calculateFixture, summarize, shards, budget, VERSIONS, verifyObservationWindow, fetchWithoutRedirects } from "./core.mjs";
import { calculateIntradayModelTopScores } from "../../lib/intraday-model-top-official-signal.mjs";
import { mergeProvisionalCandle } from "../../lib/intraday-model-b-official-signal.mjs";

test("all 553 synthetic inputs use unchanged model imports and preserve every score across sharding", () => {
  const direct = Array.from({ length: 553 }, (_, i) => {
    const f = fixture(i);
    const scores = calculateIntradayModelTopScores(mergeProvisionalCandle(f.rows, f.quote), f.quote).scores;
    return { index: i, scores };
  });
  const divided = shards(553).flatMap(shard => Array.from({ length: shard.count }, (_, i) => calculateFixture(shard.start + i)));
  assert.deepEqual(divided, direct); assert.deepEqual(summarize(divided), summarize(direct));
  assert.equal(Object.keys(summarize(divided).top5).length, VERSIONS.length);
});
test("budgets expose full universe, shared rate floor, steps and unknown production readiness", () => {
  const b = budget(); assert.equal(b.collectionRequests, 1020); assert.equal(b.workflowShards, 64);
  assert.equal(b.rateFloorSeconds, 204); assert.ok(b.workflowSteps < 3000); assert.equal(b.productionReady, false);
  assert.equal(shards(553).length, 70); assert.throws(() => shards(0)); assert.throws(() => shards(554));
  assert.throws(() => shards(508, 9)); assert.throws(() => summarize([calculateFixture(0), calculateFixture(0)]));
  assert.throws(() => budget({ retryRequests: -1 })); assert.throws(() => budget({ eligible: 553, universe: 508 }));
  assert.ok(b.brokerConservativeSqlReads < 5000000); assert.ok(b.brokerConservativeSqlWrites < 100000);
  assert.ok(b.brokerActiveGBSecondsForSixMinutes < 13000); assert.ok(b.retainedWorkflowUpperBoundBytes < 1000000000);
});
test("isolated deployment has no cron, credentials, public endpoint or production writes", async () => {
  const config = JSON.parse(await fs.readFile(new URL("./wrangler.jsonc", import.meta.url), "utf8"));
  assert.equal(config.workers_dev, false); assert.equal(config.preview_urls, false); assert.deepEqual(config.triggers.crons, []);
  assert.equal(config.vars.LIVE_ENABLED, "false"); assert.equal(config.secrets, undefined);
  assert.equal(config.workflows.length, 1); assert.equal(config.migrations[0].new_sqlite_classes[0], "SyntheticBroker");
});
test("partitioning never widens 14:00-14:05 or rewrites actual exchange/request/response time", () => {
  const evidence = { requestedAt: "2026-10-19T05:00:01.000Z", receivedAt: "2026-10-19T05:00:01.500Z", asOfDate: "2026-10-19", asOfTime: "14:00:01" };
  assert.equal(verifyObservationWindow("2026-10-19", evidence), evidence);
  for (const patch of [{ requestedAt: "2026-10-19T04:59:59.999Z" }, { receivedAt: "2026-10-19T05:05:00.001Z" },
    { asOfDate: "2026-10-16" }, { asOfTime: "14:05:01" }, { asOfTime: "14:00:02" }]) {
    assert.throws(() => verifyObservationWindow("2026-10-19", { ...evidence, ...patch }), /WINDOW_REJECTED/u);
  }
});
test("edge adapter rejects redirects and unverifiable statuses without weakening credential forwarding", async () => {
  let options;
  await fetchWithoutRedirects("https://synthetic", { redirect: "error" }, async (_url, init) => { options = init; return new Response(null, { status: 200 }); });
  assert.equal(options.redirect, "manual");
  for (const status of [301, 302, 307, 308]) await assert.rejects(fetchWithoutRedirects("https://synthetic", {}, async () => new Response(null, { status })), /REDIRECT_REJECTED/u);
  await assert.rejects(fetchWithoutRedirects("https://synthetic", {}, async () => ({ status: "unknown" })), /HTTP_STATUS_UNVERIFIED/u);
});
