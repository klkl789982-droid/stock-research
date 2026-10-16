// Explicit local preparation-ledger operation. No collection or prediction.
import { prepareSwingLedgerRecord, appendSwingPreparation } from "../lib/forecast-swing-store.mjs";
const args = process.argv.slice(2);
const codes = args.filter(arg => arg.startsWith("--code="));
if (codes.length !== 1 || args.some(arg => arg !== "--record" && !arg.startsWith("--code=")) || args.filter(arg => arg === "--record").length > 1 || !/^[0-9A-Z]{6}$/u.test(codes[0].slice(7))) {
  console.error("Usage: node scripts/record-swing-preparation.mjs --code=005930 [--record]. Default is read-only preview; timestamps cannot be overridden.");
  process.exitCode = 1;
} else {
  try {
    const record = await prepareSwingLedgerRecord({ code: codes[0].slice(7) });
    const persisted = args.includes("--record") ? await appendSwingPreparation({ record }) : null;
    console.log(JSON.stringify({ status: record.status, createdAt: record.createdAt, forecastHash: record.forecastHash,
      predictionCreated: false, preparationRecorded: persisted !== null, newlyCreated: persisted?.created ?? false,
      forecastValues: record.predictions, blockers: record.eligibility.blockers }));
  } catch { console.error("SWING_PREPARATION_FAILED: saved data or immutable ledger could not be validated."); process.exitCode = 1; }
}
