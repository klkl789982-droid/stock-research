import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { createKisEodPrivateStore } from "./kis-eod-private-store.mjs";
import { LIVE_DELIVERY_PREFIX, readLatestPublication } from "./private-live-delivery.mjs";
import { createCurrentLiveReader } from "./current-live-universe.mjs";
import { resolveIntradayModelTopOutcomes } from "./intraday-model-top-outcome-resolver.mjs";
import { buildIntradayModelTopPerformance } from "./model-top-performance.mjs";
import { prepareMarketPriceLedgers } from "./future-return-resolver.mjs";
import { validateMarketPriceLedger } from "./market-price-ledger.mjs";
import recoveryReceipt from "../infra/cloudflare-live-kis-diagnostic/supervisor-recovery-20261019.json" with { type: "json" };
import { FORMULA_HASHES } from "../infra/cloudflare-live-kis-diagnostic/formula-manifest.mjs";

const layer = "INTRADAY_1400_LIVE";
const policy = "intraday-1400-published-t1-open-v1";
const read = async file => JSON.parse(await readFile(file, "utf8"));

// Old PC deliveries retained TOP5 only. Link the real site readback by both
// immutable hashes. The read time proves availability by then, not first publication.
function retainedSelection(delivery, now) {
  const replay = recoveryReceipt.retainedRealReplay, site = recoveryReceipt.productionSite;
  if (delivery.schemaVersion !== 1 || site.authenticatedApiStatus !== "AVAILABLE" || site.hashMatchesRetainedDelivery !== true ||
      !replay.entireOriginalResultHashReproduced || replay.sourceHash !== delivery.sourceHash || replay.deliveryHash !== delivery.deliveryHash ||
      replay.signalDate !== delivery.signalDate || Date.parse(site.apiServedAtUtc) > Date.parse(now)) return null;
  const records = new Map(), modelDefinitions = {};
  const archivedFormulas = { "A-v1": "43efe2d499ccb05b183056f8e8f82bf91190e863ba86fb326c398f16006fcb4c",
    "B-v1": "b9a45d38d0398617133ce8c9ce9dd05393ba787c3ad8e032efc8cb5cea6052d0",
    "C-v1": "86f255711483ae949ec913750048461ac3a41b98dc28b2c0e21ca10522b16b8b",
    "D-v1": "033a5f3e40adba3c74360e646b622b95683b1a83805baeb079227226658e732f" };
  for (const model of delivery.models) {
    const version = model.modelVersion, formulaHash = archivedFormulas[version];
    if (!formulaHash || !Object.values(FORMULA_HASHES).includes(formulaHash)) return null;
    modelDefinitions[model.model] = { modelVersion: version, formulaHash };
    for (const row of model.records) {
      const grouped = records.get(row.ticker) ?? { ticker: row.ticker, companyName: row.companyName, dataStatus: "AVAILABLE", ranks: {}, observationIds: {} };
      grouped.ranks[version] = row.rank;
      grouped.observationIds[version] = [delivery.deliveryHash, version, row.ticker].join("/");
      records.set(row.ticker, grouped);
    }
  }
  return { ...delivery, artifactType: "immutable-pc-delivery", contentHash: delivery.deliveryHash, officialSignalTime: "14:00:00",
    publishedAt: null, authenticatedReadAt: site.apiServedAtUtc, collectionCompletedAt: delivery.models[0].collectionCompletedAt,
    publicationStatus: "COMPLETE", revision: null, selectionDepth: 5, modelDefinitions, records: [...records.values()], status: "READY" };
}

export function publishedOutcomeSignal(universe) {
  if (universe.publicationStatus !== "COMPLETE" || !universe.publishedAt) throw new Error("LIVE_PUBLICATION_UNVERIFIED");
  return { ...universe, status: "READY", contentHash: universe.deliveryHash, artifactType: "private-live-delivery",
    records: universe.records.filter(row => row.observationHash).map(row => ({
      ticker: row.code, companyName: row.name, dataStatus: "AVAILABLE",
      ranks: Object.fromEntries(Object.entries(row.models).map(([version, metric]) => [version, metric.rank])),
      observationIds: Object.fromEntries(Object.keys(row.models).map(version =>
        [version, [universe.observationPolicyId, universe.deliveryHash, version, row.code].join("/")])),
    })) };
}

async function loadPrices(root) {
  const directory = path.join(root, "data/market-prices");
  const names = (await readdir(directory)).filter(name => /^\d{4}-\d{2}-\d{2}\.json$/u.test(name));
  const ledgers = await Promise.all(names.map(async name => {
    const ledger = await read(path.join(directory, name));
    if (ledger.date + ".json" !== name || !Array.isArray(ledger.records) ||
        ledger.records.some(row => row.date !== ledger.date) || validateMarketPriceLedger(ledger, 0).length) return null;
    return ledger;
  }));
  return { priceLedgers: prepareMarketPriceLedgers(ledgers.filter(Boolean)), tradingCalendar: await read(path.join(root, "data/trading-calendar/status.json")) };
}

export async function publishedLivePerformance({ store, now = new Date().toISOString(), readUniverse = createCurrentLiveReader({ store }),
  prices = () => loadPrices(process.cwd()) }) {
  const years = await store.listKeys(`${LIVE_DELIVERY_PREFIX}/heads`);
  const dates = new Set();
  for (const year of years) {
    if (year.type !== "dir" || !/^\d{4}$/u.test(year.name)) throw new Error("LIVE_INVENTORY_INVALID");
    for (const entry of await store.listKeys(`${LIVE_DELIVERY_PREFIX}/heads/${year.name}`)) {
      const match = /^(\d{4}-\d{2}-\d{2})(?:-\d{13}-[a-f0-9]{64}\.json)?$/u.exec(entry.name);
      if (!match || !match[1].startsWith(year.name + "-")) throw new Error("LIVE_INVENTORY_INVALID");
      dates.add(match[1]);
    }
  }
  const outcomes = [], publications = [];
  let market = null;
  for (const signalDate of [...dates].sort()) {
    const selected = await readLatestPublication(store, { signalDate, now });
    if (!selected) throw new Error("LIVE_PUBLICATION_MISSING");
    const { delivery, publicationTimes } = selected;
    const status = delivery.publication?.status ?? "COMPLETE";
    const publishedAt = publicationTimes?.publishedAt ?? null;
    const base = { signalDate, revision: delivery.publication?.revision ?? null, deliveryHash: delivery.deliveryHash, status, publishedAt };
    let signal = !publishedAt && status === "COMPLETE" ? retainedSelection(delivery, now) : null;
    if (status !== "COMPLETE" || !publishedAt && !signal) {
      publications.push({ ...base, evaluation: status === "PARTIAL" ? "PARTIAL_EXCLUDED" : "PUBLICATION_TIME_UNKNOWN" });
      continue;
    }
    if (!signal) {
      const universe = await readUniverse({ signalDate, now });
      if (universe.deliveryHash !== delivery.deliveryHash || universe.publishedAt !== publishedAt) throw new Error("LIVE_PUBLICATION_CHANGED");
      signal = publishedOutcomeSignal(universe);
    }
    market ??= await prices();
    outcomes.push(resolveIntradayModelTopOutcomes({ signal, ...market, resolvedAt: now }));
    publications.push({ ...base, authenticatedReadAt: signal.authenticatedReadAt ?? null, selectionDepth: signal.selectionDepth ?? 20, evaluation: "TRACKED" });
  }
  // The full-universe reader verifies each immutable version and formula digest.
  const report = buildIntradayModelTopPerformance({ outcomes });
  return { ...report, layer, executionPolicyId: policy, publications };
}

let cached, loading;
export async function loadPublishedLivePerformance() {
  if (process.env.PRIVATE_LIVE_DELIVERY_READ_ENABLED !== "true" || process.env.PRIVATE_LIVE_DELIVERY_FIXTURE_ID)
    throw new Error("LIVE_READ_DISABLED");
  if (cached && Date.now() < cached.expiresAt) return cached.value;
  loading ??= publishedLivePerformance({ store: createKisEodPrivateStore({ repository: process.env.PRIVATE_LIVE_DELIVERY_REPOSITORY,
    token: process.env.PRIVATE_LIVE_DELIVERY_READ_TOKEN }) }).then(value => {
      cached = { value, expiresAt: Date.now() + 60000 }; return value;
    }).finally(() => { loading = null; });
  return loading;
}
