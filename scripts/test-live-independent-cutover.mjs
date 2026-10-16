import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { nextProductionSchedule } from "../lib/production-schedule.mjs";
import { verifyWriter } from "../infra/live-executor/verify-writer.mjs";
import { canonicalContentHash } from "../lib/canonical-content-hash.mjs";
test("both runner collectors are retired and LIVE Worker cannot dispatch; Daily source is untouched", async () => {
  for (const name of ["intraday-model-top-official-signal.yml", "intraday-model-b-official-signal.yml"]) {
    const value = await readFile(new URL(`../.github/workflows/${name}`, import.meta.url), "utf8");
    assert.doesNotMatch(value, /schedule:|KIS_APP_|contents: write|run-intraday-model/);
    assert.match(value, /permissions: \{\}/);
  }
  const worker = JSON.parse(await readFile(new URL("../infra/cloudflare-live-signal/wrangler.jsonc", import.meta.url), "utf8"));
  assert.equal(worker.name, "tight-budget-live-prewarm"); assert.equal(worker.vars.DISPATCH_ENABLED, "false"); assert.deepEqual(worker.triggers.crons, []);
  assert.equal(nextProductionSchedule("LIVE"), null);
  assert.equal(nextProductionSchedule("DAILY", new Date("2026-10-16T22:00:00Z")), "2026-10-18T23:23:00.000Z");
});
test("writer verification is confined to synthetic paths and preserves duplicate/conflicting original bytes", async () => {
  const rows = new Map(); let writes = 0;
  const store = { verifyPrivateRepository: async () => {}, read: async key => rows.get(key), writeImmutable: async (key, value) => {
    assert.match(key, /^tests\/site-delivery-writer\/[^/]+\/fixture.json$/);
    const existing = rows.get(key), contentHash = canonicalContentHash(value);
    if (existing && existing.contentHash !== contentHash) throw Object.assign(new Error("PRIVATE_STORE_IMMUTABLE_CONFLICT"), { code: "PRIVATE_STORE_IMMUTABLE_CONFLICT" });
    if (!existing) { rows.set(key, { value, contentHash }); writes++; } return { contentHash };
  } };
  const result = await verifyWriter(store); assert.equal(result.status, "VERIFIED"); assert.equal(writes, 1); assert.equal(result.operationalPointerChanged, false);
  await assert.rejects(verifyWriter({ verifyPrivateRepository: async () => { throw new Error("PRIVATE_STORE_AUTHORIZATION_FAILED"); } }), /AUTHORIZATION_FAILED/);
});
test("outbox queuing is independent of writer availability and survives startup", async () => {
  const code = await readFile(new URL("../infra/live-executor/run.mjs", import.meta.url), "utf8");
  assert.match(code, /try \{ await enqueueStoredSiteDelivery\(store\); \}/);
  assert.match(code, /if \(siteWriter\) await retrySiteDeliveries/);
  assert.doesNotMatch(code, /if \(siteWriter &&/);
  assert.match(code, /clockAttempts >= 3/);
  assert.match(code, /clockAttempts \+= 1; nextClockCheck = Date.now\(\) \+ 10000/);
});
