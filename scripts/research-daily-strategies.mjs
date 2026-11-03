// Offline repeatable research. Stdout only; never writes model results or reads private LIVE.
import fs from "node:fs/promises";
import path from "node:path";
import { hashObject } from "../lib/rank-backtest-engine.mjs";
import { loadModelRegistry } from "../lib/model-registry.mjs";
import { prepareMarketPriceLedgers } from "../lib/future-return-resolver.mjs";
import { validateMarketPriceLedger } from "../lib/market-price-ledger.mjs";
import { simulateFundedPortfolio } from "../lib/funded-research-portfolio.mjs";
import { runStrategyStudy } from "../lib/daily-strategy-study.mjs";
import { deriveMarketBenchmarkLegs } from "../lib/research-index-benchmarks.mjs";

const read = async (file) => JSON.parse(await fs.readFile(file,"utf8"));
const plan = await read("config/daily-strategy-research-v1.json");
const registry = await loadModelRegistry();
const implementation = (await fs.readFile("lib/daily-strategy-challengers.mjs","utf8")).replaceAll("\r\n","\n");
for (const candidate of plan.candidates) {
  const id = candidate.modelId + "-" + candidate.version;
  const entry = registry.models.find((m) => m.modelVersion === id);
  if (entry?.formulaHash !== hashObject({ candidate, implementation }) || entry.evaluationOnly !== true || entry.promotionStatus !== "notApproved")
    throw new Error("Missing or changed research-only registry entry: " + id);
}
const cutoff = plan.chronologicalCheck[1];
const inputHashes = {};
async function readDated(directory, dateKey) {
  const names = (await fs.readdir(directory)).filter((n) => /^\d{4}-\d\d-\d\d\.json$/.test(n) && n.slice(0,10) <= cutoff).sort();
  const result = [];
  for (const name of names) {
    const file = path.join(directory,name);
    const value = await read(file);
    if (value[dateKey] !== name.slice(0,10)) throw new Error("Input reference date differs: " + file);
    inputHashes[path.posix.join(directory,name)] = hashObject(value);
    result.push(value);
  }
  return result;
}
const calendarFile = await read("data/trading-calendar/status.json");
const calendar = { dates: Object.fromEntries(Object.entries(calendarFile.dates).filter(([date]) => date <= cutoff)) };
inputHashes["calendarThroughCutoff"] = hashObject(calendar);
const snapshots = await readDated("data/history","asOfDate");
const ledgers = (await readDated("data/market-prices","date")).filter((l) =>
  l.source === "data-go-kr-official-daily-price" && !validateMarketPriceLedger(l,0).length && l.records.every((r) => r.date === l.date));
const ledgerMap = new Map(prepareMarketPriceLedgers(ledgers).map((l) => [l.date,l]));
// Optional normalized index observations; these enter outcome comparison only.
const indexFile = process.argv.find((a) => a.startsWith("--index-evidence="))?.slice("--index-evidence=".length);
const series = indexFile ? (await read(indexFile)).filter((r) => r.date <= cutoff) : [];
const indexKeys = new Set();
for (const row of series) {
  const indexCode = { KOSPI:"0001",KOSDAQ:"1001" }[row.market], key = row.market + row.date;
  if (!indexCode || indexKeys.has(key) || !Number.isFinite(Date.parse(row.observedAt)) ||
      Date.parse(row.observedAt) < Date.parse(row.date + "T15:30:00+09:00") ||
      row.sourceHash !== hashObject({operation:"FHKUP03500100",code:indexCode,date:row.date,open:row.open,close:row.close}))
    throw new Error("Invalid index evidence");
  indexKeys.add(key);
}
if (series.length) inputHashes.indexEvidence = hashObject(series);
const indexLegs = new Map();
function benchmark(market, entryDate, exitDate) {
  const key = entryDate + exitDate;
  if (!indexLegs.has(key)) indexLegs.set(key, deriveMarketBenchmarkLegs(series,[{entryDate,exitDate}]));
  return indexLegs.get(key).find((r) => r.market === market)?.returnPercent ?? null;
}
const study = runStrategyStudy({ snapshots, calendar, ledgerMap, ledgers, plan, simulate: simulateFundedPortfolio, benchmark });
console.log(JSON.stringify({ ...study, inputHashes },null,2));
