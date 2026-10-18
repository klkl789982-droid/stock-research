import { performance } from "node:perf_hooks";
import fs from "node:fs/promises";
import { parseEnv } from "node:util";
import { createLocalExecutionStore } from "../live-executor/store.mjs";
import { calculateIntradayModelTopScores, hashIntradayModelTop } from "../../lib/intraday-model-top-official-signal.mjs";
import { mergeProvisionalCandle } from "../../lib/intraday-model-b-official-signal.mjs";
import { createKisSource } from "../live-executor/kis-source.mjs";
import { calculateFixture, summarize, budget } from "./core.mjs";

const option = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const cpuMs = cpu => { const value = process.cpuUsage(cpu); return (value.user + value.system) / 1000; };
const percentile = (rows, p) => [...rows].sort((a, b) => a - b)[Math.min(rows.length - 1, Math.floor(rows.length * p))];
async function main() {
  const syntheticCpu = process.cpuUsage(), syntheticWall = performance.now();
  const synthetic = summarize(Array.from({ length: 508 }, (_, i) => calculateFixture(i)));
  const report = { synthetic: { ...synthetic, cpuMs: cpuMs(syntheticCpu), wallMs: performance.now() - syntheticWall }, budget: budget() };
  const stateDir = option("state-dir");
  if (stateDir) {
    const store = createLocalExecutionStore(stateDir), latest = await store.read("shadow/latest.json");
    const result = await store.read(latest.artifactKey);
    const seed = await store.read(`shadow/seeds/${result.seedHash}.json`);
    const prior = new Map(result.records.map(row => [row.ticker, row]));
    const measurements = [], records = [];
    const start = performance.now(), cpu = process.cpuUsage();
    for (const item of seed.records.filter(row => row.eligible)) {
      const saved = prior.get(item.code), before = process.cpuUsage();
      const scores = calculateIntradayModelTopScores(mergeProvisionalCandle(item.rows, saved.quote), saved.quote).scores;
      measurements.push(cpuMs(before));
      if (hashIntradayModelTop(scores) !== hashIntradayModelTop(saved.scores)) throw new Error("PROBE_REAL_SCORE_REGRESSION");
      records.push({ ticker: item.code, scores });
    }
    report.savedRealReplay = { symbols: records.length, cpuMs: cpuMs(cpu), wallMs: performance.now() - start,
      perSymbolCpuMs: { p50: percentile(measurements, .5), p95: percentile(measurements, .95), max: Math.max(...measurements) },
      cpuResolutionNote: "Per-symbol process CPU on Windows is quantized; zero does not mean free compute. Use whole-batch CPU and remote platform metrics, not individual zeros.",
      originalDate: result.signalDate, originalStartedAt: result.collectionStartedAt, originalCompletedAt: result.collectionCompletedAt,
      allScoresMatch: true, newObservation: false, rawUploaded: false };
    const serialized = JSON.stringify(seed), hcpu = process.cpuUsage(), hwall = performance.now();
    hashIntradayModelTop(seed);
    report.wholeSeedHash = { bytes: Buffer.byteLength(serialized), cpuMs: cpuMs(hcpu), wallMs: performance.now() - hwall };
  }
  // Optional existing PC auth only. Does not transmit keys to Cloudflare or call
  // quote endpoints. Fetch/body wait and process CPU are measured separately.
  if (option("auth-file")) {
    const parsed = parseEnv(await fs.readFile(option("auth-file"), "utf8"));
    let awaitedFetchAndBodyMs = 0;
    const source = createKisSource({ credentials: { appKey: parsed.KIS_APP_KEY, appSecret: parsed.KIS_APP_SECRET }, fetchImpl: async (url, init) => {
      const start = performance.now(); const response = await fetch(url, init); const body = await response.text();
      awaitedFetchAndBodyMs += performance.now() - start;
      return new Response(body, { status: response.status, headers: response.headers });
    } });
    const start = performance.now(), cpu = process.cpuUsage();
    const date = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
    const calendar = await source.calendar(date);
    report.pcKisAuthCalendar = { date, isTradingDay: calendar.isTradingDay, wallMs: performance.now() - start, processCpuMs: cpuMs(cpu),
      awaitedFetchAndBodyMs, requests: source.getMetrics().requests, quoteRequests: 0, cloudCredentialsUploaded: false };
  }
  console.log(JSON.stringify(report));
}
main().catch(() => { console.error(JSON.stringify({ status: "MEASUREMENT_FAILED", secretsPrinted: false })); process.exitCode = 1; });
