import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createPreparingForecast, hashSwingContent } from "../lib/forecast-swing-contract.mjs";
import { appendSwingPreparation, loadForecastSwingDashboard } from "../lib/forecast-swing-store.mjs";
import { appendSwingResolution, readSwingResolution, SWING_RESULTS_DIRECTORY } from "../lib/forecast-swing-results.mjs";
const proof = at => ({ source: "SYNTHETIC_TEST_ONLY", sourceHash: hashSwingContent({ fixture: true }), availableAt: at, receivedAt: at, availabilityEvidence: "SYSTEM_OBSERVED" });
const createdAt = "2026-10-16T05:06:00.000Z";
const forecast = createPreparingForecast({ createdAt, observationPolicyId: "intraday-1400-v1",
  observation: { symbol: "005930", observedDate: "2026-10-16", observedAt: "2026-10-16T05:01:00.000Z", referencePrice: 100, provenance: proof(createdAt) },
  inputs: [{ name: "observedScore:B-v1", value: 60, modelVersion: "B-v1", observedAt: createdAt, ...proof(createdAt) }] });
const evidence = {
  calendar: { status: "CONFIRMED", evidence: "OFFICIAL_CALENDAR", timeZone: "Asia/Seoul", coverageStartDate: "2026-10-16", coverageEndDate: "2026-10-23", ...proof(createdAt),
    dates: Array.from({ length: 8 }, (_, i) => { const date = `2026-10-${16 + i}`; return [17, 18].includes(16 + i) ? { date, status: "CLOSED" } : { date, status: "TRADING", openAt: `${date}T00:00:00.000Z`, closeAt: `${date}T06:30:00.000Z` }; }) },
  prices: Array.from({ length: 5 }, (_, i) => ({ symbol: "005930", date: `2026-10-${19 + i}`, officialOpen: 100 + i, officialClose: 101 + i,
    tradingStatus: "TRADABLE", priceKind: "OFFICIAL_DAILY_OHLC", adjustmentBasis: "UNADJUSTED_NO_CORPORATE_ACTIONS", ...proof("2026-10-26T02:00:00.000Z") })),
  executionEvidence: { status: "CONFIRMED", symbol: "005930", entryDate: "2026-10-19", exitDate: "2026-10-23", entryExecutable: true,
    exitExecutable: true, adjustmentBasis: "UNADJUSTED_NO_CORPORATE_ACTIONS", ...proof("2026-10-26T02:00:00.000Z") },
};
test("5-session journal preserves original issuance, pending/blocked/observed evidence and authenticated view DTO", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tb-swing-resolution-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await appendSwingPreparation({ root, record: forecast });
  const original = await fs.readFile(path.join(root, "data/forecast-ledger/swing-5d", `${forecast.forecastHash}.json`), "utf8");
  const first = await appendSwingResolution({ root, forecast, evidence: { calendar: evidence.calendar }, clock: () => createdAt });
  assert.equal(first.outcome.status, "PENDING"); assert.equal(first.outcome.entryDate, "2026-10-19"); assert.equal(first.outcome.exitDate, "2026-10-23");
  const clock = () => "2026-10-26T03:00:00.000Z";
  const missing = await appendSwingResolution({ root, forecast, evidence: { calendar: evidence.calendar }, clock: () => "2026-10-26T02:30:00.000Z" });
  assert.equal(missing.outcome.status, "BLOCKED"); assert.equal(missing.outcome.grossReturn, null);
  const complete = await appendSwingResolution({ root, forecast, evidence, clock });
  assert.equal(complete.outcome.status, "OBSERVED"); assert.equal(complete.outcome.grossReturn, 0.05);
  assert.equal((await appendSwingResolution({ root, forecast, evidence, clock })).created, false);
  assert.equal((await readSwingResolution({ root, forecast, now: clock() })).outcome.outcomeHash, complete.outcome.outcomeHash);
  assert.equal((await readSwingResolution({ root, forecast, now: createdAt })).outcome.status, "PENDING");
  const view = await loadForecastSwingDashboard({ root, code: "005930", now: clock() });
  assert.equal(view.ledger.records[0].outcome.benchmarkReturnPercent, 5); assert.equal(view.ledger.records[0].outcome.netReturnPercent, null);
  assert.equal(view.evaluation.mature5DayCount, 1); assert.equal(view.evaluation.independentDateCount, 1);
  assert.deepEqual(Object.values(view.prediction), [null, null, null]);
  assert.equal((await loadForecastSwingDashboard({ root, code: "000660", now: clock() })).ledger.recordCount, 0);
  assert.equal(await fs.readFile(path.join(root, "data/forecast-ledger/swing-5d", `${forecast.forecastHash}.json`), "utf8"), original);
  const target = path.join(root, SWING_RESULTS_DIRECTORY, forecast.forecastHash, `${complete.outcome.outcomeHash}.json`);
  const tampered = JSON.parse(await fs.readFile(target, "utf8")); tampered.evidence.prices[4].officialClose++;
  await fs.writeFile(target, JSON.stringify(tampered));
  assert.equal((await readSwingResolution({ root, forecast, now: clock() })).invalidCount, 1);
  await assert.rejects(appendSwingResolution({ root, forecast, evidence, clock }), /IMMUTABLE_OUTCOME_CONFLICT/u);
});
