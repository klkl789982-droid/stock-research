// Run after `npm run build`: node scripts/test-deployment-traces.mjs
// Tests compiled GET handlers, not next start/Proxy/production authentication.
// Runtime packages contain only route.js and their NFT-listed files. Authentication
// uses ephemeral synthetic credentials and a loopback Redis fixture in development.
// No source data, build output, .env file, production secret, or remote service is changed.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createRequire, isBuiltin } from "node:module";

const script = fileURLToPath(import.meta.url);
const repository = path.resolve(path.dirname(script), "..");
const dateFile = /^\d{4}-\d{2}-\d{2}\.json$/u;
const slash = (value) => value.split(path.sep).join("/");
const inside = (root, file) => { const relative = path.relative(root, file); return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };
const json = async (file) => JSON.parse(await fs.readFile(file, "utf8"));
async function writeJson(file, value) { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, JSON.stringify(value)); }
async function list(directory) { try { return await fs.readdir(directory); } catch (error) { if (error.code === "ENOENT") return []; throw error; } }

async function compiledWorker() {
  const input = await new Promise((resolve) => process.once("message", resolve));
  const { root, route, requests, now, cookie, isolated } = input;
  assert.equal(process.cwd(), root);
  const RealDate = Date;
  globalThis.Date = class extends RealDate {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
    // Next's Date instrumentation copies own static properties, not inherited ones.
    static parse(value) { return RealDate.parse(value); }
    static UTC(...args) { return RealDate.UTC(...args); }
  };
  // A route accidentally adding collection/network I/O must fail this test.
  const localFetch = globalThis.fetch;
  globalThis.fetch = (url, init) => {
    assert.equal(new URL(typeof url === "string" || url instanceof URL ? url : url.url).href,
      new URL(process.env.TB_AUTH_REDIS_URL).href, "Only the synthetic loopback auth store may be contacted");
    return localFetch(url, init);
  };
  const require = createRequire(path.join(root, "package.json"));
  const outsideReads = [];
  if (isolated) {
    const Module = require("node:module"), originalResolve = Module._resolveFilename;
    Module._resolveFilename = function (specifier, ...args) {
      const resolved = originalResolve.call(this, specifier, ...args);
      if (!isBuiltin(resolved)) assert.ok(inside(root, resolved), `Unpackaged dependency: ${resolved}`);
      return resolved;
    };
    for (const method of ["readFile", "readdir", "open"]) {
      const original = fs[method];
      fs[method] = function (file, ...args) {
        const target = file instanceof URL ? fileURLToPath(file) : path.resolve(String(file));
        if (!inside(root, target)) { outsideReads.push(target); throw new Error("Read outside packaged runtime"); }
        return original.call(this, file, ...args);
      };
    }
  }
  const { routeModule } = require(path.join(root, ".next/server/app", route, "route.js"));
  assert.equal(typeof routeModule?.userland?.GET, "function", "Built route must expose its actual wrapped GET");
  const results = [];
  for (const { query = "", authenticated = true } of requests) {
    const request = new Request(`http://127.0.0.1/${route}${query}`, { headers: authenticated ? { Cookie: cookie } : {} });
    // These routes only require NextRequest.nextUrl in addition to the Web API.
    // Supplying it avoids adding the untraced next/server package to the fixture.
    Object.defineProperty(request, "nextUrl", { value: new URL(request.url) });
    const response = await routeModule.userland.GET(request);
    results.push({ status: response.status, cacheControl: response.headers.get("cache-control"), body: await response.json() });
  }
  assert.deepEqual(outsideReads, [], "A handler attempted to read outside its isolated package");
  await new Promise((resolve, reject) => process.send({ results }, (error) => error ? reject(error) : resolve()));
  process.disconnect();
}

async function runWorker(root, route, requests, context, { isolated = true, enabled = false } = {}) {
  return new Promise((resolve, reject) => {
    // Never inherit credentials, NODE_OPTIONS, NODE_PATH, VERCEL, or feature flags.
    const env = { ...context.env, KIS_EOD_PUBLISH_ENABLED: String(enabled) };
    for (const key of ["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR"]) if (process.env[key]) env[key] = process.env[key];
    const child = spawn(process.execPath, [script, "--compiled-worker"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true });
    let result, diagnostic = "";
    child.stdout.on("data", () => {});
    child.stderr.on("data", (chunk) => { diagnostic = (diagnostic + chunk.toString()).slice(-12000); });
    const timeout = setTimeout(() => child.kill(), 60000);
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    child.on("message", (message) => { result = message; });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      if (code === 0 && result?.results) resolve(result.results);
      else reject(new Error(`Compiled ${route} worker failed (${signal ?? code}): ${diagnostic}`));
    });
    child.send({ root, route, requests, now: context.now, cookie: context.cookie, isolated });
  });
}

const definitions = [
  { route: "api/top-stocks", allowed: /^(?:data\/history\/\d{4}-\d{2}-\d{2}\.json|data\/daily-production-status\/latest\.json|data\/intraday-signals\/model-b\/(?:latest\.json|\d{4}-\d{2}-\d{2}\/1430\.json))$/u },
  { route: "api/kis-eod-top-stocks", allowed: /^data\/(?:history|kis-eod-published)\/\d{4}-\d{2}-\d{2}\.json$/u },
  // Tracing the price-ledger directory also retains its harmless schema README.
  { route: "api/model-performance/research", allowed: /^data\/(?:(?:history|model-history|market-prices)\/\d{4}-\d{2}-\d{2}\.json|daily-runs\/\d{4}-\d{2}-\d{2}\/[a-zA-Z0-9_-]+\.json|trading-calendar\/status\.json|market-prices\/README\.md)$/u },
];

async function inspectTrace(definition) {
  const relative = `.next/server/app/${definition.route}/route.js`;
  const file = path.join(repository, `${relative}.nft.json`);
  const nft = await json(file);
  assert.ok(Array.isArray(nft.files), `${definition.route}: missing NFT files array`);
  const files = [...new Set([relative, ...nft.files.map((name) => slash(path.relative(repository, path.resolve(path.dirname(file), name))))])].sort();
  const identities = new Map();
  for (const name of files) {
    const source = path.resolve(repository, name);
    assert.ok(inside(repository, source), `${definition.route}: trace escapes repository: ${name}`);
    const stat = await fs.stat(source); // Missing dependencies are a hard failure.
    assert.ok(stat.isFile(), `${definition.route}: dependency is not a file: ${name}`);
    const real = await fs.realpath(source);
    assert.ok(inside(repository, real), `${definition.route}: symlink escapes repository: ${name}`);
    identities.set(real, stat.size);
    assert.ok(!/(?:^|\/)\.env(?:\.|$)|(?:^|\/)\.runtime\//u.test(name), `${definition.route}: private runtime/config file traced: ${name}`);
    if (name.startsWith("data/")) assert.match(name, definition.allowed, `${definition.route}: unrelated data traced: ${name}`);
  }
  const required = (name) => assert.ok(files.includes(name), `${definition.route}: required data missing from trace: ${name}`);
  for (const name of await list(path.join(repository, "data/history"))) if (dateFile.test(name)) required(`data/history/${name}`);
  if (definition.route === "api/top-stocks") {
    required("data/daily-production-status/latest.json");
    required("data/intraday-signals/model-b/latest.json");
    for (const date of await list(path.join(repository, "data/intraday-signals/model-b"))) {
      if (/^\d{4}-\d{2}-\d{2}$/u.test(date) && (await list(path.join(repository, "data/intraday-signals/model-b", date))).includes("1430.json")) required(`data/intraday-signals/model-b/${date}/1430.json`);
    }
  } else if (definition.route === "api/kis-eod-top-stocks") {
    for (const name of await list(path.join(repository, "data/kis-eod-published"))) if (dateFile.test(name)) required(`data/kis-eod-published/${name}`);
  } else {
    for (const directory of ["model-history", "market-prices"]) for (const name of await list(path.join(repository, "data", directory))) if (dateFile.test(name)) required(`data/${directory}/${name}`);
    for (const date of await list(path.join(repository, "data/daily-runs"))) if (/^\d{4}-\d{2}-\d{2}$/u.test(date)) {
      for (const name of await list(path.join(repository, "data/daily-runs", date))) if (/^[a-zA-Z0-9_-]+\.json$/u.test(name)) required(`data/daily-runs/${date}/${name}`);
    }
    required("data/trading-calendar/status.json");
  }
  console.log(`${definition.route}: ${identities.size} unique resolved files, ${(Array.from(identities.values()).reduce((a, b) => a + b, 0) / 1048576).toFixed(2)} MiB, ${files.filter((name) => name.startsWith("data/")).length} data files`);
  return { ...definition, files };
}

async function packageRoute(trace, temporary) {
  const root = path.join(temporary, trace.route.replaceAll("/", "-"));
  for (const name of trace.files) {
    const destination = path.join(root, name);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(path.join(repository, name), destination);
  }
  return root;
}

function readySignal(date, name = "Synthetic trace fixture") {
  return { signalDate: date, officialSignalTime: "14:30:00", status: "READY", collectionStartedAt: `${date}T05:29:00Z`, collectionCompletedAt: `${date}T05:30:00Z`, modelVersion: "B-v1", collection: { successful: 1, failed: 0, ineligible: 0 }, records: [{ ticker: "005930", companyName: name, score: 88, rank: 1, dataStatus: "AVAILABLE", provisionalOhlcv: { close: 12345 } }] };
}

async function syntheticKisProjection() {
  const pipeline = await import(pathToFileURL(path.join(repository, "lib/kis-eod-pipeline.mjs")));
  const { sha256Canonical } = await import(pathToFileURL(path.join(repository, "lib/snapshot-quality-pipeline.mjs")));
  const date = "2026-10-08", now = `${date}T07:00:00Z`, rows = [], day = new Date(`${date}T00:00:00Z`);
  while (rows.length < 260) {
    if (![0, 6].includes(day.getUTCDay())) { const close = 2000 - rows.length; rows.push({ basDt: day.toISOString().slice(0, 10).replaceAll("-", ""), mkp: close - 2, hipr: close + 5, lopr: close - 5, clpr: close, trqu: 10000, trPrc: close * 10000, fltRt: 1 / (close - 1) * 100 }); }
    day.setUTCDate(day.getUTCDate() - 1);
  }
  const hashes = Object.fromEntries(pipeline.KIS_EOD_MODEL_VERSIONS.map((version) => [version, sha256Canonical(`synthetic ${version}`)]));
  const candidate = pipeline.buildKisEodCandidate({ referenceDate: date, now, expectedUniverseCount: 1,
    officialSnapshot: { asOfDate: "2026-10-07", records: [{ code: "005930", qualityEligibility: { status: "eligible", exclusions: [] } }], sourceManifest: { modelFormulaHashes: hashes } },
    universeRecords: [{ code: "005930", name: "Synthetic trace fixture", market: "KOSPI" }], historiesByCode: new Map([["005930", rows]]), formulaHashes: hashes, expectedFormulaHashes: hashes,
    adjustmentPolicy: "unadjusted", collectionStartedAt: `${date}T06:40:00Z`, collectionCompletedAt: `${date}T06:50:00Z`,
    calendarEvidence: { source: "KIS", operation: "chk-holiday", referenceDate: date, isTradingDay: true, receivedAt: `${date}T06:35:00Z` }, observationType: "LIVE_COLLECTION",
    sourceMetadataByCode: new Map([["005930", { receivedAt: `${date}T06:48:00Z`, adjustment: "unadjusted", marketDivision: "J", priceBasis: "kisDailyBarUnadjusted", symbolMapping: { status: "VERIFIED_RESPONSE_TICKER", requestedCode: "005930", responseCode: "005930" } }]]),
    sourceFinalityEvidence: { status: "VERIFIED", contractReference: "https://example.invalid/synthetic-contract", documentHash: sha256Canonical("synthetic contract"), referenceDate: date, observedAt: `${date}T06:45:00Z`, operation: "inquire-daily-itemchartprice" },
    publicationApproval: { rights: true, rightsReference: "https://example.invalid/synthetic-rights", automation: true },
  });
  assert.equal(candidate.status, "VALIDATED");
  const projection = pipeline.toPublicKisEodProjection(pipeline.markKisEodPublished(candidate, now));
  assert.deepEqual(pipeline.validatePublicKisEodProjection(projection), []);
  return projection;
}

async function main() {
  const buildId = await fs.readFile(path.join(repository, ".next/BUILD_ID"), "utf8");
  const traces = await Promise.all(definitions.map(inspectTrace));
  const dates = (await list(path.join(repository, "data/history"))).filter((name) => dateFile.test(name)).sort();
  assert.ok(dates.length, "History inputs must be present");
  const latestDate = dates.at(-1).slice(0, 10);
  if (process.env.TRACE_EXPECTED_REFERENCE_DATE) assert.equal(latestDate, process.env.TRACE_EXPECTED_REFERENCE_DATE);
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "tb-deployment-traces-"));
  let fixture;
  try {
    const roots = new Map();
    for (const trace of traces) roots.set(trace.route, await packageRoute(trace, temporary));
    const { authConfig, createAdminAuth, hashAdminPassword, sessionCookie } = await import(pathToFileURL(path.join(repository, "lib/admin-auth.mjs")));
    const { redisFixtureServer } = await import(pathToFileURL(path.join(repository, "scripts/auth-test-support.mjs")));
    const password = `TraceOnly1-${randomBytes(12).toString("hex")}`, token = randomBytes(32).toString("base64url");
    fixture = await redisFixtureServer(token);
    const env = { NODE_ENV: "development", TB_ADMIN_USERNAME: "synthetic-trace-admin", TB_ADMIN_PASSWORD_HASH: await hashAdminPassword(password), TB_SESSION_SECRET: randomBytes(32).toString("base64url"), TB_AUTH_ORIGIN: "http://127.0.0.1", TB_AUTH_REDIS_URL: fixture.url, TB_AUTH_REDIS_TOKEN: token };
    const now = Date.now(), login = await createAdminAuth(authConfig(env), undefined, () => now).login(env.TB_ADMIN_USERNAME, password, "synthetic-trace-only");
    assert.equal(login.status, 200);
    const context = { env, now, cookie: sessionCookie(login.token, env).split(";")[0] };
    const request = async (route, query = "", options) => (await runWorker(roots.get(route), route, [{ query }], context, options))[0];

    for (const { route } of traces) {
      const queries = route === "api/top-stocks" ? ["?model=A&limit=5", "?model=B&limit=5"] : [""];
      const calls = [{ authenticated: false }, ...queries.map((query) => ({ query }))];
      const full = await runWorker(repository, route, calls, context, { isolated: false });
      const packaged = await runWorker(roots.get(route), route, calls, context);
      assert.equal(packaged[0].status, 401, `${route}: compiled auth must still reject absent sessions`);
      assert.deepEqual(packaged, full, `${route}: NFT-only package must match the complete checkout`);
      for (const response of packaged.slice(1)) {
        assert.equal(response.status, 200, `${route}: actual authenticated GET must succeed`);
        assert.match(response.cacheControl, /private.*no-store/u);
      }
      if (route === "api/top-stocks") {
        assert.equal(packaged[1].body.dataMode, "historySnapshot");
        for (const response of packaged.slice(1)) {
          if (response.body.dataMode === "historySnapshot") assert.equal(response.body.rankingAsOfDate, latestDate);
          else assert.equal(response.body.dataMode, "intradayOfficialSignal");
          assert.equal(response.body.freshness.snapshotReferenceDate, latestDate);
          assert.ok(response.body.stocks.length);
        }
      } else if (route === "api/kis-eod-top-stocks") {
        assert.equal(packaged[1].body.available, false);
        assert.equal(packaged[1].body.reason, "ACTIVATION_REQUIRES_APPROVAL");
        assert.equal(packaged[1].body.officialSnapshotReferenceDate, latestDate);
      } else {
        assert.equal(packaged[1].body.coverage.latestStoredSignalDate, latestDate);
        assert.equal(packaged[1].body.coverage.storedSignalCount, dates.length);
        assert.ok(packaged[1].body.provenance.inputFiles.some((file) => file.path === `data/history/${latestDate}.json`));
      }
      console.log(`${route}: compiled authenticated package equals complete checkout (${latestDate}); unauthenticated access denied`);
    }

    const top = "api/top-stocks", topRoot = roots.get(top), pointer = path.join(topRoot, "data/intraday-signals/model-b/latest.json");
    const signalPath = `data/intraday-signals/model-b/${latestDate}/1430.json`;
    const readyPointer = { status: "READY", signalDate: latestDate, officialSignalTime: "14:30:00", signalPath };
    await writeJson(path.join(topRoot, signalPath), readySignal(latestDate));
    await writeJson(pointer, readyPointer);
    const ready = await request(top, "?model=B&limit=5");
    assert.equal(ready.status, 200); assert.equal(ready.body.dataMode, "intradayOfficialSignal");
    assert.equal(ready.body.stocks[0].name, "Synthetic trace fixture"); assert.equal(ready.body.stocks[0].closePrice, 12345);
    assert.equal(ready.body.rankingAsOfDate, latestDate); assert.equal(ready.body.officialSignal.status, "READY");
    const fallback = async (label) => {
      const response = await request(top, "?model=B&limit=5");
      assert.equal(response.status, 200, label); assert.equal(response.body.dataMode, "historySnapshot", label);
      assert.equal(response.body.rankingAsOfDate, latestDate, label);
      assert.ok(response.body.stocks.every((stock) => stock.name !== "Outside-path fixture"), label);
    };
    for (const status of ["FAILED", "FAILED_COLLECTION", "UNAVAILABLE"]) {
      await writeJson(pointer, { ...readyPointer, status }); await fallback(`Non-ready status ${status}`);
    }
    // Plant a valid signal at every rejected destination; merely missing it would
    // not demonstrate that a malicious pointer is refused before reading it.
    const malicious = ["outside.json", "data/intraday-signals/model-b/../outside.json", "data/intraday-signals/model-b/../../../../outside.json", `data/intraday-signals/model-b/${latestDate}/../outside.json`, `data/intraday-signals/model-b/${latestDate}/other.json`, "data/intraday-signals/model-b/not-a-date/1430.json", `data/intraday-signals/model-b/${latestDate}/1430.json/../outside.json`, `data/intraday-signals/model-b/${latestDate}/1430.json?x=1`];
    for (const badPath of malicious) {
      // The file/../ case is invalid on disk; the remaining cases all exist.
      if (!badPath.includes("1430.json/")) await writeJson(path.resolve(topRoot, badPath), readySignal(latestDate, "Outside-path fixture"));
      await writeJson(pointer, { ...readyPointer, signalPath: badPath }); await fallback(`Rejected pointer ${badPath}`);
    }
    const outside = path.join(temporary, "outside.json");
    await writeJson(outside, readySignal(latestDate, "Outside-path fixture"));
    for (const badPath of [outside, "../outside.json", signalPath.replaceAll("/", "\\"), null, {}, 7]) {
      await writeJson(pointer, { ...readyPointer, signalPath: badPath }); await fallback("Rejected malformed/outside pointer");
    }
    await fs.rm(pointer); await fallback("Missing pointer");
    await fs.writeFile(pointer, "{broken"); await fallback("Corrupt pointer");
    await writeJson(pointer, readyPointer); await fs.writeFile(path.join(topRoot, signalPath), "{broken"); await fallback("Corrupt dated signal");
    await fs.rm(path.join(topRoot, signalPath)); await fallback("Missing dated signal");
    await writeJson(path.join(topRoot, signalPath), { ...readySignal(latestDate), modelVersion: "A-v1" }); await fallback("Wrong signal version");
    console.log("api/top-stocks: synthetic B READY; invalid/outside pointers, absent/corrupt pointers and signals preserve daily fallback");

    const kis = "api/kis-eod-top-stocks", kisRoot = roots.get(kis), projection = await syntheticKisProjection();
    const publicationDirectory = path.join(kisRoot, "data/kis-eod-published");
    await fs.rm(publicationDirectory, { recursive: true, force: true });
    await writeJson(path.join(publicationDirectory, `${projection.referenceDate}.json`), projection);
    const enabled = await request(kis, "?model=B&limit=5", { enabled: true });
    assert.equal(enabled.status, 200); assert.equal(enabled.body.available, true); assert.equal(enabled.body.status, "KIS_EOD_PUBLISHED");
    assert.equal(enabled.body.stocks[0].name, "Synthetic trace fixture"); assert.equal(enabled.body.stocks[0].closePrice, null);
    assert.equal(enabled.body.eligibleForOfficialRanking, false); assert.equal(enabled.body.officialSnapshotReferenceDate, latestDate);
    assert.equal((await request(kis)).body.reason, "ACTIVATION_REQUIRES_APPROVAL", "Synthetic publication must not change disabled behavior");
    console.log("api/kis-eod-top-stocks: validated score-only synthetic publication works when enabled; default stays disabled");
    assert.equal(await fs.readFile(path.join(repository, ".next/BUILD_ID"), "utf8"), buildId, "Build changed during the test; rerun after the build finishes");
    console.log("Deployment trace regression passed: no missing/unrelated data, isolated compiled handlers, complete-checkout parity, and fallback safety");
    console.log("Scope: compiled GET + synthetic development auth. Run scripts/test-admin-auth-production.mjs separately for production fail-closed HTTP coverage.");
  } finally {
    if (fixture) await fixture.close();
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv.includes("--compiled-worker")) await compiledWorker();
else await main();
