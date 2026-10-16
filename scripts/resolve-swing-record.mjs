// Explicit private/local operation, never an automatic Production activation.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { appendSwingResolution } from "../lib/forecast-swing-results.mjs";
import { resolveSwingOutcome } from "../lib/forecast-swing-contract.mjs";
const args = process.argv.slice(2);
const value = key => args.find(arg => arg.startsWith(`--${key}=`))?.slice(key.length + 3);
try {
  if (args.some(arg => !/^--(?:id|evidence)=/u.test(arg) && arg !== "--record") || new Set(args.map(arg => arg.split("=")[0])).size !== args.length
    || !/^[a-f0-9]{64}$/u.test(value("id") ?? "") || !path.isAbsolute(value("evidence") ?? "")) throw new Error("INVALID_ARGUMENTS");
  const forecast = JSON.parse(await readFile(path.join("data/forecast-ledger/swing-5d", `${value("id")}.json`), "utf8"));
  const evidence = JSON.parse(await readFile(value("evidence"), "utf8"));
  const result = args.includes("--record") ? await appendSwingResolution({ forecast, evidence })
    : { created: false, outcome: resolveSwingOutcome({ calendar: evidence.calendar ?? null, prices: evidence.prices ?? null,
      executionEvidence: evidence.executionEvidence ?? null, forecast, resolvedAt: new Date().toISOString() }) };
  console.log(JSON.stringify({ status: result.outcome.status, forecastHash: result.outcome.forecastHash,
    outcomeHash: result.outcome.outcomeHash, recorded: args.includes("--record"), created: result.created,
    predictionCreated: false, realizedPnl: false }));
} catch { console.error("SWING_RESOLUTION_FAILED: invalid arguments, source evidence or immutable storage."); process.exitCode = 1; }
