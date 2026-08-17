import "server-only";
import { promises as fs } from "node:fs";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";

const normalizeCode = (value: string | null) => { if (!value) return null; const code = value.length === 7 && value.startsWith("A") ? value.slice(1) : value.toUpperCase(); return /^[0-9A-Z]{6}$/.test(code) ? code : null; };
export async function GET(request: NextRequest) {
  const code = normalizeCode(request.nextUrl.searchParams.get("code")); const date = request.nextUrl.searchParams.get("date");
  if (!code) return NextResponse.json({ status: "failed", error: { code: "INVALID_STOCK_CODE", message: "유효한 6자리 종목코드가 필요합니다." } }, { status: 400 });
  if (date != null && !/^\d{4}-\d{2}-\d{2}$/.test(date)) return NextResponse.json({ status: "failed", error: { code: "INVALID_DATE", message: "date는 YYYY-MM-DD 형식이어야 합니다." } }, { status: 400 });
  const directory = path.join(process.cwd(), "data", "analysis", "company");
  try {
    const names = (await fs.readdir(directory)).filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name)).sort().reverse();
    const filename = date ? `${date}.json` : names[0];
    if (!filename || !names.includes(filename)) return NextResponse.json({ status: "missing", error: { code: "COMPANY_ANALYSIS_NOT_FOUND", message: "저장된 기업분석 결과가 없습니다." } }, { status: 404 });
    const snapshot = JSON.parse(await fs.readFile(path.join(directory, filename), "utf8"));
    const record = snapshot.records?.find((item: { code?: string }) => item.code === code);
    if (!record) return NextResponse.json({ status: "missing", error: { code: "COMPANY_ANALYSIS_RECORD_NOT_FOUND", message: "해당 종목의 저장된 기업분석 결과가 없습니다." } }, { status: 404 });
    const status = !record.eligible ? "ineligible" : record.qualityStatus === "CERTIFIED" ? "available" : String(record.qualityStatus).toLowerCase() === "stale" ? "stale" : "provisional";
    return NextResponse.json({ status, source: record.source, analysisAsOfDate: record.analysisAsOfDate, financialPeriodEnd: record.financialPeriodEnd, filingDate: record.filingDate, generatedAt: snapshot.generatedAt, priceBasis: record.priceBasis, priceAsOfDate: record.priceAsOfDate, qualityStatus: record.qualityStatus, calculatorVersion: snapshot.calculatorVersion, formulaHash: snapshot.formulaHash, record }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return NextResponse.json({ status: "missing", error: { code: "COMPANY_ANALYSIS_NOT_FOUND", message: "저장된 기업분석 결과가 없습니다." } }, { status: 404 });
    return NextResponse.json({ status: "failed", error: { code: "COMPANY_ANALYSIS_READ_FAILED", message: "기업분석 저장 결과를 읽지 못했습니다." } }, { status: 500 });
  }
}
