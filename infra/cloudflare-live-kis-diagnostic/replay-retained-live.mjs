import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { createLocalExecutionStore } from "../live-executor/store.mjs";
import { buildIntradayModelTopSignal, validateIntradayModelTopSignal } from "../../lib/intraday-model-top-official-signal.mjs";
import { validateForecastRecord } from "../../lib/forecast-swing-contract.mjs";
import { signalDeliveryModels } from "../live-executor/site-delivery-agent.mjs";
import { productionObservation, aggregateProduction } from "./production-core.mjs";
import { FORMULA_HASHES } from "./formula-manifest.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const digest = value => createHash("sha256").update(value).digest("hex");

// READ-ONLY replay of already retained real observations. This module has no
// fetch, credentials, remote writes, clock injection or collection entry point.
// Reconstructed wire-shaped values are an adapter test, NOT original responses.
export async function replayRetainedLive({ stateDir, date }) {
  assert.match(date, /^\d{4}-\d{2}-\d{2}$/u);
  const store = createLocalExecutionStore(stateDir), base = `live/${date}/${date}`;
  const keys = [`${base}/result.json`, `${base}/collection-prepared.json`];
  const originals = new Map(await Promise.all(keys.map(async key => [key, digest(await fs.readFile(path.join(stateDir, key)))])));
  const [signal, prepared] = await Promise.all(keys.map(key => store.read(key)));
  assert.equal(signal.signalDate, date); assert.equal(signal.status, "READY");
  assert.deepEqual(validateIntradayModelTopSignal(signal), []);
  const seed = await store.read(prepared.seedKey), quotes = new Map(), projected = [];
  assert.equal(seed.contentHash, prepared.seedHash); assert.equal(seed.records.length, 553);
  assert.ok(seed.requestedDate < date && Date.parse(prepared.inputProvenance.readyAt) < Date.parse(signal.collectionStartedAt));
  const formulaFiles = Object.entries(FORMULA_HASHES);
  for (const [file, expected] of formulaFiles) assert.equal(digest((await fs.readFile(path.join(root, file), "utf8")).replaceAll("\r\n", "\n")), expected, file);
  for (const input of seed.records) {
    if (!input.eligible) { projected.push({ code: input.code, companyName: input.name, status: "EXCLUDED", scores: null, replayOnly: true }); continue; }
    const q = await store.read(`${base}/quotes/${input.code}.json`);
    assert.ok(q); quotes.set(input.code, q);
    const original = signal.records.find(r => r.ticker === input.code);
    const row = productionObservation({ input, seedContext: seed, code: input.code, signalDate: date,
      quote: { rt_cd: "0", output: { stck_shrn_iscd: input.code, stck_prpr: String(q.price), stck_oprc: String(q.open), stck_hgpr: String(q.high),
        stck_lwpr: String(q.low), acml_vol: String(q.volume), prdy_vrss: String(q.change), prdy_ctrt: String(q.rate) } },
      minute: { rt_cd: "0", output2: [{ stck_bsop_date: q.asOfDate.replaceAll("-", ""), stck_cntg_hour: q.asOfTime.replaceAll(":", "") }] },
      timing: { quoteRequestedAt: q.requestedAt, quoteReceivedAt: q.responseAt, minuteRequestedAt: q.minuteRequestedAt, minuteReceivedAt: q.minuteReceivedAt } });
    assert.deepEqual(row.scores, original.scores, "identical retained inputs must retain every score"); projected.push(row);
  }
  const rebuilt = buildIntradayModelTopSignal({ seed, quotesByCode: quotes, signalDate: date, collectionStartedAt: signal.collectionStartedAt,
    collectionCompletedAt: signal.collectionCompletedAt, inputProvenance: prepared.inputProvenance });
  assert.equal(rebuilt.contentHash, signal.contentHash, "entire original result must be exactly reproducible");
  const delivery = await store.read(`live/site-outbox/${date}/${signal.contentHash}.json`);
  const expectedModels = signalDeliveryModels(signal);
  for (const model of delivery.models) assert.deepEqual(model.records, expectedModels.find(x => x.modelVersion === model.modelVersion).records);
  const cloudPrepared = { targetDate: date, readiness: "READY", universe: 553, eligible: quotes.size, seedReferenceDate: seed.requestedDate,
    codes: seed.records.map(r => r.code), eligibleCodes: seed.records.filter(r => r.eligible).map(r => r.code),
    inputCommit: prepared.inputProvenance.inputCommit, seedHash: seed.contentHash, readyAt: prepared.inputProvenance.readyAt };
  // Historical timestamps are supplied ONLY inside this in-memory replay. No
  // reconstructed evidence/forecasts are installed in either ledger or outbox.
  const projection = aggregateProduction(cloudPrepared, projected, delivery.exportedAt);
  for (const model of projection.delivery.models) assert.deepEqual(model.records, delivery.models.find(x => x.modelVersion === model.modelVersion).records);
  const swingKey = `live/swing/${date}/${signal.contentHash}.json`, swing = await store.read(swingKey);
  const swingBytesBefore = digest(await fs.readFile(path.join(stateDir, swingKey)));
  assert.equal(swing.selections.length, 20); assert.equal(swing.signalHash, signal.contentHash);
  assert.deepEqual(projection.swing.selections, swing.selections);
  for (const r of swing.records) {
    assert.equal(validateForecastRecord(r).valid, true); assert.equal(r.createdAt, swing.createdAt);
    const equivalent = projection.swing.records.find(x => x.observation.symbol === r.observation.symbol);
    assert.ok(equivalent); assert.equal(equivalent.entryPolicy, r.entryPolicy); assert.equal(equivalent.exitPolicy, r.exitPolicy);
    assert.equal(equivalent.horizonTradingDays, r.horizonTradingDays);
  }
  for (const [key, before] of originals) assert.equal(digest(await fs.readFile(path.join(stateDir, key))), before);
  assert.equal(digest(await fs.readFile(path.join(stateDir, swingKey))), swingBytesBefore);
  return { status: "RETAINED_REAL_INPUT_REPLAY_PASS", checkedAt: new Date().toISOString(), signalDate: date,
    originalSourceHash: signal.contentHash, originalDeliveryHash: delivery.deliveryHash,
    originalCollectionStartedAt: signal.collectionStartedAt, originalCollectionCompletedAt: signal.collectionCompletedAt,
    seedReferenceDate: seed.requestedDate, seedHash: seed.contentHash, finalInputReadyAt: prepared.inputProvenance.readyAt,
    universe: seed.records.length, eligible: quotes.size, excluded: seed.records.length - quotes.size,
    formulaFilesVerified: formulaFiles.length, originalFullResultHashReproduced: true,
    cloudAdapterScoresCompared: quotes.size, cloudTop5Compared: 20,
    retainedSwing: { selections: swing.selections.length, uniqueTickers: swing.records.length, createdAt: swing.createdAt,
      sameFiveSessionEntryExitPolicy: true, originalIntentBytesHash: swingBytesBefore, originalFilesUnchanged: true },
    cloudSwing: { schemaValid: true, noReferencePriceTransmitted: true, outcomeReady: false, remoteReadbackVerified: false },
    originalFileHashes: Object.fromEntries(originals), rawPricesPrintedOrWritten: false, kisCalls: 0, remoteWrites: 0,
    caveat: "Real retained inputs, local adapter reconstruction only. NOT a Cloudflare collection/CPU/billing or new source-response proof. No reconstructed record was published." };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = name => process.argv.find(v => v.startsWith(`--${name}=`))?.slice(name.length + 3);
  try { console.log(JSON.stringify(await replayRetainedLive({ stateDir: arg("state-dir"), date: arg("date") }))); }
  catch { console.error(JSON.stringify({ status: "RETAINED_INPUT_REPLAY_FAILED", kisCalls: 0, remoteWrites: 0 })); process.exitCode = 1; }
}
