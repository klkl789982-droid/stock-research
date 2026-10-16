import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { currentSignal } from "../../scripts/fixtures/executor-1400-signal.mjs";
import { recordTop5SwingBatch } from "./swing-records.mjs";
import { readSwingLedger, loadForecastSwingDashboard, forecastSwingRootForRequest } from "../../lib/forecast-swing-store.mjs";

test("all four TOP5 selections are frozen once, overlapping tickers are not independent rows", async t => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "tb-swing-batch-"));
  t.after(() => fs.rm(stateDir, { recursive: true, force: true }));
  const signal = currentSignal(6), original = JSON.stringify(signal), now = () => "2026-10-06T05:02:00.000Z";
  const result = await recordTop5SwingBatch({ stateDir, signal, now });
  assert.equal(result.selectionCount, 20); assert.equal(result.uniqueTickerCount, 5);
  const ledger = await readSwingLedger({ root: stateDir });
  assert.equal(ledger.records.length, 5);
  for (const record of ledger.records) {
    assert.equal(record.createdAt, now()); assert.deepEqual(Object.values(record.predictions), [null, null, null]);
    assert.equal(record.inputs.filter(input => input.name.startsWith("selectedRank:")).length, 4);
  }
  assert.deepEqual(await recordTop5SwingBatch({ stateDir, signal, now: () => "2026-10-08T06:00:00Z" }), result);
  assert.equal((await readSwingLedger({ root: stateDir })).records.length, 5);
  const view = await loadForecastSwingDashboard({ root: stateDir, code: "000001" });
  assert.equal(view.ledger.recordCount, 1); assert.equal(view.ledger.records[0].observedModels.length, 4);
  assert.ok(view.ledger.records[0].observedModels.every(model => model.rank === 1));
  assert.equal(view.ledger.records[0].outcome.status, "NOT_EVALUATED");
  assert.equal(JSON.stringify(signal), original);
  await assert.rejects(recordTop5SwingBatch({ stateDir, signal: { ...signal, observationType: "CURRENT_TIME_SHADOW" }, now }), /SWING_CURRENT_LIVE_REQUIRED/);
});

test("private swing ledger roots require local administrator routing and never run in Vercel", async t => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "tb-swing-root-"));
  t.after(() => fs.rm(stateDir, { recursive: true, force: true }));
  const request = new Request("http://localhost:3000/api/forecasts/swing", { headers: { host: "127.0.0.1:3000" } });
  assert.equal(await forecastSwingRootForRequest(request, { env: { FORECAST_SWING_PRIVATE_ROOT: stateDir } }), stateDir);
  for (const env of [{ FORECAST_SWING_PRIVATE_ROOT: stateDir, VERCEL: "1" }, { FORECAST_SWING_PRIVATE_ROOT: process.cwd() }, { FORECAST_SWING_PRIVATE_ROOT: "relative" }]) {
    await assert.rejects(forecastSwingRootForRequest(request, { env }), /PRIVATE_SWING_ROOT_DENIED/);
  }
  await assert.rejects(forecastSwingRootForRequest(new Request("https://remote.test/api/forecasts/swing"), { env: { FORECAST_SWING_PRIVATE_ROOT: stateDir } }), /PRIVATE_SWING_ROOT_DENIED/);
});
