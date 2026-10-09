import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { KIS_EOD_OBSERVATION_SLOTS } from "../lib/kis-eod-observation.mjs";
import { compareKisEodObservationWithOfficial, kisEodObservationComparisonHash, toSafeKisEodObservationComparisonSummary, KIS_EOD_OBSERVATION_COMPARISON_NAMESPACE } from "../lib/kis-eod-observation-comparison.mjs";

const validDate = (value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(value)
  && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const fail = (reason) => { throw new Error(reason); };

async function safePath(root, target, { create = false } = {}) {
  const absoluteRoot = path.resolve(root), absoluteTarget = path.resolve(target);
  if (absoluteTarget === absoluteRoot || !absoluteTarget.startsWith(`${absoluteRoot}${path.sep}`)) fail("KIS_EOD_COMPARISON_PRIVATE_PATH_INVALID");
  const actualRoot = await fs.realpath(absoluteRoot), segments = path.relative(absoluteRoot, absoluteTarget).split(path.sep);
  let current = absoluteRoot;
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]);
    if (create) { try { await fs.mkdir(current); } catch (error) { if (error.code !== "EEXIST") throw error; } }
    const info = await fs.lstat(current);
    if (info.isSymbolicLink() || (index < segments.length - 1 && !info.isDirectory()) || (create && !info.isDirectory())) fail("KIS_EOD_COMPARISON_SYMLINK_REJECTED");
    if (await fs.realpath(current) !== path.join(actualRoot, ...segments.slice(0, index + 1))) fail("KIS_EOD_COMPARISON_SYMLINK_REJECTED");
  }
  return absoluteTarget;
}

async function loadOfficial(root, referenceDate, officialPath) {
  const target = officialPath ? path.resolve(root, officialPath) : path.resolve(root, "data", "analysis", "market-seeds", `${referenceDate}.json`);
  const allowed = [path.resolve(root, "data", "analysis", "market-seeds"), path.resolve(root, ".runtime", "kis-eod", "official-comparison-inputs")];
  if (!allowed.some((base) => target.startsWith(`${base}${path.sep}`)) || path.extname(target) !== ".json") fail("KIS_EOD_COMPARISON_OFFICIAL_PATH_FORBIDDEN");
  try { return JSON.parse(await fs.readFile(await safePath(root, target), "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

export async function writeImmutableKisEodObservationComparison({ root, report }) {
  if (!validDate(report?.referenceDate) || !KIS_EOD_OBSERVATION_SLOTS.includes(report?.slot)
    || report.schemaVersion !== 1 || report.namespace !== KIS_EOD_OBSERVATION_COMPARISON_NAMESPACE
    || report.publicationEligible !== false || report.productionChanged !== false
    || report?.comparisonHash !== kisEodObservationComparisonHash(report)) fail("KIS_EOD_COMPARISON_REPORT_INVALID");
  const directory = await safePath(root, path.resolve(root, ".runtime", "kis-eod", "observation-comparisons", report.referenceDate, report.slot.replace(":", "")), { create: true });
  const target = path.join(directory, `${report.comparisonHash}.json`);
  const temporary = path.join(directory, `.comparison-${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    const checked = JSON.parse(await fs.readFile(temporary, "utf8"));
    if (checked.comparisonHash !== report.comparisonHash || kisEodObservationComparisonHash(checked) !== report.comparisonHash) fail("KIS_EOD_COMPARISON_WRITE_HASH_MISMATCH");
    // A hard link publishes the fully written inode without replacing anything.
    // Interrupted writes stay temporary rather than becoming a sealed report.
    await fs.link(temporary, target); return "CREATED";
  }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    const prior = JSON.parse(await fs.readFile(await safePath(root, target), "utf8"));
    if (prior.comparisonHash !== report.comparisonHash || kisEodObservationComparisonHash(prior) !== report.comparisonHash) fail("KIS_EOD_COMPARISON_IMMUTABLE_CONFLICT");
    return "IDEMPOTENT";
  }
  finally { await fs.unlink(temporary).catch(() => {}); }
}

export async function runKisEodObservationComparison({ root = process.cwd(), referenceDate, slot = null, officialPath = null, now = () => new Date(), durableStore = null } = {}) {
  if (!validDate(referenceDate) || (slot !== null && !KIS_EOD_OBSERVATION_SLOTS.includes(slot))) fail("KIS_EOD_COMPARISON_ARGUMENTS_INVALID");
  if (durableStore !== null && typeof durableStore.persistComparison !== "function") fail("KIS_EOD_COMPARISON_DURABLE_STORE_INVALID");
  const comparedAt = new Date(typeof now === "function" ? now() : now).toISOString(), official = await loadOfficial(root, referenceDate, officialPath);
  const summaries = [];
  for (const selectedSlot of slot ? [slot] : KIS_EOD_OBSERVATION_SLOTS) {
    const directory = path.resolve(root, ".runtime", "kis-eod", "observations", referenceDate, selectedSlot.replace(":", ""));
    let files;
    try { files = await fs.readdir(await safePath(root, directory)); }
    catch (error) { if (error.code !== "ENOENT") throw error; files = []; }
    const artifacts = files.filter((name) => /^[0-9TZ.-]+-[a-f0-9]{64}[.]json$/u.test(name)).sort();
    if (!artifacts.length) { summaries.push({ referenceDate, slot: selectedSlot, status: "PENDING", reason: "OBSERVATION_NOT_FOUND", publicationEligible: false, productionChanged: false }); continue; }
    for (const file of artifacts) {
      const observation = JSON.parse(await fs.readFile(await safePath(root, path.join(directory, file)), "utf8"));
      if (observation.referenceDate !== referenceDate || observation.slot !== selectedSlot) fail("KIS_EOD_COMPARISON_OBSERVATION_PATH_MISMATCH");
      const report = compareKisEodObservationWithOfficial({ observation, official, comparedAt });
      const action = await writeImmutableKisEodObservationComparison({ root, report });
      const target = path.resolve(root, ".runtime", "kis-eod", "observation-comparisons", referenceDate, selectedSlot.replace(":", ""), `${report.comparisonHash}.json`);
      // A repeated invocation must upload the original persisted evidence,
      // including its first comparedAt, not a reconstructed later timestamp.
      const saved = JSON.parse(await fs.readFile(await safePath(root, target), "utf8"));
      if (saved.comparisonHash !== report.comparisonHash || kisEodObservationComparisonHash(saved) !== report.comparisonHash) fail("KIS_EOD_COMPARISON_IMMUTABLE_CONFLICT");
      if (durableStore !== null) await durableStore.persistComparison(saved);
      summaries.push({ ...toSafeKisEodObservationComparisonSummary(saved), storageAction: action, durablePersisted: durableStore !== null });
    }
  }
  return summaries;
}

export function parseKisEodObservationComparisonArgs(args) {
  if (args.some((arg) => !/^--(?:date|slot|official-file)=.+$/u.test(arg))
    || new Set(args.map((arg) => arg.split("=")[0])).size !== args.length) return null;
  const referenceDate = args.find((arg) => arg.startsWith("--date="))?.slice(7);
  const slot = args.find((arg) => arg.startsWith("--slot="))?.slice(7) ?? null;
  if (!validDate(referenceDate) || (slot !== null && !KIS_EOD_OBSERVATION_SLOTS.includes(slot))) return null;
  return { referenceDate, slot, officialPath: args.find((arg) => arg.startsWith("--official-file="))?.slice(16) ?? null };
}

async function cli() {
  try {
    const options = parseKisEodObservationComparisonArgs(process.argv.slice(2));
    if (!options) fail("KIS_EOD_COMPARISON_ARGUMENTS_INVALID");
    for (const result of await runKisEodObservationComparison(options)) console.log(`KIS_EOD_COMPARISON_JSON=${JSON.stringify(result)}`);
  } catch {
    // Neither upstream error bodies nor prices/file contents belong in logs.
    console.log('KIS_EOD_COMPARISON_JSON={"status":"FAILED","reason":"PRIVATE_COMPARISON_FAILED","productionChanged":false}');
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await cli();
