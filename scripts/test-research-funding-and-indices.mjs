import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createMarketPriceLedger } from "../lib/market-price-ledger.mjs";
import { simulateFundedPortfolio } from "../lib/funded-research-portfolio.mjs";
import { buildPrivateBenchmarkArchive, deriveMarketBenchmarkLegs, loadPrivateBenchmarkLegs, loadResearchIndexSeries } from "../lib/research-index-benchmarks.mjs";
import { archiveResearchPublication, readResearchPublicationReceipts } from "../lib/research-publication-receipts.mjs";

const dates = ["2026-01-05", "2026-01-06", "2026-01-07"];
const calendar = { dates: Object.fromEntries(dates.map((date) => [date, { status: "tradingDay" }])) };
const ledgers = dates.map((date, i) => createMarketPriceLedger(date, [
  { code: "000001", openPrice: 100, closePrice: [50, 100, 100][i] },
  { code: "000002", openPrice: 100, closePrice: [100, 100, 120][i] },
]));
const selections = [{ signalDate: "2026-01-02", entryDate: dates[0], exitDate: dates[1], tickers: ["000001"] },
  { signalDate: dates[0], entryDate: dates[1], exitDate: dates[2], tickers: ["000002"] }];
test("archive only complete authenticated verification and retain original time across later no-op/deploy runs", async () => {
  const values = new Map();
  const store = { read: async (k) => ({value: values.get(k)}), writeImmutable: async (k,v) => { assert.ok(!values.has(k)); values.set(k,v); return {status:"STORED"}; },
    listKeys: async () => [...values.keys()].map((k) => ({type:"file",name:k.split("/").at(-1)})) };
  const date = dates[0], hash = "a".repeat(64), commit = "b".repeat(40);
  const result = { status:"VERIFIED", reason:null, expectedReferenceDate:date, expectedSnapshotHash:hash, expectedCommitSha:commit, verifiedAt:"2026-01-06T08:00:00Z", actual:{ready:{},identities:{}} };
  for (const k of ["top","performance","home","operations"]) { result.actual.ready[k]=true; result.actual[k+"ReferenceDate"]=date; result.actual.identities[k]={referenceDate:date,snapshotHash:hash,commitSha:commit}; }
  const run = {runId:17,runAttempt:1};
  await assert.rejects(archiveResearchPublication({...result, status:"FAILED"},store,run));
  result.actual.ready.home=false; await assert.rejects(archiveResearchPublication(result,store,run)); result.actual.ready.home=true;
  assert.equal(await archiveResearchPublication(result,store,run),"STORED");
  assert.equal(await archiveResearchPublication({...result,verifiedAt:"2026-01-08T08:00:00Z"},store,run),"ALREADY_CONFIRMED");
  const recovered = await readResearchPublicationReceipts([{date,hash}], {store});
  assert.equal(recovered[0].verifiedAt,result.verifiedAt); assert.equal(recovered[0].runUrl,"https://github.com/klkl789982-droid/stock-research/actions/runs/17/attempts/1");
  assert.deepEqual(await readResearchPublicationReceipts([{date,hash:"f".repeat(64)}], {store}), []);
});
test("overlapping holds use prior NAV and opening cash, including interim drawdown", () => {
  const result = simulateFundedPortfolio({ selections, ledgers, calendar, holdingDays: 2 });
  assert.equal(result.status, "VALUED"); assert.deepEqual(result.nav.map((x) => x.value), [75, 100, 107.5]);
  assert.equal(result.maxDrawdown, -25); assert.equal(result.totalReturn, 7.5); assert.equal(result.annualizedReturn, null);
  assert.equal(result.tradeCount, 2); assert.ok(result.nav.every((v) => v.cash >= 0));
});
test("repeated name, standby, exposure cap and share rounding leave unspent cash", () => {
  const repeated = [selections[0], { ...selections[1], tickers: ["000001"] }];
  assert.equal(simulateFundedPortfolio({ selections: repeated, ledgers, calendar, holdingDays: 2 }).tradeCount, 1);
  const capped = [{...selections[0], tickers: [], capacity: 2}, {...selections[1], allocationFraction: 0.5, capacity: 2}];
  assert.equal(simulateFundedPortfolio({ selections: capped, ledgers, calendar, holdingDays: 2 }).totalReturn, 2.5);
});
test("missing intermediate close, missing calendar or impossible exit cannot create account metrics", () => {
  const missing = structuredClone(ledgers); missing[0].records[0].closePrice = null;
  assert.equal(simulateFundedPortfolio({ selections, ledgers: missing, calendar, holdingDays: 2 }).maxDrawdown, null);
  assert.equal(simulateFundedPortfolio({ selections, ledgers, calendar: { dates: {} }, holdingDays: 2 }).status, "UNAVAILABLE");
  assert.equal(simulateFundedPortfolio({ selections: [{ ...selections[0], exitDate: dates[2] }], ledgers, calendar, holdingDays: 2 }).status, "UNAVAILABLE");
});
test("index identity and exact dates; never use another market or closing price for entry", async () => {
  const series = await loadResearchIndexSeries(dates, async (url) => ({
    ok: true, json: async () => ({ rt_cd: "0", output1: { bstp_cls_code: "0001" },
      output2: url.searchParams.get("FID_INPUT_ISCD") === "0001" ? [
        { stck_bsop_date: "20260105", bstp_nmix_oprc: "100", bstp_nmix_prpr: "120" }, { stck_bsop_date: "20260107", bstp_nmix_oprc: "110", bstp_nmix_prpr: "110" },
      ] : [] }),
  }));
  assert.equal(series.length, 2);
  const legs = deriveMarketBenchmarkLegs(series, [{entryDate: dates[0], exitDate: dates[2]}, {entryDate: dates[1], exitDate: dates[2]}]);
  assert.equal(legs.length, 1); assert.equal(legs[0].market, "KOSPI"); assert.ok(Math.abs(legs[0].returnPercent - 10) < 1e-9);
  const artifact = buildPrivateBenchmarkArchive(legs), name = artifact.through + "-" + artifact.contentHash + ".json";
  const store = { listKeys: async () => [{ type: "file", name }], read: async () => ({ value: artifact }) };
  const pairs = [{ entryDate: dates[0], exitDate: dates[2] }];
  assert.deepEqual(await loadPrivateBenchmarkLegs(pairs, { store }), legs);
  assert.deepEqual(await loadPrivateBenchmarkLegs(pairs, { store, asOf: Date.parse("2026-01-07") }), []);
  artifact.legs[0].returnPercent = 99; assert.deepEqual(await loadPrivateBenchmarkLegs(pairs, { store }), []);
});
