import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";

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
};
type HistorySnapshot = {
  asOfDate: string;
  computedAt?: string;
  modelDefinitions: Record<string, { name?: string; modelVersion?: string; status?: string }>;
  records: HistoryRecord[];
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
    Number.isFinite(record?.closePrice) && record.closePrice > 0 &&
    Object.values(MODEL_KEYS).every((key) => Number.isFinite(record?.scores?.[key]) && Number.isInteger(record?.ranks?.[key])),
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
  const requestedLimit = Number(request.nextUrl.searchParams.get("limit") ?? "50");
  if (!Number.isInteger(requestedLimit) || requestedLimit < 1) {
    return NextResponse.json({ error: { code: "INVALID_LIMIT", message: "limit은 1 이상의 정수여야 합니다." } }, { status: 400 });
  }
  const limit = Math.min(requestedLimit, 50);
  const snapshot = await loadLatestValidSnapshot();
  if (!snapshot) {
    return NextResponse.json({ error: { code: "HISTORY_SNAPSHOT_NOT_FOUND", message: "실제 TOP50 데이터가 없습니다. 최신 유효 모델 스냅샷을 생성해야 합니다." } }, { status: 503 });
  }

  const modelKey = MODEL_KEYS[model];
  const definition = snapshot.modelDefinitions[model];
  const stocks = [...snapshot.records]
    .sort((left, right) => {
      const rankDifference = Number(left.ranks[modelKey]) - Number(right.ranks[modelKey]);
      return rankDifference || left.code.localeCompare(right.code);
    })
    .slice(0, limit)
    .map((record) => ({
      rank: record.ranks[modelKey],
      code: record.code,
      name: record.name,
      market: record.market,
      score: record.scores[modelKey],
      closePrice: record.closePrice,
      priceBasis: "officialDailyClose",
      priceAsOfDate: snapshot.asOfDate,
    }));

  return NextResponse.json({
    dataMode: "historySnapshot",
    model,
    modelName: definition?.name ?? modelKey,
    modelVersion: definition?.modelVersion ?? null,
    rankingAsOfDate: snapshot.asOfDate,
    priceAsOfDate: snapshot.asOfDate,
    priceBasis: "officialDailyClose",
    generatedAt: new Date().toISOString(),
    snapshotComputedAt: snapshot.computedAt ?? null,
    count: stocks.length,
    stocks,
  }, { headers: { "Cache-Control": "no-store" } });
}
