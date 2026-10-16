// Run after npm run build. No second build, collection, production auth, or remote I/O.
// Actual compiled GET handlers run with NFT-only dependencies. The established
// worker rejects external reads and all network requests except loopback test auth.
// Synthetic market inputs are written only below this test's temporary directory.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { authConfig, createAdminAuth, hashAdminPassword, sessionCookie } from "../lib/admin-auth.mjs";
import { isCurrentIntradayModelTopSignal, validateIntradayModelTopSignal } from "../lib/intraday-model-top-official-signal.mjs";
import { validateIntradayModelTopOutcomes } from "../lib/intraday-model-top-outcome-resolver.mjs";
import { CURRENT_LIVE_PROFILE, LEGACY_LIVE_PROFILE } from "../lib/intraday-model-top-time-policy.mjs";
import { redisFixtureServer } from "./auth-test-support.mjs";
import { currentSignal, currentOutcome, fixtureCalendar, rehash } from "./fixtures/intraday-1400-outcomes.mjs";

const repository = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const signalRoute = "api/intraday-model-top", performanceRoute = "api/model-performance";
const definitions = [
  { route: signalRoute, allowed: /^data\/(?:intraday-signals\/model-top\/(?:latest\.json|\d{4}-\d{2}-\d{2}\/(?:1400|1430)\.json)|trading-calendar\/status\.json)$/u },
  { route: performanceRoute, allowed: /^data\/(?:history\/\d{4}-\d{2}-\d{2}\.json|historical-outcomes\/(?:1d|5d|20d|60d)\/\d{4}-\d{2}-\d{2}\.json|intraday-outcomes\/model-top\/1400\/\d{4}-\d{2}-\d{2}\.json)$/u },
];
const inside = (root, file) => { const relative = path.relative(root, file); return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };
const slash = value => value.split(path.sep).join("/");
const json = async file => JSON.parse(await fs.readFile(file, "utf8"));
const digest = async file => createHash("sha256").update(await fs.readFile(file)).digest("hex");
const list = async directory => { try { return await fs.readdir(directory); } catch (error) { if (error.code === "ENOENT") return []; throw error; } };
const dateFile = /^\d{4}-\d{2}-\d{2}\.json$/u;
const sourceDigests = new Map();

async function buildFingerprint() {
  // BUILD_ID is emitted near build completion. Also require no active build lock
  // and stable route traces/config; never execute against a changing compilation.
  try { await fs.access(path.join(repository, ".next/lock")); return null; } catch (error) { if (error.code !== "ENOENT") throw error; }
  try {
    const names = [".next/BUILD_ID", ".next/required-server-files.json", ...definitions.flatMap(({ route }) => [`.next/server/app/${route}/route.js`, `.next/server/app/${route}/route.js.nft.json`])];
    return JSON.stringify(await Promise.all(names.map(async name => [name, await digest(path.join(repository, name))])));
  } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

async function waitForStableBuild() {
  const deadline = Date.now() + 10 * 60_000;
  let previous = null;
  while (Date.now() < deadline) {
    const current = await buildFingerprint();
    if (current && current === previous) return current;
    previous = current;
    await sleep(2000);
  }
  throw new Error("Build did not become stable; finish the existing build before running this test");
}

async function inspectTrace({ route, allowed }) {
  const relative = `.next/server/app/${route}/route.js`, traceFile = path.join(repository, `${relative}.nft.json`);
  const nft = await json(traceFile);
  assert.ok(Array.isArray(nft.files), `${route}: missing NFT files`);
  const files = [...new Set([relative, ...nft.files.map(name => slash(path.relative(repository, path.resolve(path.dirname(traceFile), name))))])].sort();
  for (const name of files) {
    const source = path.resolve(repository, name);
    assert.ok(inside(repository, source) && inside(repository, await fs.realpath(source)), `${route}: dependency escapes repository: ${name}`);
    assert.ok((await fs.stat(source)).isFile(), `${route}: non-file dependency: ${name}`);
    assert.doesNotMatch(name, /(?:^|\/)\.env(?:\.|$)|(?:^|\/)\.runtime\//u, `${route}: private runtime file traced`);
    if (name.startsWith("data/")) { assert.match(name, allowed, `${route}: unrelated or legacy performance data traced`); sourceDigests.set(name, await digest(source)); }
  }
  const required = name => assert.ok(files.includes(name), `${route}: required input absent from NFT: ${name}`);
  if (route === signalRoute) {
    required("data/intraday-signals/model-top/latest.json"); required("data/trading-calendar/status.json");
    for (const date of await list(path.join(repository, "data/intraday-signals/model-top"))) if (/^\d{4}-\d{2}-\d{2}$/u.test(date)) {
      for (const slot of [CURRENT_LIVE_PROFILE.slot, LEGACY_LIVE_PROFILE.slot]) if ((await list(path.join(repository, "data/intraday-signals/model-top", date))).includes(`${slot}.json`)) required(`data/intraday-signals/model-top/${date}/${slot}.json`);
    }
  } else {
    for (const directory of ["history", ...["1d", "5d", "20d", "60d"].map(horizon => `historical-outcomes/${horizon}`), "intraday-outcomes/model-top/1400"]) {
      for (const name of await list(path.join(repository, "data", directory))) if (dateFile.test(name)) required(`data/${directory}/${name}`);
    }
  }
  console.log(`${route}: ${files.length} NFT-listed files, ${files.filter(name => name.startsWith("data/")).length} allowlisted data files`);
  return { route, files };
}

async function runWorker(root, route, requests, context, isolated = true) {
  return new Promise((resolve, reject) => {
    // Do not inherit credentials, NODE_OPTIONS, NODE_PATH, platform settings or flags.
    const env = { ...context.env };
    for (const key of ["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR"]) if (process.env[key]) env[key] = process.env[key];
    const child = spawn(process.execPath, [path.join(repository, "scripts/test-deployment-traces.mjs"), "--compiled-worker"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true });
    let result, diagnostic = "";
    child.stdout.on("data", () => {});
    child.stderr.on("data", chunk => { diagnostic = (diagnostic + chunk.toString()).slice(-12000); });
    const timeout = setTimeout(() => child.kill(), 60_000);
    child.once("error", error => { clearTimeout(timeout); reject(error); });
    child.on("message", message => { result = message; });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      if (code === 0 && result?.results) resolve(result.results);
      else reject(new Error(`Compiled ${route} worker failed (${signal ?? code}): ${diagnostic}`));
    });
    child.send({ root, route, requests, now: context.now, cookie: context.cookie, isolated });
  });
}

const fingerprint = await waitForStableBuild();
const compiledConfig = (await json(path.join(repository, ".next/required-server-files.json"))).config;
assert.deepEqual(compiledConfig.outputFileTracingIncludes[`/${signalRoute}`], [
  "./data/intraday-signals/model-top/latest.json", "./data/intraday-signals/model-top/*/1400.json", "./data/intraday-signals/model-top/*/1430.json", "./data/trading-calendar/status.json",
], "Built config must retain both explicit archive and new current namespace");
assert.deepEqual(compiledConfig.outputFileTracingIncludes[`/${performanceRoute}`], ["./data/intraday-outcomes/model-top/1400/*.json"], "Current performance must never bundle the legacy outcome namespace");
const traces = await Promise.all(definitions.map(inspectTrace));
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "live-cutover-nft-"));
let fixture;
try {
  const roots = new Map();
  for (const { route, files } of traces) {
    const root = path.join(temporary, route.replaceAll("/", "-")); roots.set(route, root);
    for (const name of files) {
      const target = path.join(root, name);
      await fs.mkdir(path.dirname(target), { recursive: true }); await fs.copyFile(path.join(repository, name), target);
    }
  }
  const writeFixture = async (route, name, value) => {
    const target = path.resolve(roots.get(route), name);
    assert.ok(inside(temporary, target), "Synthetic fixture writes must stay temporary");
    await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, JSON.stringify(value));
  };
  const token = randomBytes(32).toString("base64url"), password = `Synthetic1-${randomBytes(12).toString("hex")}`;
  fixture = await redisFixtureServer(token);
  const env = { NODE_ENV: "development", TB_ADMIN_USERNAME: "live-package-fixture", TB_ADMIN_PASSWORD_HASH: await hashAdminPassword(password), TB_SESSION_SECRET: randomBytes(32).toString("base64url"), TB_AUTH_ORIGIN: "http://127.0.0.1", TB_AUTH_REDIS_URL: fixture.url, TB_AUTH_REDIS_TOKEN: token };
  const now = Date.parse("2026-10-06T05:10:00Z");
  const login = await createAdminAuth(authConfig(env), undefined, () => now).login(env.TB_ADMIN_USERNAME, password, "live-package-fixture");
  assert.equal(login.status, 200);
  const context = { env, now, cookie: sessionCookie(login.token, env).split(";")[0] };
  const request = async (route, query = "") => (await runWorker(roots.get(route), route, [{ query }], context))[0];
  const archivePath = traces.find(trace => trace.route === signalRoute).files.find(name => /^data\/intraday-signals\/model-top\/\d{4}-\d{2}-\d{2}\/1430\.json$/u.test(name));
  assert.ok(archivePath, "A frozen archive is required to prove opt-in history reads");
  const archive = await json(path.join(repository, archivePath));
  assert.deepEqual(validateIntradayModelTopSignal(archive), []);
  const archiveQuery = `?date=${archive.signalDate}&time=1430`;
  const assertEmptyLive = response => {
    assert.equal(response.status, 200); assert.match(response.cacheControl, /private.*no-store/u);
    assert.equal(response.body.live.layer, "INTRADAY_1400_LIVE"); assert.equal(response.body.live.executionPolicyId, "intraday-1400-t1-open-v1");
    assert.equal(response.body.live.totalOutcomeObservationCount, 0); assert.deepEqual(response.body.live.daily, []);
    for (const model of response.body.live.summary) for (const group of model.groups) for (const horizon of group.horizons) {
      assert.equal(horizon.status, "ACCUMULATING"); assert.equal(horizon.meanReturn, null);
    }
  };
  const unavailable = response => { assert.equal(response.status, 503); assert.match(response.cacheControl, /private.*no-store/u); assert.equal(response.body.stocks, undefined); };
  // The unmodified legacy-only checkout is compared exactly; mutated temporary
  // scenarios are never compared against or written into repository data.
  for (const { route } of traces) {
    const calls = [{ authenticated: false }, {}, ...(route === signalRoute ? [{ query: archiveQuery }, { query: `?date=${archive.signalDate}` }, { query: "?time=1430" }] : [])];
    const full = await runWorker(repository, route, calls, context, false);
    const packaged = await runWorker(roots.get(route), route, calls, context);
    assert.deepEqual(packaged, full, `${route}: NFT-only package must match complete-checkout baseline`);
    assert.equal(packaged[0].status, 401);
    if (route === signalRoute) {
      unavailable(packaged[1]); unavailable(packaged[3]); assert.equal(packaged[4].status, 400);
      assert.equal(packaged[2].status, 200); assert.equal(packaged[2].body.archived, true);
      assert.equal(packaged[2].body.dataMode, "intradayArchivedSignal"); assert.equal(packaged[2].body.officialSignalTime, "14:30:00");
      assert.equal(packaged[2].body.contentHash, archive.contentHash);
    } else assertEmptyLive(packaged[1]);
  }
  console.log("Legacy-only compiled packages: current 503/empty, explicit 14:30 archive works, auth denies missing sessions, complete-checkout parity passed");

  const signal = currentSignal(); assert.ok(isCurrentIntradayModelTopSignal(signal));
  const currentPath = `data/intraday-signals/model-top/${signal.signalDate}/1400.json`;
  const latestPath = "data/intraday-signals/model-top/latest.json";
  const pointer = { schemaVersion: CURRENT_LIVE_PROFILE.schemaVersion, observationPolicyId: CURRENT_LIVE_PROFILE.policyId, status: "READY", officialSignalTime: CURRENT_LIVE_PROFILE.signalTime, signalDate: signal.signalDate, signalPath: currentPath, contentHash: signal.contentHash };
  await writeFixture(signalRoute, currentPath, signal); await writeFixture(signalRoute, latestPath, pointer);
  await writeFixture(signalRoute, "data/trading-calendar/status.json", fixtureCalendar());
  const currentResponses = await runWorker(roots.get(signalRoute), signalRoute, ["A", "B", "C", "D"].map(model => ({ query: `?model=${model}` })), context);
  for (const response of currentResponses) {
    assert.equal(response.status, 200); assert.match(response.cacheControl, /private.*no-store/u);
    assert.equal(response.body.dataMode, "intradayOfficialSignal"); assert.equal(response.body.archived, false);
    assert.equal(response.body.officialSignalTime, "14:00:00"); assert.equal(response.body.observationPolicyId, "intraday-1400-v1");
    assert.equal(response.body.contentHash, signal.contentHash); assert.equal(response.body.count, 1); assert.equal(response.body.stocks[0].code, "000001");
  }
  for (const patch of [{ schemaVersion: 1 }, { observationPolicyId: "intraday-1430-v1" }, { signalPath: archivePath }, { signalPath: "../../outside.json" }, { contentHash: "0".repeat(64) }]) {
    await writeFixture(signalRoute, latestPath, { ...pointer, ...patch }); unavailable(await request(signalRoute));
  }
  for (const patch of [{ schemaVersion: 1 }, { observationPolicyId: "intraday-1430-v1" }, { officialSignalTime: "14:30:00" }]) {
    const invalid = rehash({ ...signal, ...patch });
    await writeFixture(signalRoute, currentPath, invalid); await writeFixture(signalRoute, latestPath, { ...pointer, contentHash: invalid.contentHash });
    unavailable(await request(signalRoute));
  }
  await writeFixture(signalRoute, currentPath, { ...signal, contentHash: "0".repeat(64) });
  await writeFixture(signalRoute, latestPath, { ...pointer, contentHash: "0".repeat(64) }); unavailable(await request(signalRoute));
  await writeFixture(signalRoute, currentPath, signal); await writeFixture(signalRoute, latestPath, pointer);
  assert.equal((await request(signalRoute, archiveQuery)).body.contentHash, archive.contentHash, "New current fixtures must not alter the archive response");
  console.log("Compiled current LIVE: all four models accept synthetic 14:00; wrong pointer/artifact schema, policy, time, path and hash fail closed");

  const outcome = currentOutcome(); assert.deepEqual(validateIntradayModelTopOutcomes(outcome), []);
  const outcomePath = `data/intraday-outcomes/model-top/1400/${outcome.signalDate}.json`;
  const legacyNames = (await list(path.join(repository, "data/intraday-outcomes/model-top"))).filter(name => dateFile.test(name));
  assert.ok(legacyNames.length, "Existing legacy outcomes are required for cohort isolation regression");
  const legacyPath = `data/intraday-outcomes/model-top/${legacyNames[0]}`, legacy = await json(path.join(repository, legacyPath));
  sourceDigests.set(legacyPath, await digest(path.join(repository, legacyPath)));
  await writeFixture(performanceRoute, legacyPath, legacy);
  // Even a valid legacy archive misfiled under 1400 cannot become current results.
  await writeFixture(performanceRoute, `data/intraday-outcomes/model-top/1400/${legacyNames[0]}`, legacy);
  assertEmptyLive(await request(performanceRoute));
  await writeFixture(performanceRoute, outcomePath, outcome);
  const mature = await request(performanceRoute);
  assert.equal(mature.status, 200); assert.equal(mature.body.live.rejectedOutcomeCount, 1);
  const metric = mature.body.live.summary.find(model => model.modelVersion === "A-v1").groups.find(group => group.topN === 5).horizons.find(item => item.horizon === "1DAY");
  assert.equal(metric.observationCount, 1); assert.equal(metric.meanReturn, 7);
  assert.deepEqual(mature.body.live.matureSignalDates, [outcome.signalDate]);
  for (const invalid of [rehash({ ...outcome, schemaVersion: 1 }), rehash({ ...outcome, executionPolicy: { ...outcome.executionPolicy, policyId: "intraday-1430-t1-open-v1" } }), { ...outcome, contentHash: "0".repeat(64) }]) {
    await writeFixture(performanceRoute, outcomePath, invalid); assertEmptyLive(await request(performanceRoute));
  }
  await writeFixture(performanceRoute, `data/intraday-outcomes/model-top/${outcome.signalDate}.json`, outcome);
  await fs.rm(path.join(roots.get(performanceRoute), outcomePath));
  assertEmptyLive(await request(performanceRoute));
  console.log("Compiled performance: synthetic verified 14:00 results are isolated; legacy/misfiled/wrong-schema/wrong-policy/hash-invalid outcomes remain empty");

  assert.equal(await buildFingerprint(), fingerprint, "Build changed during packaging verification; rerun only after the existing build finishes");
  for (const [name, expected] of sourceDigests) assert.equal(await digest(path.join(repository, name)), expected, `Repository data changed during test: ${name}`);
  console.log("LIVE cutover NFT packaging passed. Scope: compiled GET handlers with synthetic development auth; no production HTTP/Proxy or deployment claim.");
} finally {
  if (fixture) await fixture.close();
  await fs.rm(temporary, { recursive: true, force: true });
}
