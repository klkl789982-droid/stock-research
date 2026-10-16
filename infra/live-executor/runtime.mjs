import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { assertLiveSeedSession } from "../../lib/live-seed-policy.mjs";
import { isLiveInputCodePath } from "../../lib/live-pinned-inputs.mjs";
import { OFFICIAL_SIGNAL_TIME } from "../../lib/intraday-model-top-time-policy.mjs";
const execute = promisify(execFile);
const formulaFiles = ["lib/technical-strength.mjs", "lib/technical-model-features.mjs", "lib/trend-strength.mjs", "lib/entry-strength.mjs", "lib/combined-technical-score.mjs", "lib/intraday-model-top-official-signal.mjs", "lib/intraday-model-b-official-signal.mjs", "lib/intraday-model-top-time-policy.mjs"];
const hash = (value) => createHash("sha256").update(value.replaceAll("\r\n", "\n")).digest("hex");
export async function verifyHostClock({ fetchImpl = fetch, now = Date.now } = {}) {
  const startedAt = now();
  let response;
  try { response = await fetchImpl("https://api.github.com", { method: "HEAD", redirect: "error", signal: AbortSignal.timeout(10000) }); }
  catch { throw new Error("CLOCK_REFERENCE_UNAVAILABLE"); }
  const completedAt = now(), serverAt = Date.parse(response.headers.get("date")), elapsed = completedAt - startedAt;
  if (!response.ok || !Number.isFinite(serverAt) || elapsed < 0 || elapsed > 5000) throw new Error("CLOCK_REFERENCE_UNAVAILABLE");
  const offsetMs = Math.round(serverAt - (startedAt + completedAt) / 2), uncertaintyMs = Math.ceil(elapsed / 2) + 1000;
  if (Math.abs(offsetMs) + uncertaintyMs > 5000) throw new Error("HOST_CLOCK_OFFSET_EXCEEDED");
  return { checkedAt: new Date(completedAt).toISOString(), reference: "githubTlsDateHeader", offsetMs, uncertaintyMs, roundTripMs: elapsed, maximumErrorMs: 5000 };
}
export function repositoryInputs(root, { remote = false, git: injectedGit, readFile = fs.readFile, now = Date.now } = {}) {
  const git = async (...args) => injectedGit ? injectedGit(args) : (await execute("git", ["-c", `safe.directory=${path.resolve(root).replaceAll("\\", "/")}`, ...args], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 60000, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } })).stdout;
  let frozen = null;
  const inputEvidence = new Map();
  async function verifyFormula(expected = frozen) {
    const evidence = {};
    for (const file of formulaFiles) {
      const current = hash(await readFile(path.join(root, file), "utf8"));
      const committed = hash(await git("show", `HEAD:${file}`));
      if (current !== committed || (expected && current !== expected[file])) throw new Error("MODEL_FORMULA_INTEGRITY_FAILED");
      evidence[file] = current;
    }
    frozen ??= evidence;
    return evidence;
  }
  async function loadSeed(date) {
    const folder = "data/analysis/market-seeds";
    let names, inputCommit = null, refreshedAt = null;
    if (remote) {
      const origin = (await git("remote", "get-url", "origin")).trim();
      if (!["https://github.com/klkl789982-droid/stock-research.git", "git@github.com:klkl789982-droid/stock-research.git"].includes(origin)) throw new Error("SEED_ORIGIN_REJECTED");
      refreshedAt = new Date(now()).toISOString();
      await git("fetch", "origin", "main");
      inputCommit = (await git("rev-parse", "origin/main")).trim();
      if (!/^[a-f0-9]{40}$/u.test(inputCommit)) throw new Error("LIVE_INPUT_NOT_READY_REFRESH_COMMIT_INVALID");
      const changed = [...(await git("diff", "--name-only", "-z", "HEAD", inputCommit)).split("\0"), ...(await git("diff", "--name-only", "-z", "HEAD")).split("\0")];
      if (changed.some(isLiveInputCodePath)) throw new Error("LIVE_INPUT_NOT_READY_REFRESH_CODE_MISMATCH");
      names = (await git("ls-tree", "-r", "--name-only", inputCommit, "--", `${folder}/`)).trim().split(/\r?\n/u).map((name) => path.posix.basename(name));
    } else names = await fs.readdir(path.join(root, folder));
    const selected = names.filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/u.test(name) && name.slice(0, 10) < date).sort().at(-1);
    if (!selected) throw new Error("LIVE_INPUT_NOT_READY_PREVIOUS_SESSION_MISSING");
    const seed = JSON.parse(remote ? await git("show", `${inputCommit}:${folder}/${selected}`) : await readFile(path.join(root, folder, selected), "utf8"));
    const evidence = await verifyFormula();
    for (const [version, file] of Object.entries({ "A-v1": formulaFiles[0], "B-v1": formulaFiles[2], "C-v1": formulaFiles[3], "D-v1": formulaFiles[4] })) {
      if (seed.sourceManifest?.modelFormulaHashes?.[version] !== evidence[file]) throw new Error("SEED_FORMULA_HASH_MISMATCH");
    }
    if (remote) inputEvidence.set(seed.contentHash, { inputCommit, seedHash: seed.contentHash, refreshedAt });
    return seed;
  }
  async function verifySeedSession(seed, date, savedEvidence = null) {
    const file = "data/trading-calendar/status.json";
    const evidence = savedEvidence ?? inputEvidence.get(seed.contentHash);
    if (remote && (!/^[a-f0-9]{40}$/u.test(evidence?.inputCommit ?? "") || evidence.seedHash !== seed.contentHash)) throw new Error("LIVE_INPUT_NOT_READY_REFRESH_COMMIT_INVALID");
    const calendarText = remote ? await git("show", `${evidence.inputCommit}:${file}`) : await readFile(path.join(root, file), "utf8");
    const calendarHash = createHash("sha256").update(calendarText).digest("hex");
    if (evidence?.calendarHash && evidence.calendarHash !== calendarHash) throw new Error("LIVE_INPUT_NOT_READY_REFRESH_INPUT_INVALID");
    const previous = assertLiveSeedSession(seed, date, JSON.parse(calendarText));
    if (remote) {
      const readyAt = evidence.readyAt ?? new Date(now()).toISOString();
      if (Date.parse(readyAt) >= Date.parse(`${date}T${OFFICIAL_SIGNAL_TIME}+09:00`)) throw new Error("LIVE_INPUT_NOT_READY_REFRESH_LATE");
      inputEvidence.set(seed.contentHash, { ...evidence, calendarHash, readyAt });
    }
    return previous;
  }
  return { loadSeed, verifyFormula, verifySeedSession, getInputProvenance: (seed) => inputEvidence.get(seed.contentHash) ?? null, verifyClock: verifyHostClock };
}
