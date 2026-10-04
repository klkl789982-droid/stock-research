import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveUniverseForDate } from "../lib/point-in-time-universe.mjs";
import { createSourceManifest, createUniverseArchive, sha256Canonical } from "../lib/snapshot-quality-pipeline.mjs";

const date = "2026-09-30";
const stocks = [{ code: "000001", name: "첫째", market: "KOSPI" }, { code: "000002", name: "둘째", market: "KOSDAQ" }];
const hash = sha256Canonical(stocks.map((stock) => stock.code));
const root = await fs.mkdtemp(path.join(os.tmpdir(), "pit-universe-"));
const archiveDirectory = path.join(root, "data", "universe-history");
await fs.mkdir(archiveDirectory, { recursive: true });
const archivePath = path.join(archiveDirectory, `${date}.json`);
const currentPath = path.join(root, "data", "universe.json");
const current = { generatedAt: "2026-09-01T00:00:00.000Z", latestTradingDate: "20260831", criteria: { version: "v1" }, finalCount: 2, stocks };
const save = (file, value) => fs.writeFile(file, JSON.stringify(value), "utf8");
function artifact(overrides = {}) {
  const base = {
    schemaVersion: 2, requestedDate: date, referenceDate: date,
    generatedAt: "2026-09-30T05:00:00.000Z", createdAt: "2026-09-30T05:00:00.000Z", effectiveAt: "2026-09-30T06:00:00.000Z",
    universeCount: 2, universeCodesHash: hash, filterVersion: "v1", criteria: current.criteria,
    observedUniverse: stocks, provenanceVerification: { status: "VERIFIED" },
    sourceManifest: { securityMaster: { provider: "KIS", asOfDate: date, pointInTimeCertified: true, contentHash: "source-hash" }, officialDailyPriceHash: "price-hash" },
    ...overrides,
  };
  return { ...base, contentHash: sha256Canonical(base) };
}

try {
  await save(currentPath, current);
  await save(archivePath, artifact());
  const selected = await resolveUniverseForDate(date, { root });
  assert.equal(selected.provenance.verificationStatus, "VERIFIED");
  assert.equal(selected.provenance.count, 2);
  assert.equal(selected.provenance.codesHash, hash);
  assert.equal(selected.provenance.artifactPath, `data/universe-history/${date}.json`);
  const sourceManifest = createSourceManifest({ requestedDate: date, generatedAt: "2026-09-30T06:00:00.000Z", universe: selected.universe, historyByCode: new Map(stocks.map((stock) => [stock.code, [{ basDt: "20260930" }]])), formulaHashes: {}, policy: { universeFilterVersion: "v1", pointInTimeMasterCertified: false, rawResponseStored: false }, universeProvenance: selected.provenance, selectedSecurityMaster: selected.artifact.sourceManifest.securityMaster });
  assert.equal(sourceManifest.universe.artifact.artifactPath, selected.provenance.artifactPath);
  assert.equal(sourceManifest.universe.artifact.codesHash, hash);
  assert.equal((await resolveUniverseForDate(date, { root })).provenance.codesHash, hash);
  await save(currentPath, { ...current, stocks: [{ code: "999999" }], finalCount: 1 });
  assert.equal((await resolveUniverseForDate(date, { root })).provenance.codesHash, hash, "현재 Universe가 바뀌어도 과거 선택은 고정됩니다.");

  await save(archivePath, artifact({ effectiveAt: "2026-10-01T00:00:00.000Z" }));
  await assert.rejects(resolveUniverseForDate(date, { root }), /UNIVERSE_FUTURE_KNOWLEDGE/);
  await save(archivePath, artifact({ createdAt: "2026-10-01T00:00:00.000Z" }));
  assert.equal((await resolveUniverseForDate(date, { root })).provenance.verificationStatus, "UNVERIFIED", "사후 생성된 artifact를 VERIFIED로 승격하지 않습니다.");

  const legacyBase = { schemaVersion: 1, requestedDate: date, generatedAt: "2026-10-01T00:00:00.000Z", filterVersion: "v1", criteria: current.criteria, observedUniverse: stocks, sourceManifest: { securityMaster: { provider: "KIS", asOfDate: null, pointInTimeCertified: false } } };
  await save(archivePath, { ...legacyBase, contentHash: sha256Canonical(legacyBase) });
  assert.equal((await resolveUniverseForDate(date, { root })).provenance.verificationStatus, "UNVERIFIED");
  await fs.rm(archivePath);
  await save(currentPath, { ...current, generatedAt: "2026-10-01T00:00:00.000Z", latestTradingDate: "20261001" });
  await assert.rejects(resolveUniverseForDate(date, { root }), /UNIVERSE_FUTURE_KNOWLEDGE/, "미래의 현재 Universe를 과거 날짜에 사용하지 않습니다.");
  await save(currentPath, current);
  assert.equal((await resolveUniverseForDate(date, { root })).provenance.verificationStatus, "UNVERIFIED");
  const generated = createUniverseArchive({ requestedDate: date, generatedAt: "2026-10-01T00:00:00.000Z", universe: current, historyByCode: new Map(stocks.map((stock) => [stock.code, Array.from({ length: 20 }, (_, index) => ({ basDt: `202609${String(30 - index).padStart(2, "0")}`, mrktTotAmt: 100, trPrc: 10 }))])), sourceManifest: { schemaVersion: 2, universe: { filterVersion: "v1" }, sources: { securityMaster: { pointInTimeCertified: false }, officialDailyPrice: { normalizedInputHash: "input-hash" } } }, universeProvenance: (await resolveUniverseForDate(date, { root })).provenance });
  assert.equal(generated.referenceDate, date);
  assert.equal(generated.universeCodesHash, hash);
  assert.equal(generated.provenanceVerification.status, "UNVERIFIED");
  console.log("PASS point-in-time Universe: verified, future rejection, legacy unverified, reproducibility, archive provenance");
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
