import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { publishLiveSignal } from "./publisher.mjs";
import { buildIntradayModelTopSignal, hashIntradayModelTop } from "../../lib/intraday-model-top-official-signal.mjs";

const execute = promisify(execFile);
const git = async (args, cwd) => (await execute("git", args, { cwd, windowsHide: true })).stdout.trim();
const environment = { LIVE_EXECUTOR_PUBLISH_ENABLED: "true", LIVE_EXECUTOR_PUBLICATION_AUTHORIZED: "true", TB_AUTOMATION_READ_TOKEN: "non-secret-test-token" };
const signalPath = "data/intraday-signals/model-top/2026-10-06/1400.json";
const latestPath = "data/intraday-signals/model-top/latest.json";
function fixture(observationType = "LIVE_OBSERVATION") {
  // Synthetic fixture is used solely in an isolated local bare Git repository, never a production endpoint.
  const rows = Array.from({ length: 260 }, (_, index) => {
    const date = new Date("2026-10-02T00:00:00Z"); date.setUTCDate(date.getUTCDate() - index);
    return [date.toISOString().slice(0, 10).replaceAll("-", ""), 100 + index / 10, 102 + index / 10, 98 + index / 10, 100 + index / 10, 1000 + index];
  });
  const seed = { requestedDate: "2026-10-02", generatedAt: "2026-10-06T03:00:00Z", contentHash: "e".repeat(64), sourceManifest: { sources: { officialDailyPrice: { normalizedInputHash: "a".repeat(64), availability: { requestedAt: "2026-10-06T02:58:00Z", observedAt: "2026-10-06T02:59:00Z", referenceDate: "2026-10-02", normalizedInputHash: "a".repeat(64), availabilityStatus: "OBSERVED", availabilityEvidence: "SYSTEM_OBSERVED_BATCH_COLLECTION", outcome: "success" } } }, modelFormulaHashes: { "A-v1": "a".repeat(64), "B-v1": "b".repeat(64), "C-v1": "c".repeat(64), "D-v1": "d".repeat(64) } }, records: [{ code: "000001", name: "Synthetic", market: "KOSPI", eligible: true, rows }] };
  const quote = { asOfDate: "2026-10-06", asOfTime: "14:00:10", receivedAt: "2026-10-06T05:00:11.000Z", open: 199, high: 202, low: 198, price: 200, volume: 2000, change: 5, rate: 2.5 };
  return buildIntradayModelTopSignal({ seed, quotesByCode: new Map([["000001", quote]]), signalDate: "2026-10-06", collectionStartedAt: "2026-10-06T05:00:00.000Z", collectionCompletedAt: "2026-10-06T05:01:00.000Z", observationType });
}
function changeSignal(signal, changes) {
  const body = { ...signal, ...changes };
  delete body.contentHash;
  return { ...body, contentHash: hashIntradayModelTop(body) };
}
async function sandbox(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "tb-live-publisher-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const remote = path.join(root, "remote.git"), checkoutDir = path.join(root, "publisher"), seed = path.join(root, "seed");
  await mkdir(seed);
  await git(["init", "--bare", "--initial-branch=main", remote], root);
  await git(["init", "--initial-branch=main"], seed);
  await git(["config", "user.name", "Test"], seed);
  await git(["config", "user.email", "test@example.invalid"], seed);
  await writeFile(path.join(seed, "README.md"), "isolated synthetic publication test\n");
  await git(["add", "README.md"], seed);
  await git(["commit", "-m", "initial"], seed);
  await git(["remote", "add", "origin", remote], seed);
  await git(["push", "origin", "main"], seed);
  await git(["clone", remote, checkoutDir], root);
  await git(["config", "tightbudget.livePublisher", "true"], checkoutDir);
  await git(["config", "user.name", "Test"], checkoutDir);
  await git(["config", "user.email", "test@example.invalid"], checkoutDir);
  return { root, remote, checkoutDir, seed, dependencies: { acceptedRemotes: new Set([remote]), verifyDeployment: async () => true, sleep: async () => {}, verificationAttempts: 1 } };
}
async function publish(s, overrides = {}) {
  return publishLiveSignal({ signal: fixture(), checkoutDir: s.checkoutDir, env: environment, dependencies: s.dependencies, ...overrides });
}

test("publication is disabled by default and needs explicit publication authority", async () => {
  assert.equal((await publishLiveSignal({ env: {} })).status, "DISABLED");
  await assert.rejects(publishLiveSignal({ env: { LIVE_EXECUTOR_PUBLISH_ENABLED: "true" } }), /AUTHORIZATION_REQUIRED/u);
});

test("isolated local Git publication preserves immutable content, latest pointer and idempotence", async (t) => {
  const s = await sandbox(t), artifact = fixture();
  const result = await publish(s);
  assert.equal(result.status, "PUBLISHED");
  assert.equal(result.publicationVerified, true);
  const stored = JSON.parse(await git(["show", `main:${signalPath}`], s.remote));
  assert.deepEqual(stored, artifact);
  const latest = JSON.parse(await git(["show", `main:${latestPath}`], s.remote));
  assert.equal(latest.contentHash, artifact.contentHash);
  assert.equal(latest.collectionCompletedAt, artifact.collectionCompletedAt);
  const second = await publish(s);
  assert.equal(second.status, "ALREADY_PUBLISHED");
  assert.equal(second.commitSha, result.commitSha);
  assert.equal(await git(["status", "--porcelain"], s.checkoutDir), "");
});

test("TEST_FIXTURE, partial signals and after-window timestamps cannot be published", async (t) => {
  const s = await sandbox(t);
  await assert.rejects(publish(s, { signal: fixture("TEST_FIXTURE") }), /REQUIRES_REAL_READY_LIVE/u);
  await assert.rejects(publish(s, { signal: changeSignal(fixture(), { collection: { successful: 1, failed: 1, ineligible: 0 } }) }), /(?:COLLECTION_INCOMPLETE|PUBLISH_SIGNAL_INVALID)/u);
  await assert.rejects(publish(s, { signal: changeSignal(fixture(), { collectionCompletedAt: "2026-10-06T05:06:00.000Z" }) }), /(?:COLLECTION_WINDOW_INVALID|PUBLISH_SIGNAL_INVALID)/u);
  assert.equal(await git(["rev-list", "--count", "main"], s.remote), "1");
});

test("untrusted remotes, missing dedicated marker and dirty checkouts fail closed", async (t) => {
  const s = await sandbox(t);
  await assert.rejects(publish(s, { dependencies: { ...s.dependencies, acceptedRemotes: new Set() } }), /ORIGIN_NOT_ALLOWED/u);
  await git(["config", "tightbudget.livePublisher", "false"], s.checkoutDir);
  await assert.rejects(publish(s), /DEDICATED_PUBLICATION_CHECKOUT_REQUIRED/u);
  await git(["config", "tightbudget.livePublisher", "true"], s.checkoutDir);
  await writeFile(path.join(s.checkoutDir, "unrelated.txt"), "preserve me");
  await assert.rejects(publish(s), /CHECKOUT_NOT_CLEAN/u);
  assert.equal(await readFile(path.join(s.checkoutDir, "unrelated.txt"), "utf8"), "preserve me");
});

test("immutable content conflicts preserve remote and local existing artifacts", async (t) => {
  const s = await sandbox(t);
  await publish(s);
  const previous = await git(["rev-parse", "main"], s.remote);
  await assert.rejects(publish(s, { signal: changeSignal(fixture(), { extraMetadata: "different immutable content" }) }), /IMMUTABLE_CONFLICT/u);
  assert.equal(await git(["rev-parse", "main"], s.remote), previous);
});

test("newer remote latest dates cannot regress", async (t) => {
  const s = await sandbox(t);
  await mkdir(path.dirname(path.join(s.seed, latestPath)), { recursive: true });
  await writeFile(path.join(s.seed, latestPath), JSON.stringify({ signalDate: "2026-10-07", status: "READY", contentHash: "newer" }));
  await git(["add", latestPath], s.seed); await git(["commit", "-m", "newer pointer"], s.seed); await git(["push", "origin", "main"], s.seed);
  await assert.rejects(publish(s), /LATEST_DATE_REGRESSION/u);
  assert.equal(JSON.parse(await git(["show", `main:${latestPath}`], s.remote)).signalDate, "2026-10-07");
});

test("a concurrent unrelated Git push is safely rebased and retried without force", async (t) => {
  const s = await sandbox(t);
  let pushes = 0;
  s.dependencies.git = async (args, cwd) => {
    assert.equal(args.some((arg) => arg === "--force" || arg === "-f"), false);
    if (args[0] === "push" && ++pushes === 1) {
      await writeFile(path.join(s.seed, "README.md"), "concurrent remote update\n");
      await git(["add", "README.md"], s.seed); await git(["commit", "-m", "concurrent"], s.seed); await git(["push", "origin", "main"], s.seed);
    }
    return git(args, cwd);
  };
  const result = await publish(s);
  assert.equal(result.status, "PUBLISHED");
  assert.equal(pushes, 2);
  assert.equal(await git(["show", "main:README.md"], s.remote), "concurrent remote update");
});

test("bounded push failures retain pending commit and permit a later safe retry", async (t) => {
  const s = await sandbox(t);
  let failures = 0;
  s.dependencies.git = async (args, cwd) => { if (args[0] === "push") { failures += 1; throw new Error("secret-like diagnostic never exposed"); } return git(args, cwd); };
  const result = await publish(s);
  assert.equal(result.status, "PUSH_PENDING"); assert.equal(result.reason, "GIT_PUSH_FAILED"); assert.equal(failures, 3);
  assert.equal(await git(["rev-list", "--count", "main"], s.remote), "1");
  assert.equal(await git(["status", "--porcelain"], s.checkoutDir), "");
  delete s.dependencies.git;
  assert.equal((await publish(s)).status, "PUBLISHED");
});

test("a published commit does not imply Vercel/API publication success", async (t) => {
  const s = await sandbox(t);
  let calls = 0;
  s.dependencies.verifyDeployment = async () => { calls += 1; throw new Error("HTTP_401"); };
  const result = await publish(s);
  assert.equal(result.status, "PUBLISHED"); assert.equal(result.publicationVerified, false); assert.equal(result.publicationReason, "HTTP_401"); assert.equal(calls, 1);
  const retry = await publish(s, { env: { ...environment, TB_AUTOMATION_READ_TOKEN: undefined } });
  assert.equal(retry.publicationReason, "AUTOMATION_READ_TOKEN_UNAVAILABLE");
});

test("concurrent publication calls cannot mutate the same dedicated checkout", async (t) => {
  const s = await sandbox(t);
  let release, entered;
  const blocked = new Promise((resolve) => { release = resolve; });
  const inVerification = new Promise((resolve) => { entered = resolve; });
  s.dependencies.verifyDeployment = async () => { entered(); await blocked; return true; };
  const first = publish(s);
  await inVerification;
  try { await assert.rejects(publish(s), /LIVE_STORE_LOCKED/u); }
  finally { release(); }
  assert.equal((await first).status, "PUBLISHED");
});

test("an interrupted immutable write resumes without reset and publishes exactly one commit", async (t) => {
  const s = await sandbox(t);
  await mkdir(path.dirname(path.join(s.checkoutDir, signalPath)), { recursive: true });
  await writeFile(path.join(s.checkoutDir, signalPath), JSON.stringify(fixture()));
  assert.equal((await publish(s)).status, "PUBLISHED");
  assert.equal(await git(["rev-list", "--count", "main"], s.remote), "2");
  assert.equal(await git(["status", "--porcelain"], s.checkoutDir), "");
  assert.equal((await publish(s)).status, "ALREADY_PUBLISHED");
});

test("an interrupted staged artifact/latest pair resumes the exact planned content", async (t) => {
  const s = await sandbox(t);
  s.dependencies.git = async (args, cwd) => {
    if (args.includes("commit")) throw new Error("SIMULATED_PROCESS_EXIT_BEFORE_COMMIT");
    return git(args, cwd);
  };
  await assert.rejects(publish(s), /SIMULATED_PROCESS_EXIT/u);
  const before = await readFile(path.join(s.checkoutDir, latestPath), "utf8");
  delete s.dependencies.git;
  assert.equal((await publish(s)).status, "PUBLISHED");
  assert.equal(await readFile(path.join(s.checkoutDir, latestPath), "utf8"), before);
  assert.equal(await git(["rev-list", "--count", "main"], s.remote), "2");
});

test("mismatched interrupted content is preserved and never committed", async (t) => {
  const s = await sandbox(t);
  await mkdir(path.dirname(path.join(s.checkoutDir, signalPath)), { recursive: true });
  const mismatched = JSON.stringify(changeSignal(fixture(), { extraMetadata: "not the requested immutable signal" }));
  await writeFile(path.join(s.checkoutDir, signalPath), mismatched);
  await assert.rejects(publish(s), /INTERRUPTED_CONTENT_MISMATCH/u);
  assert.equal(await readFile(path.join(s.checkoutDir, signalPath), "utf8"), mismatched);
  assert.equal(await git(["rev-list", "--count", "main"], s.remote), "1");
});

test("remote latest advancement during interruption refuses recovery without changing files", async (t) => {
  const s = await sandbox(t);
  await mkdir(path.dirname(path.join(s.checkoutDir, signalPath)), { recursive: true });
  const original = JSON.stringify(fixture());
  await writeFile(path.join(s.checkoutDir, signalPath), original);
  await mkdir(path.dirname(path.join(s.seed, latestPath)), { recursive: true });
  await writeFile(path.join(s.seed, latestPath), JSON.stringify({ signalDate: "2026-10-07", status: "READY", contentHash: "newer" }));
  await git(["add", latestPath], s.seed); await git(["commit", "-m", "newer publication"], s.seed); await git(["push", "origin", "main"], s.seed);
  await assert.rejects(publish(s), /LATEST_DATE_REGRESSION/u);
  assert.equal(await readFile(path.join(s.checkoutDir, signalPath), "utf8"), original);
  await assert.rejects(readFile(path.join(s.checkoutDir, latestPath)), { code: "ENOENT" });
  assert.equal(await git(["rev-list", "--count", "main"], s.remote), "2");
});
