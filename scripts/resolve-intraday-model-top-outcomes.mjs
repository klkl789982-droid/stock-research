import fs from "node:fs/promises";
import path from "node:path";
import { prepareMarketPriceLedgers } from "../lib/future-return-resolver.mjs";
import { validateIntradayModelTopSignal } from "../lib/intraday-model-top-official-signal.mjs";
import { resolveIntradayModelTopOutcomes, validateIntradayModelTopOutcomes } from "../lib/intraday-model-top-outcome-resolver.mjs";

const root = process.cwd();
const signalRoot = path.join(root, "data", "intraday-signals", "model-top");
const outcomeRoot = path.join(root, "data", "intraday-outcomes", "model-top");
const ledgerRoot = path.join(root, "data", "market-prices");
const readJson = async (file) => JSON.parse(await fs.readFile(file, "utf8"));
const listDates = async (directory) => { try { return (await fs.readdir(directory, { withFileTypes: true })).filter((entry) => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}$/u.test(entry.name)).map((entry) => entry.name).sort(); } catch (error) { if (error?.code === "ENOENT") return []; throw error; } };

const [signalDates, ledgerNames, tradingCalendar] = await Promise.all([
  listDates(signalRoot),
  fs.readdir(ledgerRoot).then((names) => names.filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/u.test(name)).sort()),
  readJson(path.join(root, "data", "trading-calendar", "status.json")),
]);
const rawLedgers = await Promise.all(ledgerNames.map((name) => readJson(path.join(ledgerRoot, name))));
const priceLedgers = prepareMarketPriceLedgers(rawLedgers);
const changedPaths = [];
let scanned = 0;
for (const signalDate of signalDates) {
  const signalPath = path.join(signalRoot, signalDate, "1430.json");
  let signal;
  try { signal = await readJson(signalPath); } catch (error) { if (error?.code === "ENOENT") continue; throw error; }
  if (signal.observationType !== "LIVE_OBSERVATION" || signal.status !== "READY") continue;
  const signalErrors = validateIntradayModelTopSignal(signal);
  if (signalErrors.length) throw new Error(`${signalDate}:INTRADAY_SIGNAL_INVALID:${signalErrors.join(",")}`);
  scanned += 1;
  const output = path.join(outcomeRoot, `${signalDate}.json`);
  let existing = null;
  try { existing = await readJson(output); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  if (existing && existing.signalContentHash !== signal.contentHash) throw new Error(`${signalDate}:INTRADAY_SIGNAL_HASH_CONFLICT`);
  const resolvedAt = new Date().toISOString();
  const candidate = resolveIntradayModelTopOutcomes({ signal, existing, priceLedgers, tradingCalendar, resolvedAt });
  const errors = validateIntradayModelTopOutcomes(candidate);
  if (errors.length) throw new Error(`${signalDate}:INTRADAY_OUTCOME_INVALID:${errors.join(",")}`);
  const comparable = (value) => JSON.stringify({ ...value, contentHash: undefined, updatedAt: undefined });
  if (existing && comparable(existing) === comparable(candidate)) continue;
  await fs.mkdir(outcomeRoot, { recursive: true });
  const temporary = `${output}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(candidate, null, 2)}\n`, { flag: "wx" });
  await fs.rename(temporary, output);
  changedPaths.push(path.relative(root, output).replaceAll("\\", "/"));
}
console.log(`INTRADAY_MODEL_TOP_OUTCOMES_RESULT_JSON=${JSON.stringify({ status: "READY", scanned, changedPaths })}`);
