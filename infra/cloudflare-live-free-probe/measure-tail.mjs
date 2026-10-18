// Accept only one of the two fixed isolated deployments' Wrangler JSON tails.
// Print bounded aggregate platform metrics, never headers, bodies or raw events.
const actual = process.argv.includes("--actual-isolated");
const scriptName = actual ? "tight-budget-live-kis-diagnostic" : "tight-budget-live-free-probe";
const entrypoints = actual ? ["KisDiagnostic", "KisDiagnosticBroker", "KisDiagnosticShard", "KisSlotShard"] : ["FreeProbe", "SyntheticBroker"];
const groups = new Map(); let buffer = "", start = -1, depth = 0, quoted = false, escaped = false;
function accept(event) {
  if (event.scriptName !== scriptName || !entrypoints.includes(event.entrypoint)) return;
  const group = groups.get(event.entrypoint) ?? { cpu: [], wall: [], outcomes: {} };
  if (Number.isFinite(event.cpuTime)) group.cpu.push(event.cpuTime);
  if (Number.isFinite(event.wallTime)) group.wall.push(event.wallTime);
  group.outcomes[event.outcome] = (group.outcomes[event.outcome] ?? 0) + 1;
  groups.set(event.entrypoint, group);
}
function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return { samples: sorted.length, total: sorted.reduce((a, b) => a + b, 0), p50: sorted[Math.floor(sorted.length * .5)] ?? null,
    p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * .95))] ?? null, max: sorted.at(-1) ?? null };
}
let reported = false;
function report() {
  if (reported) return; reported = true;
  console.log(JSON.stringify({ syntheticOnly: !actual, actualKisDiagnostic: actual, platformCpuNotWallTime: true, sampledTailNotBillingLedger: true,
    metrics: Object.fromEntries([...groups].map(([key, value]) => [key, { cpuMs: stats(value.cpu), wallMs: stats(value.wall), outcomes: value.outcomes }])) }));
}
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
  for (const char of chunk) {
    if (start < 0) { if (char !== "{") continue; start = 0; buffer = ""; depth = 0; quoted = false; escaped = false; }
    buffer += char;
    if (buffer.length > 1000000) { start = -1; buffer = ""; continue; }
    if (quoted) { if (escaped) escaped = false; else if (char === "\\") escaped = true; else if (char === '"') quoted = false; }
    else if (char === '"') quoted = true;
    else if (char === "{") depth++;
    else if (char === "}" && --depth === 0) { try { accept(JSON.parse(buffer)); } catch { /* No partial evidence. */ } start = -1; buffer = ""; }
  }
});
process.stdin.on("end", report);
process.on("SIGINT", () => { report(); process.exit(0); });
setTimeout(() => { report(); process.exit(0); }, 90000);
