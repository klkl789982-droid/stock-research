import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
const execute = promisify(execFile);
const formulaFiles = ["lib/technical-strength.mjs", "lib/technical-model-features.mjs", "lib/trend-strength.mjs", "lib/entry-strength.mjs", "lib/combined-technical-score.mjs", "lib/intraday-model-top-official-signal.mjs", "lib/intraday-model-b-official-signal.mjs", "lib/intraday-model-top-time-policy.mjs"];
const hash = (value) => createHash("sha256").update(value.replaceAll("\r\n", "\n")).digest("hex");
export function repositoryInputs(root, { remote = false } = {}) {
  const git = async (...args) => (await execute("git", ["-c", `safe.directory=${path.resolve(root).replaceAll("\\", "/")}`, ...args], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 60000, windowsHide: true })).stdout;
  let frozen = null;
  async function verifyFormula(expected = frozen) {
    const evidence = {};
    for (const file of formulaFiles) {
      const current = hash(await fs.readFile(path.join(root, file), "utf8"));
      const committed = hash(await git("show", `HEAD:${file}`));
      if (current !== committed || (expected && current !== expected[file])) throw new Error("MODEL_FORMULA_INTEGRITY_FAILED");
      evidence[file] = current;
    }
    frozen ??= evidence;
    return evidence;
  }
  async function loadSeed(date) {
    const folder = "data/analysis/market-seeds";
    let names;
    if (remote) {
      const origin = (await git("remote", "get-url", "origin")).trim();
      if (!["https://github.com/klkl789982-droid/stock-research.git", "git@github.com:klkl789982-droid/stock-research.git"].includes(origin)) throw new Error("SEED_ORIGIN_REJECTED");
      await git("fetch", "origin", "main");
      names = (await git("ls-tree", "--name-only", "origin/main", `${folder}/`)).trim().split(/\r?\n/u).map((name) => path.posix.basename(name));
    } else names = await fs.readdir(path.join(root, folder));
    const selected = names.filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/u.test(name) && name.slice(0, 10) < date).sort().at(-1);
    if (!selected) throw new Error("PRIOR_SEED_MISSING");
    const seed = JSON.parse(remote ? await git("show", `origin/main:${folder}/${selected}`) : await fs.readFile(path.join(root, folder, selected), "utf8"));
    const evidence = await verifyFormula();
    for (const [version, file] of Object.entries({ "A-v1": formulaFiles[0], "B-v1": formulaFiles[2], "C-v1": formulaFiles[3], "D-v1": formulaFiles[4] })) {
      if (seed.sourceManifest?.modelFormulaHashes?.[version] !== evidence[file]) throw new Error("SEED_FORMULA_HASH_MISMATCH");
    }
    return seed;
  }
  return { loadSeed, verifyFormula };
}
