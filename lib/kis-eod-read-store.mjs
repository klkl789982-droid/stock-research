// Read-only HTTP store: keep collector/publication filesystem helpers out of its trace.
import fs from "node:fs/promises";
import path from "node:path";
import { validatePublicKisEodProjection } from "./kis-eod-projection.mjs";

const models = { A: "A-v1", B: "B-v1", C: "C-v1", D: "D-v1" };
const filenames = /^\d{4}-\d{2}-\d{2}\.json$/u;

export async function latestOfficialKisFallbackDate(root) {
  const directory = path.join(root, "data", "history");
  const names = await fs.readdir(directory).catch(() => []);
  for (const name of names.filter((name) => filenames.test(name)).sort().reverse()) {
    try {
      const snapshot = JSON.parse(await fs.readFile(path.join(directory, name), "utf8"));
      if (snapshot.asOfDate === name.slice(0, 10) && snapshot.records?.length && snapshot.records.every((row) => typeof row.code === "string" && Number.isFinite(row.closePrice) && row.closePrice > 0 && row.scores && row.ranks)) return snapshot.asOfDate;
    } catch { /* Invalid files cannot establish the fallback date. */ }
  }
  return null;
}

/** @param {{root:string, enabled?:boolean, model?:string, version?:string|null, limit?:number, officialDate?:string|null, now?:Date|string}} options */
export async function readKisEodTopStocks({ root, enabled = false, model = "B", version = null, limit = 5, officialDate = null, now = new Date() }) {
  if (!Object.hasOwn(models, model) || (version !== null && (model !== "A" || !["A-v1", "A-v2"].includes(version)))) throw new Error("KIS_EOD_QUERY_INVALID");
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error("KIS_EOD_QUERY_INVALID");
  const unavailable = (reason) => ({ available: false, dataMode: "kisProvisionalEod", status: "KIS_EOD_PENDING", reason, officialSnapshotReferenceDate: officialDate });
  if (enabled !== true) return unavailable("ACTIVATION_REQUIRES_APPROVAL");
  const directory = path.join(root, "data", "kis-eod-published");
  const names = await fs.readdir(directory).catch(() => []);
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(now));
  const modelVersion = version ?? models[model];
  for (const name of names.filter((name) => filenames.test(name)).sort().reverse()) {
    try {
      const value = JSON.parse(await fs.readFile(path.join(directory, name), "utf8"));
      if (validatePublicKisEodProjection(value).length || value.referenceDate !== name.slice(0, 10) || value.referenceDate > today || Date.parse(value.publishedAt) > new Date(now).getTime()) continue;
      const stocks = value.records.filter((row) => Number.isFinite(row.scores[modelVersion]) && Number.isInteger(row.ranks[modelVersion])).sort((a, b) => a.ranks[modelVersion] - b.ranks[modelVersion]).slice(0, limit).map((row) => ({ rank: row.ranks[modelVersion], code: row.ticker, name: row.companyName, market: row.market ?? "정보 없음", score: row.scores[modelVersion], closePrice: null, priceBasis: "notPubliclyRedistributed", priceAsOfDate: value.referenceDate }));
      if (!stocks.length) continue;
      return { available: true, dataMode: "kisProvisionalEod", status: "KIS_EOD_PUBLISHED", provisional: true, model, modelName: model, modelVersion, rankingAsOfDate: value.referenceDate, priceAsOfDate: value.referenceDate, priceBasis: "notPubliclyRedistributed", generatedAt: value.collectionCompletedAt, count: stocks.length, stocks, officialSnapshotReferenceDate: officialDate, dataQualityGrade: "PROVISIONAL", structuralStatus: "passed", eligibleForRankBacktest: false, eligibleForOfficialRanking: false, eligibleForOptimization: false, rankingUniverseCount: value.rankingUniverse[modelVersion].count, originalUniverseCount: value.coverage.total, qualityEligibleUniverseCount: value.coverage.analyzable, quarantinedCount: value.coverage.excluded, isPartialRanking: value.coverage.excluded > 0, sourceFinality: value.sourceFinality, publicProjectionHash: value.publicProjectionHash, source: "KIS" };
    } catch { /* Corruption never replaces the last valid published candidate. */ }
  }
  return unavailable("VALIDATED_PUBLICATION_NOT_AVAILABLE");
}
