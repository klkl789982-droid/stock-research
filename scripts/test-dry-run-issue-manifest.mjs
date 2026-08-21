import assert from "node:assert/strict";
import {
  createDryRunIssueManifest,
  validateDryRunIssueManifest,
} from "../lib/dry-run-issue-manifest.mjs";
import { validateMarketDataQuality } from "../lib/market-data-quality-validator.mjs";

const SECRET = "manifest-must-not-contain-this-secret";
const requestedDate = "2026-08-13";

function row(date, close, volume = 100) {
  return {
    basDt: date,
    mkp: volume === 0 ? 0 : close - 1,
    hipr: volume === 0 ? 0 : close + 1,
    lopr: volume === 0 ? 0 : close - 2,
    clpr: close,
    trqu: volume,
    trPrc: close * Math.max(volume, 1),
    mrktTotAmt: 1_000_000,
    serviceKey: SECRET,
  };
}

const historyByCode = new Map();
const issues = [];
for (let index = 0; index < 36; index += 1) {
  const code = String(360000 + index).padStart(6, "0");
  const rows = [row("20260813", 100), row("20260812", 101, 0), row("20260811", 100)];
  historyByCode.set(code, rows);
  issues.push({ severity: "fatal", type: "zeroVolumePriceChanged", code, date: "20260812", rowIndex: 1, token: SECRET });
}
issues.push({ severity: "warning", type: "nonTradingObservation", code: "000001", date: "20260810", rowIndex: 0, header: `Bearer ${SECRET}` });
historyByCode.set("000001", [row("20260810", 100, 0), row("20260809", 100)]);

const manifest = createDryRunIssueManifest({ requestedDate, quality: { issues }, historyByCode });
assert.equal(manifest.fatalCount, 36);
assert.equal(manifest.warningCount, 1);
assert.equal(manifest.issueTypeCounts.zeroVolumePriceChanged, 36);
assert.equal(manifest.issues.length, 37);
assert.deepEqual(manifest.issues[0], {
  severity: "warning",
  validatorRule: "nonTradingObservation",
  code: "000001",
  date: "20260810",
  rowIndex: 0,
  ohlcv: { mkp: 0, hipr: 0, lopr: 0, clpr: 100, trqu: 0 },
  previousRow: { date: null, clpr: null },
  nextRow: { date: "20260809", clpr: 100 },
});
assert.deepEqual(manifest.issues[1].previousRow, { date: "20260813", clpr: 100 });
assert.deepEqual(manifest.issues[1].nextRow, { date: "20260811", clpr: 100 });
assert.deepEqual(validateDryRunIssueManifest(manifest), []);
assert.equal(createDryRunIssueManifest({ requestedDate, quality: { issues: [...issues].reverse() }, historyByCode }).contentHash, manifest.contentHash);
assert.equal(JSON.stringify(manifest).includes(SECRET), false);

const validatorInput = {
  requestedDate,
  universeRecords: [{ code: "000001" }],
  historyByCode: { "000001": [row("20260813", 101, 0), row("20260812", 100)] },
  requirements: { expectedUniverseCount: 1, maxRequestedNonTradingRatio: 1 },
};
const before = validateMarketDataQuality(validatorInput);
createDryRunIssueManifest({ requestedDate, quality: before, historyByCode: validatorInput.historyByCode });
const after = validateMarketDataQuality(validatorInput);
assert.deepEqual(after, before);
assert.ok(before.issues.some((entry) => entry.type === "zeroVolumePriceChanged" && entry.severity === "fatal"));

console.log("dry-run issue manifest: all synthetic checks passed");
