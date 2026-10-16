import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { currentOutcomeInput, currentOutcome, legacyOutcomeFixture } from "./fixtures/intraday-1400-outcomes.mjs";
import { validateIntradayModelTopOutcomes } from "../lib/intraday-model-top-outcome-resolver.mjs";

// Execute only the local outcome writer against an isolated synthetic filesystem.
// This test never invokes collectors, workflow dispatch, network calls, or real data writes.
const root = await mkdtemp(path.join(os.tmpdir(), "intraday-1400-outcome-fixture-"));
const script = fileURLToPath(new URL("./resolve-intraday-model-top-outcomes.mjs", import.meta.url));
const input = currentOutcomeInput();
const write = async (relative, value) => {
  const target = path.join(root, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, typeof value === "string" ? value : JSON.stringify(value));
};
const run = () => {
  const output = execFileSync(process.execPath, [script], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return JSON.parse(output.trim().split("INTRADAY_MODEL_TOP_OUTCOMES_RESULT_JSON=").at(-1));
};
try {
  await write("data/trading-calendar/status.json", input.tradingCalendar);
  for (const ledger of input.priceLedgers) await write(`data/market-prices/${ledger.date}.json`, ledger);
  const legacySignalPath = "data/intraday-signals/model-top/2026-10-06/1430.json";
  const legacyOutcomePath = "data/intraday-outcomes/model-top/2026-10-06.json";
  // Invalid legacy signal bytes make an accidental legacy read fail immediately.
  await write(legacySignalPath, "LEGACY_ARCHIVE_SENTINEL_DO_NOT_PARSE_OR_REWRITE");
  await write(legacyOutcomePath, legacyOutcomeFixture(currentOutcome()));
  const legacyBefore = await Promise.all([legacySignalPath, legacyOutcomePath].map((file) => readFile(path.join(root, file), "utf8")));
  assert.deepEqual(run().changedPaths, []);
  assert.equal(run().scanned, 0, "legacy-only signals must not be resolved as current");

  const currentSignalPath = "data/intraday-signals/model-top/2026-10-06/1400.json";
  const currentOutcomePath = "data/intraday-outcomes/model-top/1400/2026-10-06.json";
  await write(currentSignalPath, input.signal);
  const first = run();
  assert.equal(first.layer, "INTRADAY_1400_LIVE");
  assert.equal(first.scanned, 1);
  assert.deepEqual(first.changedPaths, [currentOutcomePath]);
  const outcome = JSON.parse(await readFile(path.join(root, currentOutcomePath), "utf8"));
  assert.deepEqual(validateIntradayModelTopOutcomes(outcome), []);
  assert.equal(outcome.signalTime, "14:00:00");
  assert.equal(outcome.executionPolicy.policyId, "intraday-1400-t1-open-v1");
  assert.ok(outcome.records.every((record) => Object.values(record.horizons).every((horizon) => horizon.returnPercent === null)));
  assert.equal(outcome.summary["1DAY"].sampleCount, 0, "the production runner has no verified receipt adapter yet");
  assert.deepEqual(run().changedPaths, [], "unchanged unresolved evidence is idempotent");
  assert.deepEqual(await Promise.all([legacySignalPath, legacyOutcomePath].map((file) => readFile(path.join(root, file), "utf8"))), legacyBefore, "old signal/outcome bytes must remain immutable");

  const outputBefore = await readFile(path.join(root, currentOutcomePath), "utf8");
  await write(currentSignalPath, { ...input.signal, officialSignalTime: "14:30:00" });
  assert.throws(run, /CURRENT_1400_SIGNAL_REQUIRED/);
  assert.equal(await readFile(path.join(root, currentOutcomePath), "utf8"), outputBefore, "bad current identity must not overwrite a previously generated outcome");
  console.log("14:00 outcome runner isolated fixture: new namespace, legacy bytes unchanged, no false MATURE, idempotence, invalid-cohort rejection passed");
} finally {
  await rm(root, { recursive: true, force: true });
}
