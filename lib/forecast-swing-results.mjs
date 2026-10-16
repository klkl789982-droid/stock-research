import { readFile, readdir, mkdir, open, link, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { resolveSwingOutcome, validateSwingOutcome, validateForecastRecord, hashSwingContent } from "./forecast-swing-contract.mjs";

export const SWING_RESULTS_DIRECTORY = "data/forecast-outcomes/swing-5d";
const digest = /^[a-f0-9]{64}$/u;

// Explicit local writer, never called by GET. Original preparation is immutable;
// each evaluation keeps the exact evidence needed to reproduce its result.
export async function appendSwingResolution({ root = process.cwd(), forecast, evidence, clock = () => new Date().toISOString() }) {
  if (!validateForecastRecord(forecast).valid || forecast.observationPolicyId !== "intraday-1400-v1") throw new Error("INVALID_LEDGER_RECORD");
  const stored = JSON.parse(await readFile(path.join(root, "data/forecast-ledger/swing-5d", `${forecast.forecastHash}.json`), "utf8"));
  if (hashSwingContent(stored) !== hashSwingContent(forecast)) throw new Error("FORECAST_SOURCE_MISMATCH");
  // Do not accept caller-supplied resolution dates or override the forecast.
  const proof = { calendar: evidence?.calendar ?? null, prices: evidence?.prices ?? null, executionEvidence: evidence?.executionEvidence ?? null };
  const outcome = resolveSwingOutcome({ ...proof, forecast, resolvedAt: clock() });
  if (!validateSwingOutcome(outcome, { forecast, evidence: proof }).evidenceVerified) throw new Error("OUTCOME_EVIDENCE_INVALID");
  const envelope = { outcome, evidence: proof };
  const directory = path.join(root, SWING_RESULTS_DIRECTORY, forecast.forecastHash);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const target = path.join(directory, `${outcome.outcomeHash}.json`), temporary = `${target}.${randomUUID()}.tmp`;
  const text = `${JSON.stringify(envelope)}\n`;
  const handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
  let created = true;
  try {
    try { await link(temporary, target); } catch (error) { if (error.code !== "EEXIST") throw error; created = false; }
    if (await readFile(target, "utf8") !== text) throw new Error("IMMUTABLE_OUTCOME_CONFLICT");
  } finally { await unlink(temporary); }
  return { created, outcome };
}

export async function readSwingResolution({ root = process.cwd(), forecast, now = new Date().toISOString() }) {
  if (!validateForecastRecord(forecast).valid || !digest.test(forecast.forecastHash) || !Number.isFinite(Date.parse(now))) throw new Error("INVALID_LEDGER_RECORD");
  const directory = path.join(root, SWING_RESULTS_DIRECTORY, forecast.forecastHash);
  let files;
  try { files = await readdir(directory); } catch (error) { if (error.code === "ENOENT") return { outcome: null, invalidCount: 0 }; throw error; }
  const valid = []; let invalidCount = 0;
  for (const file of files) {
    if (file.endsWith(".tmp")) continue; // Interrupted writes are never records.
    try {
      if (!/^[a-f0-9]{64}\.json$/u.test(file)) throw new Error("INVALID_NAME");
      const { outcome, evidence } = JSON.parse(await readFile(path.join(directory, file), "utf8"));
      if (outcome?.outcomeHash !== file.slice(0, -5) || !validateSwingOutcome(outcome, { forecast, evidence }).evidenceVerified) throw new Error("INVALID_EVIDENCE");
      if (Date.parse(outcome.resolvedAt) <= Date.parse(now)) valid.push(outcome);
    } catch { invalidCount++; }
  }
  valid.sort((a, b) => b.resolvedAt.localeCompare(a.resolvedAt) || b.outcomeHash.localeCompare(a.outcomeHash));
  return { outcome: valid[0] ?? null, invalidCount };
}
