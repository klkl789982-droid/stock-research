import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { normalizeStockCode } from "@/lib/stock-code.mjs";

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
  universeSummary?: { modelEligibleUniverse?: Record<string, { count?: number; codesHash?: string }> };
};

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
    const stocks = [...snapshot.records]
      .filter((record) => Number.isInteger(record.ranksByVersion?.["A-v2"]))
      .sort((left, right) => Number(left.ranksByVersion?.["A-v2"]) - Number(right.ranksByVersion?.["A-v2"]))
      .slice(0, limit)
      .map((record) => ({
        rank: record.ranksByVersion?.["A-v2"], code: normalizeStockCode(record.code) ?? record.code, name: record.name, market: record.market,
        score: record.scoresByVersion?.["A-v2"], rawScore: record.rawScoresByVersion?.["A-v2"], closePrice: record.closePrice,
        priceBasis: "officialDailyClose", priceAsOfDate: snapshot.asOfDate,
        rankingUniverseCount: record.rankingUniverseCountByVersion?.["A-v2"] ?? snapshot.universeSummary?.modelEligibleUniverse?.["A-v2"]?.count ?? snapshot.records.length,
        rankPercentile: record.rankPercentileByVersion?.["A-v2"] ?? Number(record.ranksByVersion?.["A-v2"]) / (snapshot.universeSummary?.modelEligibleUniverse?.["A-v2"]?.count ?? snapshot.records.length),
      }));
    return NextResponse.json({
      dataMode: "historySnapshot", model: "A", modelName: "bounded technical-strength challenger",
      modelVersion: "A-v2", modelRole: definition?.role ?? "challenger",
      promotionStatus: snapshot.championChallenger?.promotionStatus ?? "notApproved",
      rankingAsOfDate: snapshot.asOfDate, priceAsOfDate: snapshot.asOfDate, priceBasis: "officialDailyClose",
      scoreBasis: "finalScore", tieBreakBasis: "rawScoreThenCode", formulaHash: definition?.formulaHash ?? null,
      comparisonStartDate: snapshot.championChallenger?.comparisonStartDate ?? snapshot.asOfDate,
      rankingUniverseCount: snapshot.universeSummary?.modelEligibleUniverse?.["A-v2"]?.count ?? snapshot.records.length,
      rankingUniverseHash: snapshot.universeSummary?.modelEligibleUniverse?.["A-v2"]?.codesHash ?? null,
      dataQualityGrade: snapshot.dataQuality?.overallGrade ?? "UNKNOWN", structuralStatus: snapshot.dataQuality?.structuralStatus ?? "unknown",
      eligibleForRankBacktest: snapshot.dataQuality?.certification?.eligibleForRankBacktest ?? false, sourceManifestVersion: snapshot.sourceManifest?.schemaVersion ?? null,
      generatedAt: new Date().toISOString(), snapshotComputedAt: snapshot.computedAt ?? null, count: stocks.length, stocks,
    }, { headers: { "Cache-Control": "no-store" } });
  }

  const modelKey = MODEL_KEYS[model];
  const definition = snapshot.modelDefinitions[model];
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
      rankingUniverseCount: record.rankingUniverseCount?.[modelKey] ?? snapshot.universeSummary?.modelEligibleUniverse?.[definition?.modelVersion ?? ""]?.count ?? snapshot.records.length,
      rankPercentile: record.rankPercentile?.[modelKey] ?? Number(record.ranks[modelKey]) / (snapshot.universeSummary?.modelEligibleUniverse?.[definition?.modelVersion ?? ""]?.count ?? snapshot.records.length),
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
    rankingUniverseCount: snapshot.universeSummary?.modelEligibleUniverse?.[definition?.modelVersion ?? ""]?.count ?? snapshot.records.length,
    rankingUniverseHash: snapshot.universeSummary?.modelEligibleUniverse?.[definition?.modelVersion ?? ""]?.codesHash ?? null,
    dataQualityGrade: snapshot.dataQuality?.overallGrade ?? "UNKNOWN",
    structuralStatus: snapshot.dataQuality?.structuralStatus ?? "unknown",
    eligibleForRankBacktest: snapshot.dataQuality?.certification?.eligibleForRankBacktest ?? false,
    sourceManifestVersion: snapshot.sourceManifest?.schemaVersion ?? null,
    count: stocks.length,
    stocks,
  }, { headers: { "Cache-Control": "no-store" } });
}
