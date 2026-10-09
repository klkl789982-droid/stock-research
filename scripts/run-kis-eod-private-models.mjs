import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { runKisEod, getKisEodLocalClock } from "./run-kis-eod.mjs";
import { kisEodPrivateStoreFromEnv } from "../lib/kis-eod-private-store.mjs";
import { readPrivateModelHead, persistPrivateModelBundle, recordPrivateModelOperation } from "../lib/kis-eod-private-models.mjs";

// No user-supplied date/clock/force/publication CLI. The existing collector checks
// the actual KST date/calendar and requires every bar's exact requested date.
export async function runPrivateKisModels({ root = process.cwd(), now = () => new Date(), collectPrivate = false,
  enabled = process.env.KIS_EOD_COLLECTION_ENABLED, store = null, runCollector = runKisEod, collectorOptions = {}, runId = randomUUID() } = {}) {
  const local = getKisEodLocalClock(now());
  if (!collectPrivate) return runCollector({ ...collectorOptions, root, now, collectPrivate: false });
  if (enabled !== "true") return { status: "BLOCKED", reason: "COLLECTION_NOT_ENABLED", publicationEligible: false };
  let privateStore = store;
  try { privateStore ??= kisEodPrivateStoreFromEnv(); await privateStore.preflight(); }
  catch { return { status: "BLOCKED", reason: "PRIVATE_STORE_PREFLIGHT_FAILED", publicationEligible: false }; }
  let result;
  try {
    const head = await readPrivateModelHead(privateStore);
    if (head?.referenceDate > local.referenceDate) throw new Error("PRIVATE_MODEL_FUTURE_HEAD");
    if (local.weekend || local.time < "15:30:00") result = { status: "PENDING", reason: local.weekend ? "WEEKEND" : "BEFORE_MARKET_CLOSE" };
    else if (head?.referenceDate === local.referenceDate) result = { status: "ALREADY_STORED", reason: "LATEST_DATE_ALREADY_STORED" };
    else {
      const collected = await runCollector({ ...collectorOptions, root, now, collectPrivate: true, collectionEnabled: "true" });
      result = { status: ["PENDING", "BLOCKED", "FAILED"].includes(collected.status) ? collected.status : "PENDING", reason: collected.reason };
      if (collected.status === "VALIDATED" && collected.reason === "PRIVATE_CANDIDATE_READY" && collected.collectionComplete === true) {
        const privateRead = async (relativePath) => {
          const base = path.resolve(root, ".runtime", "kis-eod"), target = path.resolve(root, relativePath ?? "");
          if (!target.startsWith(`${base}${path.sep}`)) throw new Error("PRIVATE_MODEL_PATH_INVALID");
          const real = await fs.realpath(target), realRoot = await fs.realpath(root);
          if (!real.startsWith(`${realRoot}${path.sep}.runtime${path.sep}kis-eod${path.sep}`)) throw new Error("PRIVATE_MODEL_PATH_INVALID");
          return JSON.parse(await fs.readFile(real, "utf8"));
        };
        const raw = await privateRead(collected.rawPath), candidate = await privateRead(collected.candidatePath);
        if (candidate.referenceDate !== local.referenceDate) throw new Error("PRIVATE_MODEL_DATE_INVALID");
        result = { ...await persistPrivateModelBundle({ store: privateStore, candidate, raw, runId }), reason: "PRIVATE_MODEL_HEAD_VERIFIED" };
      }
    }
  } catch { result = { status: "FAILED", reason: "PRIVATE_MODEL_COLLECTION_OR_PERSISTENCE_FAILED" }; }
  const checkedAt = new Date(now()).toISOString();
  try { await recordPrivateModelOperation(privateStore, { status: result.status, reason: result.reason, checkedAt, referenceDate: local.referenceDate, runId }); }
  catch { return { status: "FAILED", reason: "PRIVATE_OPERATION_RECORD_FAILED", previousHeadPreserved: true, publicationEligible: false }; }
  return { ...result, checkedAt, referenceDate: local.referenceDate, publicationEligible: false, productionChanged: false };
}

async function cli() {
  const args = process.argv.slice(2);
  if (args.length !== 1 || !["--dry-run", "--collect-private"].includes(args[0])) { console.log("KIS_PRIVATE_MODELS_JSON={\"status\":\"BLOCKED\",\"reason\":\"INVALID_CLI_ARGUMENTS\"}"); process.exitCode = 1; return; }
  const result = await runPrivateKisModels({ collectPrivate: args[0] === "--collect-private" });
  // Only fixed status/reason, dates and hashes. No scores or raw inputs in Actions.
  console.log(`KIS_PRIVATE_MODELS_JSON=${JSON.stringify(result)}`);
  if (["FAILED", "BLOCKED"].includes(result.status)) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await cli();
