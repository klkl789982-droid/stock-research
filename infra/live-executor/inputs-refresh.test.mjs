import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { repositoryInputs } from "./runtime.mjs";
import { intradaySeedHash } from "../../lib/intraday-market-seed.mjs";

const execute = promisify(execFile), root = fileURLToPath(new URL("../../", import.meta.url));
const formulas = ["technical-strength", "technical-model-features", "trend-strength", "entry-strength", "combined-technical-score",
  "intraday-model-top-official-signal", "intraday-model-b-official-signal", "intraday-model-top-time-policy"].map(name => `lib/${name}.mjs`);
const digest = value => createHash("sha256").update(value.replaceAll("\r\n", "\n")).digest("hex");

test("remote refresh reads new seed/calendar from one commit, not the stale local checkout", async t => {
  // This is a real Git fetch/show exercise against a temporary local bare repo.
  // No credentials, supplier request, public remote or operational state is used.
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "tb-input-refresh-"));
  t.after(async () => {
    assert.ok(directory.startsWith(`${path.resolve(os.tmpdir())}${path.sep}tb-input-refresh-`));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const writer = path.join(directory, "writer"), reader = path.join(directory, "reader"), origin = path.join(directory, "origin.git");
  const git = async (cwd, ...args) => (await execute("git", args, { cwd, encoding: "utf8", windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1" } })).stdout;
  await fs.mkdir(writer);
  await git(directory, "init", "--bare", origin);
  await git(writer, "init", "-b", "main");
  await git(writer, "config", "user.name", "Synthetic input test");
  await git(writer, "config", "user.email", "fixture@example.invalid");
  await git(writer, "config", "core.autocrlf", "false");
  await git(writer, "remote", "add", "origin", origin);
  const formulaHashes = {};
  for (const file of formulas) {
    const text = await fs.readFile(path.join(root, file), "utf8");
    await fs.mkdir(path.dirname(path.join(writer, file)), { recursive: true });
    await fs.writeFile(path.join(writer, file), text);
    formulaHashes[file] = digest(text);
  }
  const seedFolder = "data/analysis/market-seeds";
  async function publish(referenceDate, minute) {
    const sourceHash = "a".repeat(64), stamp = `2026-10-19T04:${minute}:00.000Z`;
    const base = { schemaVersion: 1, seedType: "intradayMarketAnalysisSeed", rowOrder: "descending", requestedDate: referenceDate, generatedAt: stamp,
      sourceManifest: { modelFormulaHashes: Object.fromEntries(["A-v1", "B-v1", "C-v1", "D-v1"].map((v, i) => [v, formulaHashes[formulas[[0, 2, 3, 4][i]]]])),
        sources: { officialDailyPrice: { normalizedInputHash: sourceHash, availability: {
          requestedAt: stamp, observedAt: stamp, referenceDate, normalizedInputHash: sourceHash,
          availabilityStatus: "OBSERVED", availabilityEvidence: "SYSTEM_OBSERVED_BATCH_COLLECTION", outcome: "success",
        } } } },
      records: [{ code: "005930", name: "Synthetic only", market: "KOSPI", eligible: true, officialAsOfDate: referenceDate, sourceHash,
        rows: Array.from({ length: 260 }, (_, i) => [new Date(Date.parse(`${referenceDate}T00:00:00Z`) - i * 86400000).toISOString().slice(0, 10).replaceAll("-", ""), 100, 110, 90, 105, 1000]) }] };
    const seed = { ...base, contentHash: intradaySeedHash(base) };
    await fs.mkdir(path.join(writer, seedFolder), { recursive: true });
    await fs.mkdir(path.join(writer, "data/trading-calendar"), { recursive: true });
    await fs.writeFile(path.join(writer, seedFolder, `${referenceDate}.json`), JSON.stringify(seed));
    await fs.writeFile(path.join(writer, "data/trading-calendar/status.json"), JSON.stringify({ dates: { [referenceDate]: { status: "tradingDay", observedBasDt: referenceDate } } }));
    await git(writer, "add", ".");
    await git(writer, "commit", "-m", `Synthetic publication ${referenceDate}`);
    await git(writer, "push", "origin", "main");
    return seed;
  }
  const oldSeed = await publish("2026-10-15", "20");
  await git(directory, "clone", "--branch", "main", origin, reader);
  let time = Date.parse("2026-10-19T13:40:00+09:00"), networkFailed = false;
  const calls = [];
  const inputs = repositoryInputs(reader, { remote: true, now: () => time, git: async args => {
    calls.push(args);
    // Only origin identity is substituted; fetch/show/diff use the actual local repo.
    if (args.join(" ") === "remote get-url origin") return "https://github.com/klkl789982-droid/stock-research.git\n";
    if (args[0] === "fetch" && networkFailed) throw new Error("SYNTHETIC_NETWORK_FAILURE");
    return git(reader, ...args);
  } });
  const first = await inputs.loadSeed("2026-10-19");
  assert.equal(first.contentHash, oldSeed.contentHash);
  await assert.rejects(inputs.verifySeedSession(first, "2026-10-19"), /LIVE_INPUT_NOT_READY_PREVIOUS_SESSION_UNVERIFIED/u);
  const fresh = await publish("2026-10-16", "50");
  time = Date.parse("2026-10-19T13:59:00+09:00");
  const final = await inputs.loadSeed("2026-10-19");
  assert.equal(final.contentHash, fresh.contentHash);
  assert.equal(await inputs.verifySeedSession(final, "2026-10-19"), "2026-10-16");
  const receipt = inputs.getInputProvenance(final);
  assert.equal(receipt.inputCommit, (await git(writer, "rev-parse", "HEAD")).trim());
  assert.notEqual(receipt.inputCommit, (await git(reader, "rev-parse", "HEAD")).trim());
  assert.equal(receipt.readyAt, "2026-10-19T04:59:00.000Z");
  assert.match(receipt.calendarHash, /^[a-f0-9]{64}$/u);
  await assert.rejects(fs.access(path.join(reader, seedFolder, "2026-10-16.json")), { code: "ENOENT" });
  assert.equal(calls.filter(args => args.join(" ") === "fetch origin main").length, 2);
  assert.ok(calls.some(args => args.join(" ") === `show ${receipt.inputCommit}:data/trading-calendar/status.json`));
  networkFailed = true;
  await assert.rejects(inputs.loadSeed("2026-10-19"), /SYNTHETIC_NETWORK_FAILURE/u);
  networkFailed = false;
  await fs.writeFile(path.join(writer, "lib/technical-strength.mjs"), "// synthetic code drift\n", { flag: "a" });
  await git(writer, "add", "."); await git(writer, "commit", "-m", "Synthetic code drift"); await git(writer, "push", "origin", "main");
  await assert.rejects(inputs.loadSeed("2026-10-19"), /LIVE_INPUT_NOT_READY_REFRESH_CODE_MISMATCH/u);
  assert.equal(JSON.parse(await fs.readFile(path.join(reader, seedFolder, "2026-10-15.json"), "utf8")).contentHash, oldSeed.contentHash);
});
