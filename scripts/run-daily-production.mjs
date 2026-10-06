import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createPublicEodQuery, createPublicEodRequestShape, normalizePublicEodRows } from "../lib/public-eod-request.mjs";
import { LATEST_PUBLIC_EOD_MAX_ATTEMPTS, runPublicEodRequestWithRetry } from "../lib/public-eod-retry-policy.mjs";
import { validateSnapshot } from "../lib/model-history-schema.mjs";
import { assertPreflightPromotionReady } from "../lib/daily-data-contract-preflight.mjs";
import { AVAILABILITY_STATUS, createSourceAvailabilityEvidence } from "../lib/source-availability.mjs";
import { writeOutcomeCoverageArtifacts } from "../lib/outcome-coverage-reconciliation.mjs";
import { writeModelMaturityCoverageReport } from "../lib/model-maturity-coverage-report.mjs";
import { assertPromotionFiles, classifyLatestProbeFailure, classifySameDate, createCompactModelHistory, createDailyRunManifest, createDailyTopFreshnessStatus, DAILY_RUN_STATUS, evaluatePromotionCandidate, markManifestPromoted, resolveOfficialReferenceDate, validateCompactModelHistory } from "../lib/daily-production.mjs";

const root = process.cwd();
const option = (name) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const promotionManifest = option("mark-promoted");
if (promotionManifest) {
  const target = path.resolve(root, promotionManifest); const manifest = JSON.parse(await fs.readFile(target, "utf8"));
  await fs.writeFile(target, `${JSON.stringify(markManifestPromoted(manifest, new Date().toISOString()), null, 2)}\n`, "utf8");
  console.log(`PROMOTED_MANIFEST=${path.relative(root, target).replaceAll("\\", "/")}`); process.exit(0);
}

const startedAt = new Date().toISOString();
const runId = option("run-id") ?? `daily-${startedAt.replace(/[-:TZ.]/gu, "").slice(0, 14)}`;
const requestedDate = option("date");
const serviceKey = process.env.DATA_GO_KR_SERVICE_KEY;
if (!serviceKey) throw new Error("DATA_GO_KR_SERVICE_KEY가 없습니다.");
const historyDir = path.join(root, "data", "history");
const historyNames = (await fs.readdir(historyDir)).filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/u.test(name)).sort();
const previousProductionReferenceDate = historyNames.at(-1)?.slice(0, 10) ?? null;
const sourceGitSha = await new Promise((resolve) => { const child = spawn("git", ["rev-parse", "HEAD"], { cwd: root, stdio: ["ignore", "pipe", "ignore"] }); let output = ""; child.stdout.on("data", (chunk) => { output += chunk; }); child.on("close", () => resolve(output.trim() || null)); });

async function latestOfficialDate() {
  if (requestedDate) { if (!/^\d{4}-\d{2}-\d{2}$/u.test(requestedDate)) throw new Error("--date=YYYY-MM-DD 형식이 필요합니다."); return requestedDate; }
  console.log("DAILY_PRODUCTION_PROBE stage=started operation=getStockPriceInfo credential=present");
  const universe = JSON.parse(await fs.readFile(path.join(root, "data", "universe.json"), "utf8"));
  const shape = createPublicEodRequestShape({ code: universe.stocks[0].code, purpose: "dailyProductionLatestProbe", pageNo: 1, numOfRows: 5 });
  const query = createPublicEodQuery(shape);
  const probeRequestedAt = new Date().toISOString();
  const probe = await runPublicEodRequestWithRetry({
    maxAttempts: LATEST_PUBLIC_EOD_MAX_ATTEMPTS,
    latestMode: true,
    onRetry: ({ attempt, nextAttempt, maxAttempts, delayMs, outcome, errorCategory }) => {
      console.log(`DAILY_PRODUCTION_PROBE stage=retry attempt=${attempt} nextAttempt=${nextAttempt} maxAttempts=${maxAttempts} delayMs=${delayMs} outcome=${outcome} category=${errorCategory}`);
    },
    execute: async () => {
      try {
        const response = await fetch(`https://apis.data.go.kr/1160100/service/GetStockSecuritiesInfoService/getStockPriceInfo?serviceKey=${serviceKey}&${query}`, { signal: AbortSignal.timeout(20_000) });
        console.log(`DAILY_PRODUCTION_PROBE stage=http-response status=${response.status} ok=${response.ok}`);
        if (!response.ok) { const error = new Error(`LATEST_PROBE_HTTP_${response.status}`); error.httpStatus = response.status; throw error; }
        const contentType = response.headers.get("content-type") ?? "";
        console.log(`DAILY_PRODUCTION_PROBE stage=response-format category=${contentType.toLowerCase().includes("json") ? "json" : "non-json-or-unspecified"}`);
        let payload;
        try { payload = await response.json(); } catch (error) { const failure = new SyntaxError("LATEST_PROBE_INVALID_JSON", { cause: error }); failure.observabilityOutcome = "invalidResponse"; throw failure; }
        const businessCode = String(payload?.response?.header?.resultCode ?? "UNKNOWN");
        console.log(`DAILY_PRODUCTION_PROBE stage=business-response category=${businessCode === "00" ? "success" : "error"}`);
        if (businessCode !== "00") { const failure = new Error(`LATEST_PROBE_BUSINESS_${businessCode.replace(/[^A-Z0-9_-]/giu, "_").slice(0, 40)}`); failure.businessCode = businessCode; throw failure; }
        const normalized = normalizePublicEodRows(payload?.response?.body?.items?.item, { code: shape.code });
        return { latestBasDt: normalized.rows[0]?.basDt ?? null, recordCount: normalized.rows.length };
      } catch (error) { throw error; }
    },
  });
  const compact = probe.value?.latestBasDt;
  if (!/^\d{8}$/u.test(String(compact ?? ""))) throw new Error("LATEST_PROBE_INVALID_RESPONSE");
  latestProbeAvailability = createSourceAvailabilityEvidence({
    source: "공공데이터포털", operation: "getStockPriceInfoLatestProbe",
    referenceDate: `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`,
    requestedAt: probeRequestedAt, observedAt: new Date().toISOString(), sourceTimestamp: compact,
    sourceTimestampSemantics: "marketDateBasDt", sourcePublishedAt: null,
    minObservedBasDt: compact, maxObservedBasDt: compact,
    availabilityEvidence: "SYSTEM_OBSERVED_PROBE_RESPONSE", availabilityStatus: AVAILABILITY_STATUS.OBSERVED,
    recordCount: probe.value.recordCount, normalizedInputHash: null,
    requestId: createHash("sha256").update(JSON.stringify(shape)).digest("hex"), outcome: "success",
  });
  console.log(`DAILY_PRODUCTION_PROBE stage=parsed-latest-date present=true date=${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`);
  return `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
}

async function writeManifest(manifest) {
  const directory = path.join(root, "data", "daily-runs", manifest.referenceDate ?? "unknown"); await fs.mkdir(directory, { recursive: true });
  const target = path.join(directory, `${runId}.json`); await fs.writeFile(target, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" }); return path.relative(root, target).replaceAll("\\", "/");
}
async function writeFreshnessStatus({ snapshotReferenceDate, observedOfficialDate, sourceAvailable, runStatus, sourceEvidence, reason = null }) {
  const status = createDailyTopFreshnessStatus({ snapshotReferenceDate, observedOfficialDate, sourceAvailable, runStatus, updatedAt: new Date().toISOString(), sourceEvidence, reason });
  const directory = path.join(root, "data", "daily-production-status");
  const target = path.join(directory, "latest.json");
  const temporary = `${target}.${runId}.tmp`;
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(temporary, `${JSON.stringify(status, null, 2)}\n`, "utf8");
  await fs.rename(temporary, target);
  return path.relative(root, target).replaceAll("\\", "/");
}
const hashFile = async (file) => createHash("sha256").update(await fs.readFile(file)).digest("hex");
const runScript = (script, args) => new Promise((resolve, reject) => { const child = spawn(process.execPath, [script, ...args], { cwd: root, env: process.env, stdio: "inherit" }); child.on("error", reject); child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`${script} 종료 코드 ${code}`))); });

let referenceDate = requestedDate ?? null;
let latestProbeAvailability = null;
try {
  const observedDate = await latestOfficialDate();
  const collectionDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const dateDecision = resolveOfficialReferenceDate({ observedDate, previousProductionReferenceDate, collectionDate });
  if (dateDecision.status === "invalid" || dateDecision.status === "stale") throw new Error(`LATEST_PROBE_${dateDecision.reason.replace(/([a-z])([A-Z])/gu, "$1_$2").toUpperCase()}`);
  referenceDate = dateDecision.referenceDate;
  if (dateDecision.status === "noNewOfficialEod") {
    const manifest = createDailyRunManifest({ referenceDate, runId, status: DAILY_RUN_STATUS.NO_NEW_OFFICIAL_EOD, startedAt, completedAt: new Date().toISOString(), sourceGitSha, previousProductionReferenceDate, sourceEvidence: latestProbeAvailability ? [latestProbeAvailability] : [], reason: dateDecision.reason });
    const manifestPath = await writeManifest(manifest);
    const freshnessPath = await writeFreshnessStatus({ snapshotReferenceDate: previousProductionReferenceDate, observedOfficialDate: referenceDate, sourceAvailable: true, runStatus: manifest.status, sourceEvidence: [latestProbeAvailability].filter(Boolean), reason: dateDecision.reason });
    console.log(`DAILY_PRODUCTION_RESULT_JSON=${JSON.stringify({ status: manifest.status, referenceDate, runId, manifestPath, freshnessPath, promotionFiles: [] })}`); process.exit(0);
  }
  await runScript("scripts/run-daily-history.mjs", [`--date=${referenceDate}`, `--observed-date=${referenceDate}`]);
  const outcomeCoverage = await writeOutcomeCoverageArtifacts({ root, coverageAsOfDate: referenceDate });
  const maturityCoverage = await writeModelMaturityCoverageReport({ root });
  const paths = { snapshot: path.join(root, "data", "history", `${referenceDate}.json`), ledger: path.join(root, "data", "market-prices", `${referenceDate}.json`), universe: path.join(root, "data", "universe-history", `${referenceDate}.json`), market: path.join(root, "data", "analysis", "market", `${referenceDate}.json`), seed: path.join(root, "data", "analysis", "market-seeds", `${referenceDate}.json`) };
  const [snapshot, ledger, universeArchive, market, seed] = await Promise.all(Object.values(paths).map((file) => fs.readFile(file, "utf8").then(JSON.parse)));
  const snapshotErrors = validateSnapshot(snapshot, snapshot.universeSummary?.originalUniverse?.count ?? snapshot.records.length);
  if (snapshotErrors.length || snapshot.dataQuality?.structuralStatus !== "passed") throw new Error(`CANDIDATE_INVALID:${snapshotErrors.join(",") || snapshot.dataQuality?.structuralStatus}`);
  assertPreflightPromotionReady(snapshot);
  if (ledger.date !== referenceDate || universeArchive.requestedDate !== referenceDate || market.requestedDate !== referenceDate || seed.requestedDate !== referenceDate) throw new Error("CANDIDATE_DATE_MISMATCH");
  const compact = createCompactModelHistory(snapshot); const compactErrors = validateCompactModelHistory(compact, snapshot.records.length); if (compactErrors.length) throw new Error(`COMPACT_HISTORY_INVALID:${compactErrors.join(",")}`);
  const promotion = evaluatePromotionCandidate({ collectionCompleted: true, snapshotValidationErrors: snapshotErrors, structuralFatalCount: snapshot.dataQuality?.structuralFatalCount ?? (snapshot.dataQuality?.structuralStatus === "passed" ? 0 : 1), requiredArtifactsPresent: true, compactValidationErrors: compactErrors });
  if (!promotion.eligible) throw new Error(`PROMOTION_BLOCKED:${promotion.reasons.join(",")}`);
  const compactDir = path.join(root, "data", "model-history"); await fs.mkdir(compactDir, { recursive: true }); const compactPath = path.join(compactDir, `${referenceDate}.json`);
  let existing = null; try { existing = JSON.parse(await fs.readFile(compactPath, "utf8")); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  const sameDate = classifySameDate(existing, compact);
  if (sameDate === "revisionRequired") {
    const manifest = createDailyRunManifest({ referenceDate, runId, status: DAILY_RUN_STATUS.REVISION_REQUIRES_APPROVAL, startedAt, completedAt: new Date().toISOString(), sourceGitSha, previousProductionReferenceDate, sourceEvidence: [snapshot.sourceManifest?.sources?.officialDailyPrice?.availability, snapshot.sourceManifest?.sources?.securityMaster?.availability].filter(Boolean), snapshotHash: compact.sourceSnapshotHash, compactHistoryHash: compact.contentHash, reason: "sameDateDifferentHash" });
    const manifestPath = await writeManifest(manifest);
    const freshnessPath = await writeFreshnessStatus({ snapshotReferenceDate: previousProductionReferenceDate, observedOfficialDate: referenceDate, sourceAvailable: true, runStatus: manifest.status, sourceEvidence: [latestProbeAvailability].filter(Boolean), reason: manifest.reason });
    console.log(`DAILY_PRODUCTION_RESULT_JSON=${JSON.stringify({ status: manifest.status, referenceDate, runId, manifestPath, freshnessPath, promotionFiles: [] })}`); process.exitCode = 3;
  } else {
    if (sameDate === "create") await fs.writeFile(compactPath, `${JSON.stringify(compact, null, 2)}\n`, { flag: "wx" });
    const summary = snapshot.universeSummary; const sourceEvidence = [snapshot.sourceManifest?.sources?.officialDailyPrice?.availability, snapshot.sourceManifest?.sources?.securityMaster?.availability].filter(Boolean); const manifest = createDailyRunManifest({ referenceDate, runId, status: DAILY_RUN_STATUS.CANDIDATE_VALIDATED, startedAt, completedAt: new Date().toISOString(), sourceGitSha, previousProductionReferenceDate, snapshotHash: compact.sourceSnapshotHash, universeHash: summary.originalUniverse.codesHash, priceLedgerHash: ledger.contentHash ?? await hashFile(paths.ledger), originalCount: summary.originalUniverse.count, eligibleCount: summary.qualityEligibleUniverse.count, quarantineCount: summary.quarantinedUniverse.count, rankingUniverseSizeByModel: Object.fromEntries(Object.entries(summary.rankingUniverse).map(([key, value]) => [key, value.count])), issueManifestHash: snapshot.dataQuality?.issueManifestHash ?? null, compactHistoryHash: compact.contentHash, sourceEvidence, provenance: snapshot.sourceManifest });
    const manifestPath = await writeManifest(manifest);
    const freshnessPath = await writeFreshnessStatus({ snapshotReferenceDate: referenceDate, observedOfficialDate: referenceDate, sourceAvailable: true, runStatus: manifest.status, sourceEvidence: [latestProbeAvailability].filter(Boolean) });
    const statusLines = (await new Promise((resolve) => { const child = spawn("git", ["status", "--porcelain=v1", "-uall"], { cwd: root, stdio: ["ignore", "pipe", "ignore"] }); let output = ""; child.stdout.on("data", (chunk) => { output += chunk; }); child.on("close", () => resolve(output)); })).split(/\r?\n/u).filter(Boolean);
    const changed = statusLines.map((line) => line.slice(3).replaceAll("\\", "/")).filter((file) => !file.startsWith("data/daily-runs/") || file === manifestPath);
    changed.push(...outcomeCoverage.changedPaths);
    changed.push(...maturityCoverage.changedPaths);
    changed.push(`data/model-history/${referenceDate}.json`, manifestPath);
    changed.push(freshnessPath);
    const promotionFiles = assertPromotionFiles(changed, referenceDate, runId);
    console.log(`DAILY_PRODUCTION_RESULT_JSON=${JSON.stringify({ status: manifest.status, referenceDate, runId, manifestPath, freshnessPath, promotionFiles })}`);
  }
} catch (error) {
  const failureReason = referenceDate == null ? classifyLatestProbeFailure(error) : (error instanceof Error ? error.message.slice(0, 500) : "unknownFailure");
  const manifest = createDailyRunManifest({ referenceDate, runId, status: DAILY_RUN_STATUS.FAILED, startedAt, completedAt: new Date().toISOString(), sourceGitSha, previousProductionReferenceDate, sourceEvidence: latestProbeAvailability ? [latestProbeAvailability] : [], reason: failureReason });
  const manifestPath = await writeManifest(manifest).catch(() => null);
  const freshnessPath = await writeFreshnessStatus({ snapshotReferenceDate: previousProductionReferenceDate, observedOfficialDate: latestProbeAvailability?.referenceDate ?? null, sourceAvailable: Boolean(latestProbeAvailability), runStatus: manifest.status, sourceEvidence: [latestProbeAvailability].filter(Boolean), reason: failureReason }).catch(() => null);
  console.error(`DAILY_PRODUCTION_FAILED reason=${failureReason}`); console.log(`DAILY_PRODUCTION_RESULT_JSON=${JSON.stringify({ status: manifest.status, referenceDate, runId, manifestPath, freshnessPath, promotionFiles: [], reason: failureReason })}`); process.exitCode = 1;
}
