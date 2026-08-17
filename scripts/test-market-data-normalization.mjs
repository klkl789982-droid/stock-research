import assert from "node:assert/strict";
import { normalizeStockCode } from "../lib/stock-code.mjs";
import { classifyMarketDataRow, normalizeModelInputRows, validateMarketDataQuality } from "../lib/market-data-quality-validator.mjs";
import { createMarketPriceLedger, validateMarketPriceLedger } from "../lib/market-price-ledger.mjs";
import { buildTrackingUniverse } from "../lib/snapshot-quality-pipeline.mjs";

for (const [input, expected] of [["0009K0", "0009K0"], ["0015N0", "0015N0"], ["0039P0", "0039P0"], ["0126Z0", "0126Z0"], ["A005930", "005930"], ["A0009K0", "0009K0"]]) assert.equal(normalizeStockCode(input), expected);
for (const input of [null, undefined, "", "00593", "0005930", "0009k0", " 005930", "005930 ", "00-930", "AA0593!"]) assert.equal(normalizeStockCode(input), null);

const valid = { mkp: 100, hipr: 110, lopr: 90, clpr: 105, trqu: 10 };
const halted = { mkp: 0, hipr: 0, lopr: 0, clpr: 105, trqu: 0 };
const changed = { ...halted, clpr: 106 };
assert.equal(classifyMarketDataRow(valid).type, "validTradingRow");
assert.equal(classifyMarketDataRow(halted, { clpr: 105 }).type, "nonTradingObservation");
assert.deepEqual(classifyMarketDataRow(changed, { clpr: 105 }), { type: "invalidTradingRow", reason: "zeroVolumePriceChanged", prices: { mkp: 0, hipr: 0, lopr: 0, clpr: 106 }, volume: 0 });
assert.deepEqual(normalizeModelInputRows([halted, valid]), [valid]);

const makeRow = (index) => ({ basDt: String(20260817 - index), mkp: 100, hipr: 110, lopr: 90, clpr: 100, trqu: 10, trPrc: 1000, mrktTotAmt: 1_000_000 });
const history = Array.from({ length: 260 }, (_, index) => makeRow(index));
history[10] = { ...history[10], mkp: 0, hipr: 0, lopr: 0, trqu: 0, clpr: history[11].clpr };
const quality = validateMarketDataQuality({ requestedDate: "2026-08-17", universeRecords: [{ code: "A0009K0" }], historyByCode: { "0009K0": history }, requirements: { expectedUniverseCount: 1, requiredTradingValueDays: 20, sourceManifestPresent: true, universeFilterVersion: "v1", universeGeneratedAt: "test" } });
assert.equal(quality.perSymbol["0009K0"].uniqueTradingDays, 259);
assert.equal(quality.modelEligibility["C-v1"].eligibleCodes[0], "0009K0");

const haltedHistory = structuredClone(history);
haltedHistory[0] = { ...haltedHistory[0], mkp: 0, hipr: 0, lopr: 0, trqu: 0, clpr: haltedHistory[1].clpr };
const haltedQuality = validateMarketDataQuality({ requestedDate: "2026-08-17", universeRecords: [{ code: "0009K0" }], historyByCode: { "A0009K0": haltedHistory }, requirements: { expectedUniverseCount: 1, maxRequestedNonTradingRatio: 1, sourceManifestPresent: true, universeFilterVersion: "v1", universeGeneratedAt: "test" } });
assert.equal(haltedQuality.status, "passed");
assert.equal(haltedQuality.modelEligibility["C-v1"].reasons["0009K0"], "tradingHaltOrNoTrade");

const ledger = createMarketPriceLedger("2026-08-17", [{ code: "A0009K0", openPrice: null, closePrice: 100, referenceClose: 100, executable: false }]);
assert.equal(ledger.records[0].code, "0009K0");
assert.equal(ledger.records[0].openPrice, null);
assert.equal(ledger.records[0].closePrice, null);
assert.deepEqual(validateMarketPriceLedger(ledger, 1), []);
assert.deepEqual(buildTrackingUniverse([{ code: "A0009K0", name: "혼합" }], []).map((item) => item.code), ["0009K0"]);
console.log("종목코드 정규화·무거래 행 분류 테스트 통과");
