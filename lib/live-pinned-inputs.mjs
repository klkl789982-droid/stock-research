import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { CURRENT_LIVE_PROFILE } from "./intraday-model-top-time-policy.mjs";
import { validateIntradayMarketSeed } from "./intraday-market-seed.mjs";
import { assertLiveSeedSession } from "./live-seed-policy.mjs";

const execute = promisify(execFile);
const remotes = new Set(["https://github.com/klkl789982-droid/stock-research.git", "https://github.com/klkl789982-droid/stock-research", "git@github.com:klkl789982-droid/stock-research.git"]);
export const isLiveInputCodePath = (name) => !/^(?:data|docs)\//u.test(name) && /(?:\.(?:[cm]?js|[cm]?ts|tsx|jsx|json|ya?ml)|(?:^|\/)package-lock\.json)$/u.test(name);
const fail = (suffix) => { throw new Error(`LIVE_INPUT_NOT_READY_${suffix}`); };

// Fetches existing origin/main once; it never checks out, resets, stages or writes
// source/data files. Seed and calendar are read from one immutable Git commit.
// This opt-in producer operation is not used by ordinary CLI or dry-run mode.
export async function loadPinnedLiveInputs({ root, signalDate, now = Date.now, wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), git: injectedGit } = {}) {
  const cutoff = Date.parse(`${signalDate}T${CURRENT_LIVE_PROFILE.signalTime}+09:00`);
  if (!Number.isFinite(cutoff)) fail("REFRESH_DATE_INVALID");
  const refreshAt = cutoff - 60_000;
  if (cutoff - now() > 20 * 60_000) fail("REFRESH_TOO_EARLY");
  if (now() < refreshAt) await wait(refreshAt - now());
  const checkDeadline = () => { if (now() >= cutoff) fail("REFRESH_LATE"); };
  checkDeadline();
  const refreshedAt = new Date(now()).toISOString();
  const git = async (args) => {
    checkDeadline();
    try {
      const value = injectedGit ? await injectedGit(args) : (await execute("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
        timeout: Math.max(1, Math.min(45_000, cutoff - now())), windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } })).stdout;
      checkDeadline();
      return value;
    } catch (error) {
      if (now() >= cutoff || error?.message === "LIVE_INPUT_NOT_READY_REFRESH_LATE") fail("REFRESH_LATE");
      fail("REFRESH_FAILED");
    }
  };
  if (!remotes.has((await git(["remote", "get-url", "origin"])).trim())) fail("REFRESH_ORIGIN_REJECTED");
  const dirty = (await git(["diff", "--name-only", "-z", "HEAD"])).split("\0");
  const untracked = (await git(["ls-files", "--others", "--exclude-standard", "-z"])).split("\0");
  if ([...dirty, ...untracked].some(isLiveInputCodePath)) fail("REFRESH_CODE_MISMATCH");
  await git(["fetch", "--no-tags", "origin", "main"]);
  const inputCommit = (await git(["rev-parse", "origin/main"])).trim();
  if (!/^[a-f0-9]{40}$/u.test(inputCommit)) fail("REFRESH_COMMIT_INVALID");
  if ((await git(["diff", "--name-only", "-z", "HEAD", inputCommit])).split("\0").some(isLiveInputCodePath)) fail("REFRESH_CODE_MISMATCH");
  const folder = "data/analysis/market-seeds";
  const seedPath = (await git(["ls-tree", "-r", "--name-only", inputCommit, "--", folder])).trim().split(/\r?\n/u)
    .filter((name) => /^data\/analysis\/market-seeds\/\d{4}-\d{2}-\d{2}\.json$/u.test(name) && name.slice(-15, -5) < signalDate).sort().at(-1);
  if (!seedPath) fail("PREVIOUS_SESSION_MISSING");
  let seed, calendar, calendarText;
  try {
    seed = JSON.parse(await git(["show", `${inputCommit}:${seedPath}`]));
    calendarText = await git(["show", `${inputCommit}:data/trading-calendar/status.json`]);
    calendar = JSON.parse(calendarText);
  } catch (error) {
    if (error?.message?.startsWith("LIVE_INPUT_NOT_READY_")) throw error;
    fail("REFRESH_INPUT_INVALID");
  }
  if (validateIntradayMarketSeed(seed, seed.records?.length ?? 0).length) fail("REFRESH_INPUT_INVALID");
  for (const [version, file] of Object.entries({ "A-v1": "lib/technical-strength.mjs", "B-v1": "lib/trend-strength.mjs", "C-v1": "lib/entry-strength.mjs", "D-v1": "lib/combined-technical-score.mjs" })) {
    const formula = await git(["show", `${inputCommit}:${file}`]);
    if (seed.sourceManifest?.modelFormulaHashes?.[version] !== createHash("sha256").update(formula.replaceAll("\r\n", "\n")).digest("hex")) fail("REFRESH_FORMULA_MISMATCH");
  }
  assertLiveSeedSession(seed, signalDate, calendar);
  if (Date.parse(seed.generatedAt) > now()) fail("SEED_AVAILABILITY");
  checkDeadline();
  return { seed, calendar, inputProvenance: { inputCommit, seedPath, seedHash: seed.contentHash,
    calendarPath: "data/trading-calendar/status.json", calendarHash: createHash("sha256").update(calendarText).digest("hex"),
    refreshedAt, readyAt: new Date(now()).toISOString(), cutoffAt: new Date(cutoff).toISOString() } };
}
