import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildKisEodCandidate, KIS_EOD_MODEL_VERSIONS, markKisEodPublished, toPublicKisEodProjection, validatePublicKisEodProjection } from "../lib/kis-eod-pipeline.mjs";
import { kisEodPublicationFiles, publishVerifiedKisEodCandidate, readKisEodTopStocks } from "../lib/kis-eod-publication.mjs";
import { shouldSelectKisEodTop } from "../lib/kis-eod-top-selection.mjs";
import { sha256Canonical } from "../lib/snapshot-quality-pipeline.mjs";

// All writes are isolated synthetic fixtures in OS temporary directories.
const date = "2026-10-08", now = "2026-10-08T07:00:00Z";
function candidate() {
  const rows = [], day = new Date(`${date}T00:00:00Z`);
  while (rows.length < 260) {
    if (![0, 6].includes(day.getUTCDay())) { const close = 2000 - rows.length; rows.push({ basDt: day.toISOString().slice(0, 10).replaceAll("-", ""), mkp: close - 2, hipr: close + 5, lopr: close - 5, clpr: close, trqu: 10000, trPrc: close * 10000, fltRt: 1 / (close - 1) * 100 }); }
    day.setUTCDate(day.getUTCDate() - 1);
  }
  const hashes = Object.fromEntries(KIS_EOD_MODEL_VERSIONS.map((version) => [version, sha256Canonical(`synthetic ${version}`)]));
  return buildKisEodCandidate({
    referenceDate: date, now, expectedUniverseCount: 1,
    officialSnapshot: { asOfDate: "2026-10-07", records: [{ code: "005930", qualityEligibility: { status: "eligible", exclusions: [] } }], sourceManifest: { modelFormulaHashes: hashes } },
    universeRecords: [{ code: "005930", name: "합성 종목", market: "KOSPI" }], historiesByCode: new Map([["005930", rows]]), formulaHashes: hashes, expectedFormulaHashes: hashes,
    adjustmentPolicy: "unadjusted", collectionStartedAt: "2026-10-08T06:40:00Z", collectionCompletedAt: "2026-10-08T06:50:00Z",
    calendarEvidence: { source: "KIS", operation: "chk-holiday", referenceDate: date, isTradingDay: true, receivedAt: "2026-10-08T06:35:00Z" }, observationType: "LIVE_COLLECTION",
    sourceMetadataByCode: new Map([["005930", { receivedAt: "2026-10-08T06:48:00Z", adjustment: "unadjusted", marketDivision: "J", priceBasis: "kisDailyBarUnadjusted", symbolMapping: { status: "VERIFIED_RESPONSE_TICKER", requestedCode: "005930", responseCode: "005930" } }]]),
    sourceFinalityEvidence: { status: "VERIFIED", contractReference: "https://example.invalid/synthetic-contract", documentHash: sha256Canonical("synthetic contract"), referenceDate: date, observedAt: "2026-10-08T06:45:00Z", operation: "inquire-daily-itemchartprice" },
    publicationApproval: { rights: true, rightsReference: "https://example.invalid/synthetic-rights", automation: true },
  });
}

test("API default is unavailable, never a fake zero or a source price", async () => {
  const result = await readKisEodTopStocks({ root: "/nonexistent-test-root", officialDate: "2026-10-07" });
  assert.equal(result.available, false); assert.equal(result.reason, "ACTIVATION_REQUIRES_APPROVAL");
  assert.equal(result.officialSnapshotReferenceDate, "2026-10-07"); assert.ok(!Object.hasOwn(result, "stocks"));
});

test("approved score-only publication is immutable and later retry is idempotent", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tb-kis-publish-")); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const input = candidate();
  assert.equal(input.status, "VALIDATED", JSON.stringify({ quality: input.quality, exclusions: input.records[0].exclusionReasons }));
  await assert.rejects(publishVerifiedKisEodCandidate({ root, candidate: input }), /DISABLED/u);
  const created = await publishVerifiedKisEodCandidate({ root, candidate: input, now, enabled: true });
  assert.equal(created.action, "create"); assert.deepEqual(created.files, [`data/kis-eod-published/${date}.json`]);
  const before = await fs.readFile(path.join(root, created.files[0]), "utf8");
  const again = await publishVerifiedKisEodCandidate({ root, candidate: input, now: "2026-10-08T08:00:00Z", enabled: true });
  assert.equal(again.action, "idempotent"); assert.equal(await fs.readFile(path.join(root, created.files[0]), "utf8"), before);
  const result = await readKisEodTopStocks({ root, enabled: true, model: "B", officialDate: "2026-10-07", now });
  assert.equal(result.available, true); assert.equal(result.stocks.length, 1); assert.equal(result.stocks[0].closePrice, null);
  assert.equal(result.eligibleForRankBacktest, false); assert.equal(result.rankingAsOfDate, date);
  assert.ok(!/"(?:mkp|hipr|lopr|clpr|trqu|trPrc|observedPrice|provisionalOhlcv)"/u.test(before));
});

test("raw fields, corruption, future publication and traversal can never be served", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tb-kis-read-")); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const projection = toPublicKisEodProjection(markKisEodPublished(candidate(), now));
  assert.deepEqual(validatePublicKisEodProjection(projection), []);
  const raw = { ...projection, rawPrices: [] }; assert.ok(validatePublicKisEodProjection(raw).length);
  const directory = path.join(root, "data", "kis-eod-published"); await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, `${date}.json`), JSON.stringify(projection));
  const future = await readKisEodTopStocks({ root, enabled: true, now: "2026-10-08T06:55:00Z" }); assert.equal(future.available, false);
  await fs.writeFile(path.join(directory, `${date}.json`), JSON.stringify(raw));
  assert.equal((await readKisEodTopStocks({ root, enabled: true, now })).available, false);
  assert.throws(() => kisEodPublicationFiles("../../secrets"), /DATE_INVALID/u);
  await assert.rejects(readKisEodTopStocks({ root, model: "../../secret" }), /QUERY_INVALID/u);
  await assert.rejects(readKisEodTopStocks({ root, model: "B", version: "A-v2" }), /QUERY_INVALID/u);
  await assert.rejects(readKisEodTopStocks({ root, limit: 0 }), /QUERY_INVALID/u);
});

test("newer approved provisional alone may replace presentation; same-date LIVE wins", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tb-kis-select-")); t.after(() => fs.rm(root, { recursive: true, force: true }));
  await publishVerifiedKisEodCandidate({ root, candidate: candidate(), now, enabled: true });
  const provisional = await readKisEodTopStocks({ root, enabled: true, now });
  assert.equal(shouldSelectKisEodTop(provisional, { rankingAsOfDate: "2026-10-07" }, "B-v1"), true);
  assert.equal(shouldSelectKisEodTop(provisional, { dataMode: "intradayOfficialSignal", rankingAsOfDate: date }, "B-v1"), false);
  assert.equal(shouldSelectKisEodTop(provisional, { rankingAsOfDate: "2026-10-09" }, "B-v1"), false);
  assert.equal(shouldSelectKisEodTop(provisional, {}, "A-v2"), false);
  assert.equal(shouldSelectKisEodTop({ ...provisional, available: false }, {}, "B-v1"), false);
  assert.equal(shouldSelectKisEodTop({ ...provisional, stocks: [{ ...provisional.stocks[0], closePrice: 0 }] }, {}, "B-v1"), false);
});

test("UI keeps Daily/LIVE contracts, guards, overlay and distinct provisional label", async () => {
  const source = await fs.readFile("components/TopStocksPanel.tsx", "utf8");
  assert.match(source, /api\/top-stocks\?model=/u); assert.match(source, /api\/intraday-model-top\?model=/u);
  assert.match(source, /api\/kis-eod-top-stocks\?model=/u); assert.match(source, /shouldSelectKisEodTop/u);
  assert.match(source, /controller\.signal\.aborted/u); assert.match(source, /TOP_INTRADAY_POLL_MS/u);
  assert.match(source, /공식 성과·14:30 LIVE 성과에 포함하지 않습니다/u);
  assert.match(source, /data\.dataMode !== "kisProvisionalEod" && <th/u);
  const route = await fs.readFile("app/api/kis-eod-top-stocks/route.ts", "utf8");
  assert.match(route, /KIS_EOD_PUBLISH_ENABLED === "true"/u); assert.match(route, /Cache-Control": "no-store"/u);
  assert.ok(!/KIS_APP_KEY|KIS_APP_SECRET|inquire-daily-itemchartprice/u.test(route));
});
