import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, open, lstat, link, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { validateIntradayModelTopSignal, hashIntradayModelTop, OFFICIAL_SIGNAL_TIME, OFFICIAL_SIGNAL_WINDOW_END, isCurrentIntradayModelTopSignal } from "../../lib/intraday-model-top-official-signal.mjs";
import { CURRENT_LIVE_PROFILE } from "../../lib/intraday-model-top-time-policy.mjs";
import { inspectLiveProductionDeployment } from "../../lib/daily-production-deployment-verifier.mjs";
import { createLocalExecutionStore } from "./store.mjs";

const execFileAsync = promisify(execFile);
const REMOTES = new Set(["https://github.com/klkl789982-droid/stock-research.git", "https://github.com/klkl789982-droid/stock-research", "git@github.com:klkl789982-droid/stock-research.git"]);
const LATEST_PATH = "data/intraday-signals/model-top/latest.json";
const MODEL_VERSIONS = ["A-v1", "B-v1", "C-v1", "D-v1"];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function executeGit(args, cwd) {
  try {
    return (await execFileAsync("git", args, { cwd, timeout: 60_000, maxBuffer: 64 * 1024 * 1024, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } })).stdout.trim();
  } catch {
    // Git errors may contain remote URLs or credential-helper output. Never propagate those strings.
    throw new Error("GIT_COMMAND_FAILED");
  }
}

function validatePublicationSignal(signal) {
  if (!isCurrentIntradayModelTopSignal(signal)) throw new Error("PUBLISH_SIGNAL_INVALID");
  if (signal.observationType !== "LIVE_OBSERVATION" || signal.status !== "READY" || signal.source?.provider !== "KIS") throw new Error("PUBLISH_REQUIRES_REAL_READY_LIVE_SIGNAL");
  const start = Date.parse(`${signal.signalDate}T${OFFICIAL_SIGNAL_TIME}+09:00`);
  const end = Date.parse(`${signal.signalDate}T${OFFICIAL_SIGNAL_WINDOW_END}+09:00`);
  const started = Date.parse(signal.collectionStartedAt), completed = Date.parse(signal.collectionCompletedAt);
  if (!Number.isFinite(started) || !Number.isFinite(completed) || started < start || started > end || completed < started || completed > end) throw new Error("PUBLISH_COLLECTION_WINDOW_INVALID");
  const available = signal.records.filter((record) => record.dataStatus === "AVAILABLE");
  if (!available.length || signal.collection?.failed !== 0 || available.length !== signal.universe?.eligibleCount || available.length !== signal.collection?.successful || signal.records.length !== signal.universe?.sourceCount) throw new Error("PUBLISH_COLLECTION_INCOMPLETE");
  if (signal.records.some((record) => !["AVAILABLE", "INELIGIBLE"].includes(record.dataStatus))) throw new Error("PUBLISH_COLLECTION_INCOMPLETE");
  for (const record of available) {
    const quote = record.quote;
    const received = Date.parse(quote?.receivedAt);
    const observed = Date.parse(`${quote?.asOfDate}T${quote?.asOfTime}+09:00`);
    if (quote?.asOfDate !== signal.signalDate || !Number.isFinite(observed) || observed < start || observed > end || !Number.isFinite(received) || received < observed || received > completed) throw new Error("PUBLISH_QUOTE_TIMESTAMP_INVALID");
    if (MODEL_VERSIONS.some((model) => !Number.isFinite(record.scores?.[model]) || !Number.isInteger(record.ranks?.[model]) || record.ranks[model] < 1)) throw new Error("PUBLISH_MODEL_RESULT_INCOMPLETE");
  }
}

async function readJson(file) {
  try { return JSON.parse(await readFile(file, "utf8")); } catch (error) { if (error.code === "ENOENT") return null; throw new Error("PUBLISH_EXISTING_JSON_INVALID"); }
}

async function ensureNoSymlinks(root, relative) {
  let current = root;
  for (const part of relative.split("/")) {
    current = path.join(current, part);
    try { if ((await lstat(current)).isSymbolicLink()) throw new Error("PUBLISH_SYMLINK_NOT_ALLOWED"); } catch (error) { if (error.code === "ENOENT") return; throw error; }
  }
}

async function writePublicationFile(gitDir, destination, value, createOnly) {
  const temp = path.join(gitDir, `live-publication-${randomUUID()}.tmp`);
  const handle = await open(temp, "wx", 0o600);
  try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8"); await handle.sync(); }
  finally { await handle.close(); }
  try {
    await mkdir(path.dirname(destination), { recursive: true });
    if (createOnly) await link(temp, destination);
    else await rename(temp, destination);
  } finally { await unlink(temp).catch((error) => { if (error.code !== "ENOENT") throw error; }); }
}

async function assertRemoteCandidate(git, signal, signalPath) {
  const files = new Set((await git(["ls-tree", "-r", "--name-only", "origin/main", "--", signalPath, LATEST_PATH])).split("\n"));
  let remoteSignal = null;
  if (files.has(signalPath)) {
    try { remoteSignal = JSON.parse(await git(["show", `origin/main:${signalPath}`])); } catch { throw new Error("PUBLISH_REMOTE_SIGNAL_INVALID"); }
    if (validateIntradayModelTopSignal(remoteSignal).length || remoteSignal.contentHash !== signal.contentHash) throw new Error("PUBLISH_IMMUTABLE_CONFLICT");
  }
  if (files.has(LATEST_PATH)) {
    let latest;
    try { latest = JSON.parse(await git(["show", `origin/main:${LATEST_PATH}`])); } catch { throw new Error("PUBLISH_REMOTE_LATEST_INVALID"); }
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(latest?.signalDate ?? "")) throw new Error("PUBLISH_REMOTE_LATEST_INVALID");
    if (latest.signalDate > signal.signalDate) throw new Error("PUBLISH_LATEST_DATE_REGRESSION");
    if (latest.signalDate === signal.signalDate && latest.status === "READY" && latest.contentHash !== signal.contentHash) throw new Error("PUBLISH_IMMUTABLE_CONFLICT");
  }
  return remoteSignal;
}

function plannedLatest(signal, signalPath, updatedAt = new Date().toISOString()) {
  return {
    schemaVersion: CURRENT_LIVE_PROFILE.schemaVersion, observationPolicyId: CURRENT_LIVE_PROFILE.policyId, artifactType: "intradayModelTopLatestStatus", signalDate: signal.signalDate,
    officialSignalTime: OFFICIAL_SIGNAL_TIME, status: "READY", signalPath, contentHash: signal.contentHash,
    collection: signal.collection, collectionStartedAt: signal.collectionStartedAt, collectionCompletedAt: signal.collectionCompletedAt,
    updatedAt,
  };
}

async function inspectInterruptedPublication(git, root, signal, signalPath, allowedPaths) {
  const dirty = new Set([
    ...(await git(["diff", "--name-only", "HEAD"])).split("\n"),
    ...(await git(["ls-files", "--others", "--exclude-standard"])).split("\n"),
  ].filter(Boolean));
  if (!dirty.size) return false;
  if ([...dirty].some((file) => !allowedPaths.has(file))) throw new Error("PUBLISH_CHECKOUT_NOT_CLEAN");
  await ensureNoSymlinks(root, signalPath);
  await ensureNoSymlinks(root, LATEST_PATH);
  const existing = await readJson(path.join(root, signalPath));
  if (!existing || validateIntradayModelTopSignal(existing).length || existing.contentHash !== signal.contentHash) throw new Error("PUBLISH_INTERRUPTED_CONTENT_MISMATCH");
  const latest = await readJson(path.join(root, LATEST_PATH));
  if (dirty.has(LATEST_PATH)) {
    if (!latest || !Number.isFinite(Date.parse(latest.updatedAt)) || hashIntradayModelTop(latest) !== hashIntradayModelTop(plannedLatest(signal, signalPath, latest.updatedAt))) throw new Error("PUBLISH_INTERRUPTED_CONTENT_MISMATCH");
  } else if (latest) {
    if (latest.schemaVersion !== CURRENT_LIVE_PROFILE.schemaVersion || latest.observationPolicyId !== CURRENT_LIVE_PROFILE.policyId || latest.artifactType !== "intradayModelTopLatestStatus" || typeof latest.status !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(latest.signalDate ?? "")) throw new Error("PUBLISH_INTERRUPTED_CONTENT_MISMATCH");
    if (latest.signalDate > signal.signalDate) throw new Error("PUBLISH_LATEST_DATE_REGRESSION");
  }
  return true;
}

async function verifyDeployment(signal, env, verify, pause, attempts, delayMs) {
  if (!env.TB_AUTOMATION_READ_TOKEN) return { publicationVerified: false, publicationReason: "AUTOMATION_READ_TOKEN_UNAVAILABLE" };
  let reason = "LIVE_DEPLOYMENT_PENDING";
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      if (await verify({ siteUrl: "https://stock-research-chi.vercel.app", expectedSignalDate: signal.signalDate, expectedContentHash: signal.contentHash, automationToken: env.TB_AUTOMATION_READ_TOKEN })) return { publicationVerified: true, publicationReason: null };
    } catch (error) {
      reason = /^HTTP_\d+$/u.test(error?.message ?? "") ? error.message : "LIVE_DEPLOYMENT_UNAVAILABLE";
      if (["HTTP_401", "HTTP_403"].includes(reason)) break;
    }
    if (attempt + 1 < attempts) await pause(delayMs);
  }
  return { publicationVerified: false, publicationReason: reason };
}

/**
 * Opt-in publishing from a dedicated clean clone, never from the application's checkout.
 * Configure that clone once with `git config tightbudget.livePublisher true`.
 * Test dependency injection is explicit and cannot be enabled by an environment flag.
 */
export async function publishLiveSignal(options) {
  const { env = process.env, checkoutDir } = options;
  if (env.LIVE_EXECUTOR_PUBLISH_ENABLED !== "true") return { status: "DISABLED", publicationVerified: false, reason: "PUBLISH_DISABLED" };
  if (env.LIVE_EXECUTOR_PUBLICATION_AUTHORIZED !== "true") throw new Error("LIVE_PUBLICATION_AUTHORIZATION_REQUIRED");
  validatePublicationSignal(options.signal);
  if (!checkoutDir || !path.isAbsolute(checkoutDir)) throw new Error("DEDICATED_PUBLICATION_CHECKOUT_REQUIRED");
  const root = path.resolve(checkoutDir);
  // Reuse the executor's cross-process lock and dead-owner recovery outside Git.
  const lockStore = createLocalExecutionStore(path.join(path.dirname(root), `.${path.basename(root)}-publication-lock`));
  return lockStore.withLock("publication", () => publishUnlocked(options));
}

async function publishUnlocked({ signal, checkoutDir, env = process.env, dependencies = {} }) {
  if (env.LIVE_EXECUTOR_PUBLISH_ENABLED !== "true") return { status: "DISABLED", publicationVerified: false, reason: "PUBLISH_DISABLED" };
  if (env.LIVE_EXECUTOR_PUBLICATION_AUTHORIZED !== "true") throw new Error("LIVE_PUBLICATION_AUTHORIZATION_REQUIRED");
  validatePublicationSignal(signal);
  if (!checkoutDir || !path.isAbsolute(checkoutDir)) throw new Error("DEDICATED_PUBLICATION_CHECKOUT_REQUIRED");
  const root = path.resolve(checkoutDir);
  const git = (args) => (dependencies.git ?? executeGit)(args, root);
  const acceptedRemotes = dependencies.acceptedRemotes ?? REMOTES;
  if (!acceptedRemotes.has(await git(["remote", "get-url", "origin"]))) throw new Error("PUBLISH_ORIGIN_NOT_ALLOWED");
  if (await git(["config", "--get", "tightbudget.livePublisher"]) !== "true") throw new Error("DEDICATED_PUBLICATION_CHECKOUT_REQUIRED");
  if (path.resolve(await git(["rev-parse", "--show-toplevel"])) !== root || await git(["branch", "--show-current"]) !== "main") throw new Error("PUBLISH_MAIN_CHECKOUT_REQUIRED");
  const signalPath = `data/intraday-signals/model-top/${signal.signalDate}/${CURRENT_LIVE_PROFILE.slot}.json`;
  const allowedPaths = new Set([signalPath, LATEST_PATH]);
  const recovering = await inspectInterruptedPublication(git, root, signal, signalPath, allowedPaths);
  await ensureNoSymlinks(root, signalPath);
  const localSignal = await readJson(path.join(root, signalPath));
  if (localSignal && (validateIntradayModelTopSignal(localSignal).length || localSignal.contentHash !== signal.contentHash)) throw new Error("PUBLISH_IMMUTABLE_CONFLICT");
  await git(["fetch", "origin", "main"]);
  const remoteSignal = await assertRemoteCandidate(git, signal, signalPath);
  // Only our two allowed files may be present in local pending publication commits.
  const pendingFiles = (await git(["log", "--format=", "--name-only", "origin/main..HEAD"])).split("\n").filter(Boolean);
  if (pendingFiles.some((file) => !allowedPaths.has(file))) throw new Error("PUBLISH_UNRELATED_PENDING_COMMITS");
  // An interrupted write is completed and committed locally before rebasing.
  // Its complete content was checked above; no unrelated work is reset or stashed.
  if (!recovering) {
    try { await git(["rebase", "origin/main"]); } catch { try { await git(["rebase", "--abort"]); } catch { /* No rebase might have started. */ } throw new Error("PUBLISH_REBASE_CONFLICT"); }
  }
  await ensureNoSymlinks(root, signalPath);
  await ensureNoSymlinks(root, LATEST_PATH);
  const existing = await readJson(path.join(root, signalPath));
  if (existing && (validateIntradayModelTopSignal(existing).length || existing.contentHash !== signal.contentHash)) throw new Error("PUBLISH_IMMUTABLE_CONFLICT");
  const latest = await readJson(path.join(root, LATEST_PATH));
  if (latest?.signalDate > signal.signalDate) throw new Error("PUBLISH_LATEST_DATE_REGRESSION");
  if (latest?.signalDate === signal.signalDate && latest.status === "READY" && latest.contentHash !== signal.contentHash) throw new Error("PUBLISH_IMMUTABLE_CONFLICT");
  const gitDir = await git(["rev-parse", "--absolute-git-dir"]);
  if (!existing) {
    await writePublicationFile(gitDir, path.join(root, signalPath), signal, true);
  }
  if (!(latest?.signalDate === signal.signalDate && latest?.status === "READY" && latest?.contentHash === signal.contentHash)) {
    const latestStatus = plannedLatest(signal, signalPath);
    await writePublicationFile(gitDir, path.join(root, LATEST_PATH), latestStatus, false);
  }
  await git(["add", "--", signalPath, LATEST_PATH]);
  const staged = (await git(["diff", "--cached", "--name-only"])).split("\n").filter(Boolean);
  if (staged.some((file) => !allowedPaths.has(file))) throw new Error("PUBLISH_STAGE_ALLOWLIST_VIOLATION");
  if (staged.length) await git(["-c", "user.name=Tight Budget LIVE Executor", "-c", "user.email=live-executor@users.noreply.github.com", "commit", "-m", `data: LIVE signal ${signal.signalDate}`, "--", ...staged]);
  const ahead = Number(await git(["rev-list", "--count", "origin/main..HEAD"]));
  const base = { signalDate: signal.signalDate, contentHash: signal.contentHash, signalPath };
  const verify = dependencies.verifyDeployment ?? inspectLiveProductionDeployment;
  const pause = dependencies.sleep ?? sleep;
  const attempts = Math.min(24, Math.max(1, dependencies.verificationAttempts ?? 24));
  const delayMs = dependencies.verificationDelayMs ?? 15_000;
  if (!ahead) return { ...base, status: remoteSignal ? "ALREADY_PUBLISHED" : "NO_CHANGE", commitSha: await git(["rev-parse", "HEAD"]), ...await verifyDeployment(signal, env, verify, pause, attempts, delayMs) };
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    // Guard latest date/content immediately before every push. The server still enforces fast-forward.
    await git(["fetch", "origin", "main"]);
    await assertRemoteCandidate(git, signal, signalPath);
    try { await git(["rebase", "origin/main"]); } catch { try { await git(["rebase", "--abort"]); } catch { /* Preserve pending commit. */ } throw new Error("PUBLISH_REBASE_CONFLICT"); }
    try {
      await git(["push", "origin", "HEAD:main"]);
      return { ...base, status: "PUBLISHED", pushAttempts: attempt, commitSha: await git(["rev-parse", "HEAD"]), ...await verifyDeployment(signal, env, verify, pause, attempts, delayMs) };
    } catch {
      if (attempt === 3) return { ...base, status: "PUSH_PENDING", pushAttempts: attempt, commitSha: await git(["rev-parse", "HEAD"]), publicationVerified: false, reason: "GIT_PUSH_FAILED" };
      await pause(1_000);
    }
  }
}
