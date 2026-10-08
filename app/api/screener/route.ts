import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { createScreeningRows, screenStocks, SCREENING_MODELS } from "@/lib/stock-screener.mjs";

type JsonObject = Record<string, unknown>;

async function loadLatest(directory: string, validate: (value: JsonObject, date: string) => boolean) {
  const files = (await readdir(directory)).filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/u.test(name)).sort().reverse();
  for (const file of files) {
    try {
      const value = JSON.parse(await readFile(path.join(directory, file), "utf8")) as JsonObject;
      if (validate(value, file.slice(0, 10))) return value;
    } catch { /* malformed artifacts are skipped, matching the existing TOP loader */ }
  }
  return null;
}

const numberParam = (request: NextRequest, name: string) => {
  const raw = request.nextUrl.searchParams.get(name);
  if (raw === null || raw === "") return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
};

export async function GET(request: NextRequest) {
  const model = request.nextUrl.searchParams.get("model") ?? "A-v1";
  if (!(model in SCREENING_MODELS)) return NextResponse.json({ error: { message: "지원하지 않는 모델입니다." } }, { status: 400 });
  const minScore = numberParam(request, "minScore");
  const maxScore = numberParam(request, "maxScore");
  const maxRank = numberParam(request, "maxRank");
  if ([minScore, maxScore, maxRank].some((value) => Number.isNaN(value)) || (minScore !== null && maxScore !== null && minScore > maxScore) || (maxRank !== null && (!Number.isInteger(maxRank) || maxRank < 1))) {
    return NextResponse.json({ error: { message: "스크리닝 조건을 확인해 주세요." } }, { status: 400 });
  }
  const companyGrade = request.nextUrl.searchParams.get("companyGrade") || null;
  const allowedGrades = ["관심 종목", "양호", "중립", "주의", "위험"];
  if (companyGrade && !allowedGrades.includes(companyGrade)) return NextResponse.json({ error: { message: "지원하지 않는 기업분석 등급입니다." } }, { status: 400 });

  const history = await loadLatest(path.join(process.cwd(), "data", "history"), (value, date) => value.asOfDate === date && Array.isArray(value.records));
  if (!history) return NextResponse.json({ error: { message: "Daily EOD 스냅샷을 찾을 수 없습니다." } }, { status: 503 });
  const company = await loadLatest(path.join(process.cwd(), "data", "analysis", "company"), (value, date) => value.requestedDate === date && Array.isArray(value.records));
  const rows = createScreeningRows(history, company);
  const screened = screenStocks(rows, { model, minScore, maxScore, maxRank, companyGrade, sort: request.nextUrl.searchParams.get("sort"), direction: request.nextUrl.searchParams.get("direction") });
  const modelCoverage = rows.filter((row: { models: Record<string, { score: number | null; rank: number | null }> }) => row.models[model].score !== null && row.models[model].rank !== null).length;
  const companyCoverage = rows.filter((row: { company: { available: boolean } }) => row.company.available).length;
  return NextResponse.json({
    referenceDate: history.asOfDate,
    companyReferenceDate: company?.requestedDate ?? null,
    selectedModel: model,
    totalUniverse: rows.length,
    modelCoverage,
    companyCoverage,
    quarantinedCount: (history.universeSummary as { quarantinedUniverse?: { count?: number } } | undefined)?.quarantinedUniverse?.count ?? null,
    resultCount: screened.results.length,
    exclusions: screened.exclusions,
    results: screened.results,
    supportedFilters: { models: Object.keys(SCREENING_MODELS), companyGrades: allowedGrades },
  }, { headers: { "Cache-Control": "no-store" } });
}
