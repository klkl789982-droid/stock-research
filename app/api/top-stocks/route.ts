import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { normalizeStockCode } from "@/lib/stock-code.mjs";
import { createRankingCoverage } from "@/lib/snapshot-quality-pipeline.mjs";

const MODEL_KEYS = {
  A: "modelA",
  B: "modelB",
  C: "modelC",
  D: "modelD",
} as const;

type ModelId = keyof typeof MODEL_KEYS;
type HistoryRecord = {
  code: string;
  name: string;
  market: string;
  closePrice: number;
  scores: Record<string, number | null>;
  ranks: Record<string, number | null>;
  scoresByVersion?: Record<string, number | null>;
  rawScoresByVersion?: Record<string, number | null>;
  ranksByVersion?: Record<string, number | null>;
  rankingUniverseCount?: Record<string, number | null>;
  rankPercentile?: Record<string, number | null>;
  rankingUniverseCountByVersion?: Record<string, number | null>;
  rankPercentileByVersion?: Record<string, number | null>;
};
type HistorySnapshot = {
  asOfDate: string;
  computedAt?: string;
  modelDefinitions: Record<string, { name?: string; modelVersion?: string; status?: string }>;
  records: HistoryRecord[];
  modelVersionDefinitions?: Record<string, { role?: string; status?: string; formulaHash?: string; tieBreakBasis?: string }>;
  championChallenger?: { champion?: string; challenger?: string; promotionStatus?: string; evaluationMode?: string; comparisonStartDate?: string };
  dataQuality?: { overallGrade?: string; structuralStatus?: string; certification?: { eligibleForRankBacktest?: boolean } };
  sourceManifest?: { schemaVersion?: number };
  universe?: { sourceCount?: number };
  universeSummary?: {
    originalUniverse?: { count?: number; codesHash?: string };
    qualityEligibleUniverse?: { count?: number; codesHash?: string };
    quarantinedUniverse?: { count?: number; codesHash?: string };
    exclusionPolicyVersion?: string;
    isPartialRanking?: boolean;
    modelEligibleUniverse?: Record<string, { count?: number; codesHash?: string }>;
    rankingUniverse?: Record<string, { count?: number; codesHash?: string }>;
  };
};
type DailyTopFreshness = {
  snapshotReferenceDate: string | null;
  observedOfficialDate: string | null;
  freshnessStatus: "fresh" | "stale" | "unavailable";
  freshnessReason: string | null;
  updatedAt: string;
};
type IntradayModelBSignal = {
  signalDate: string; officialSignalTime: string; status: "READY" | "FAILED_COLLECTION"; collectionStartedAt: string; collectionCompletedAt: string;
  modelVersion: "B-v1"; collection: { successful: number; failed: number; ineligible: number };
  records: Array<{ ticker: string; companyName: string; score: number | null; rank: number | null; dataStatus: string; provisionalOhlcv?: { close: number } }>;
};
type IntradayModelBStatus = { signalDate: string | null; status: "READY" | "FAILED" | "FAILED_COLLECTION" | "UNAVAILABLE"; reason: string | null; officialSignalTime: string | null };

function isValidSnapshot(value: unknown, filenameDate: string): value is HistorySnapshot {
  if (typeof value !== "object" || value === null) return false;
  const snapshot = value as Partial<HistorySnapshot>;
  if (snapshot.asOfDate !== filenameDate || !Array.isArray(snapshot.records) || snapshot.records.length === 0) return false;
  if (typeof snapshot.modelDefinitions !== "object" || snapshot.modelDefinitions === null) return false;
  return snapshot.records.every((record) =>
    typeof record?.code === "string" &&
    typeof record?.name === "string" &&
    typeof record?.market === "string" &&
    Number.isFinite(record?.closePrice) && record.closePrice > 0 && record?.scores && record?.ranks,
  );
}

async function loadLatestValidSnapshot() {
  const directory = path.join(process.cwd(), "data", "history");
  const filenames = (await readdir(directory))
    .filter((filename) => /^\d{4}-\d{2}-\d{2}\.json$/.test(filename))
    .sort()
    .reverse();

  for (const filename of filenames) {
    const filenameDate = filename.slice(0, 10);
    try {
      const parsed: unknown = JSON.parse(await readFile(path.join(directory, filename), "utf8"));
      if (isValidSnapshot(parsed, filenameDate)) return parsed;
    } catch (error) {
      console.error(`TOP 종목 스냅샷 검사 실패: ${filename}`, error);
    }
  }
  return null;
}

async function loadDailyTopFreshness(snapshot: HistorySnapshot): Promise<DailyTopFreshness> {
  const unavailable = (reason: string): DailyTopFreshness => ({ snapshotReferenceDate: snapshot.asOfDate, observedOfficialDate: null, freshnessStatus: "unavailable", freshnessReason: reason, updatedAt: new Date(0).toISOString() });
  try {
    const value: unknown = JSON.parse(await readFile(path.join(process.cwd(), "data", "daily-production-status", "latest.json"), "utf8"));
    if (typeof value !== "object" || value === null) return unavailable("invalidFreshnessStatus");
    const status = value as Partial<DailyTopFreshness>;
    if (!["fresh", "stale", "unavailable"].includes(String(status.freshnessStatus))) return unavailable("invalidFreshnessStatus");
    const observedOfficialDate = typeof status.observedOfficialDate === "string" ? status.observedOfficialDate : null;
    const updatedAt = typeof status.updatedAt === "string" ? status.updatedAt : new Date(0).toISOString();
    if (status.snapshotReferenceDate !== snapshot.asOfDate) {
      return { snapshotReferenceDate: snapshot.asOfDate, observedOfficialDate, freshnessStatus: observedOfficialDate && observedOfficialDate > snapshot.asOfDate ? "stale" : "unavailable", freshnessReason: "snapshotFreshnessStatusMismatch", updatedAt };
    }
    return { snapshotReferenceDate: snapshot.asOfDate, observedOfficialDate, freshnessStatus: status.freshnessStatus as DailyTopFreshness["freshnessStatus"], freshnessReason: typeof status.freshnessReason === "string" ? status.freshnessReason : null, updatedAt };
  } catch {
    return unavailable("freshnessStatusNotAvailable");
  }
}

async function loadOfficialModelBStatus(): Promise<{ status: IntradayModelBStatus; signal: IntradayModelBSignal | null }> {
  try {
    const latest = JSON.parse(await readFile(path.join(process.cwd(), "data", "intraday-signals", "model-b", "latest.json"), "utf8")) as { status?: string; signalPath?: string };
    const status: IntradayModelBStatus = { signalDate: typeof (latest as { signalDate?: unknown }).signalDate === "string" ? (latest as { signalDate: string }).signalDate : null, status: latest.status === "READY" ? "READY" : latest.status === "FAILED" ? "FAILED" : latest.status === "FAILED_COLLECTION" ? "FAILED_COLLECTION" : "UNAVAILABLE", reason: typeof (latest as { reason?: unknown }).reason === "string" ? (latest as { reason: string }).reason : null, officialSignalTime: typeof (latest as { officialSignalTime?: unknown }).officialSignalTime === "string" ? (latest as { officialSignalTime: string }).officialSignalTime : null };
    if (status.status !== "READY" || typeof latest.signalPath !== "string" || !/^data\/intraday-signals\/model-b\/\d{4}-\d{2}-\d{2}\/1430\.json$/u.test(latest.signalPath)) return { status, signal: null };
    const value: unknown = JSON.parse(await readFile(path.join(process.cwd(), latest.signalPath), "utf8"));
    if (typeof value !== "object" || value === null) return { status: { ...status, status: "UNAVAILABLE", reason: "invalidOfficialSignal" }, signal: null };
    const signal = value as IntradayModelBSignal;
    return signal.status === "READY" && signal.modelVersion === "B-v1" && Array.isArray(signal.records) ? { status, signal } : { status: { ...status, status: "UNAVAILABLE", reason: "invalidOfficialSignal" }, signal: null };
  } catch { return { status: { signalDate: null, status: "UNAVAILABLE", reason: "officialSignalNotAvailable", officialSignalTime: null }, signal: null }; }
}

export async function GET(request: NextRequest) {
  const modelParameter = request.nextUrl.searchParams.get("model")?.toUpperCase() ?? "A";
  if (!(modelParameter in MODEL_KEYS)) {
    return NextResponse.json({ error: { code: "INVALID_MODEL", message: "model은 A, B, C, D 중 하나여야 합니다." } }, { status: 400 });
  }
  const model = modelParameter as ModelId;
  const requestedVersion = request.nextUrl.searchParams.get("version");
  if (requestedVersion && (model !== "A" || !["A-v1", "A-v2"].includes(requestedVersion))) {
    return NextResponse.json({ error: { code: "INVALID_MODEL_VERSION", message: "version은 model=A에서 A-v1 또는 A-v2만 지원합니다." } }, { status: 400 });
  }
  const requestedLimit = Number(request.nextUrl.searchParams.get("limit") ?? "50");
  if (!Number.isInteger(requestedLimit) || requestedLimit < 1) {
    return NextResponse.json({ error: { code: "INVALID_LIMIT", message: "limit은 1 이상의 정수여야 합니다." } }, { status: 400 });
  }
  const limit = Math.min(requestedLimit, 50);
  const snapshot = await loadLatestValidSnapshot();
  if (!snapshot) {
    return NextResponse.json({ error: { code: "HISTORY_SNAPSHOT_NOT_FOUND", message: "실제 TOP50 데이터가 없습니다. 최신 유효 모델 스냅샷을 생성해야 합니다." } }, { status: 503 });
  }
  const freshness = await loadDailyTopFreshness(snapshot);

  if (model === "B" && !requestedVersion) {
    const official = await loadOfficialModelBStatus(); const signal = official.signal;
    if (signal) {
      const stocks = signal.records.filter((record) => record.dataStatus === "AVAILABLE" && Number.isInteger(record.rank) && Number.isFinite(record.score)).sort((a, b) => Number(a.rank) - Number(b.rank)).slice(0, limit).map((record) => ({ rank: record.rank, code: normalizeStockCode(record.ticker) ?? record.ticker, name: record.companyName, market: "", score: record.score, closePrice: record.provisionalOhlcv?.close ?? 0, priceBasis: "intradayOfficialSignal", priceAsOfDate: signal.signalDate, rankingUniverseCount: signal.collection.successful, rankPercentile: Number(record.rank) / signal.collection.successful }));
      return NextResponse.json({ dataMode: "intradayOfficialSignal", model: "B", modelName: "trendStrength", modelVersion: "B-v1", rankingAsOfDate: signal.signalDate, priceAsOfDate: signal.signalDate, priceBasis: "intradayOfficialSignal", officialSignalTime: signal.officialSignalTime, collectionStartedAt: signal.collectionStartedAt, collectionCompletedAt: signal.collectionCompletedAt, count: stocks.length, stocks, freshness, officialSignal: official.status }, { headers: { "Cache-Control": "no-store" } });
    }
  }

  if (model === "A" && requestedVersion === "A-v2") {
    const hasModelAV2 =
      snapshot.modelVersionDefinitions?.["A-v2"] &&
      snapshot.records.some((record) => Number.isFinite(record.scoresByVersion?.["A-v2"]) && Number.isFinite(record.rawScoresByVersion?.["A-v2"]) && Number.isInteger(record.ranksByVersion?.["A-v2"]));
    if (!hasModelAV2) {
      return NextResponse.json({
        error: {
          code: "A_V2_DATA_NOT_AVAILABLE",
          message: "A-v2 데이터가 없습니다. 비교 시작 전 스냅샷이며 최초 A-v2 스냅샷 생성이 필요합니다.",
        },
        model: "A",
        modelVersion: "A-v2",
        modelRole: "challenger",
        promotionStatus: "notApproved",
        snapshotAsOfDate: snapshot.asOfDate,
        comparisonStatus: "beforeStart",
      }, { status: 404, headers: { "Cache-Control": "no-store" } });
    }

    const definition = snapshot.modelVersionDefinitions?.["A-v2"];
    const coverage = createRankingCoverage(snapshot, "A-v2", snapshot.records.filter((record) => Number.isInteger(record.ranksByVersion?.["A-v2"])).length);
    const stocks = [...snapshot.records]
      .filter((record) => Number.isInteger(record.ranksByVersion?.["A-v2"]))
      .sort((left, right) => Number(left.ranksByVersion?.["A-v2"]) - Number(right.ranksByVersion?.["A-v2"]))
      .slice(0, limit)
      .map((record) => ({
        rank: record.ranksByVersion?.["A-v2"], code: normalizeStockCode(record.code) ?? record.code, name: record.name, market: record.market,
        score: record.scoresByVersion?.["A-v2"], rawScore: record.rawScoresByVersion?.["A-v2"], closePrice: record.closePrice,
        priceBasis: "officialDailyClose", priceAsOfDate: snapshot.asOfDate,
        rankingUniverseCount: record.rankingUniverseCountByVersion?.["A-v2"] ?? coverage.rankingUniverseCount,
        rankPercentile: record.rankPercentileByVersion?.["A-v2"] ?? Number(record.ranksByVersion?.["A-v2"]) / coverage.rankingUniverseCount,
      }));
    return NextResponse.json({
      dataMode: "historySnapshot", model: "A", modelName: "bounded technical-strength challenger",
      modelVersion: "A-v2", modelRole: definition?.role ?? "challenger",
      promotionStatus: snapshot.championChallenger?.promotionStatus ?? "notApproved",
      rankingAsOfDate: snapshot.asOfDate, priceAsOfDate: snapshot.asOfDate, priceBasis: "officialDailyClose",
      scoreBasis: "finalScore", tieBreakBasis: "rawScoreThenCode", formulaHash: definition?.formulaHash ?? null,
      comparisonStartDate: snapshot.championChallenger?.comparisonStartDate ?? snapshot.asOfDate,
      ...coverage,
      dataQualityGrade: snapshot.dataQuality?.overallGrade ?? "UNKNOWN", structuralStatus: snapshot.dataQuality?.structuralStatus ?? "unknown",
      eligibleForRankBacktest: snapshot.dataQuality?.certification?.eligibleForRankBacktest ?? false, sourceManifestVersion: snapshot.sourceManifest?.schemaVersion ?? null,
      generatedAt: new Date().toISOString(), snapshotComputedAt: snapshot.computedAt ?? null, freshness, count: stocks.length, stocks,
    }, { headers: { "Cache-Control": "no-store" } });
  }

  const modelKey = MODEL_KEYS[model];
  const definition = snapshot.modelDefinitions[model];
  const modelVersion = definition?.modelVersion ?? "";
  const coverage = createRankingCoverage(snapshot, modelVersion, snapshot.records.filter((record) => Number.isInteger(record.ranks[modelKey])).length);
  const stocks = [...snapshot.records]
    .filter((record) => Number.isInteger(record.ranks[modelKey]))
    .sort((left, right) => {
      const rankDifference = Number(left.ranks[modelKey]) - Number(right.ranks[modelKey]);
      return rankDifference || left.code.localeCompare(right.code);
    })
    .slice(0, limit)
    .map((record) => ({
      rank: record.ranks[modelKey],
      code: normalizeStockCode(record.code) ?? record.code,
      name: record.name,
      market: record.market,
      score: record.scores[modelKey],
      closePrice: record.closePrice,
      priceBasis: "officialDailyClose",
      priceAsOfDate: snapshot.asOfDate,
      rankingUniverseCount: record.rankingUniverseCount?.[modelKey] ?? coverage.rankingUniverseCount,
      rankPercentile: record.rankPercentile?.[modelKey] ?? Number(record.ranks[modelKey]) / coverage.rankingUniverseCount,
    }));

  return NextResponse.json({
    dataMode: "historySnapshot",
    model,
    modelName: definition?.name ?? modelKey,
    modelVersion: definition?.modelVersion ?? null,
    modelRole: model === "A" ? "champion" : undefined,
    rankingAsOfDate: snapshot.asOfDate,
    priceAsOfDate: snapshot.asOfDate,
    priceBasis: "officialDailyClose",
    generatedAt: new Date().toISOString(),
    snapshotComputedAt: snapshot.computedAt ?? null,
    ...coverage,
    dataQualityGrade: snapshot.dataQuality?.overallGrade ?? "UNKNOWN",
    structuralStatus: snapshot.dataQuality?.structuralStatus ?? "unknown",
    eligibleForRankBacktest: snapshot.dataQuality?.certification?.eligibleForRankBacktest ?? false,
    sourceManifestVersion: snapshot.sourceManifest?.schemaVersion ?? null,
    freshness,
    officialSignal: model === "B" ? (await loadOfficialModelBStatus()).status : undefined,
    count: stocks.length,
    stocks,
  }, { headers: { "Cache-Control": "no-store" } });
}
