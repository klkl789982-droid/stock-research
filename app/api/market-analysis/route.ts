import "server-only";
import { promises as fs } from "node:fs";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code")?.trim() ?? "";
  if (!/^\d{6}$/.test(code)) return NextResponse.json({ error: { code: "INVALID_STOCK_CODE", message: "6자리 종목코드가 필요합니다." } }, { status: 400 });
  const directory = path.join(process.cwd(), "data", "analysis", "market");
  let filenames: string[];
  try { filenames = (await fs.readdir(directory)).filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name)).sort().reverse(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return NextResponse.json({ error: { code: "MARKET_ANALYSIS_SNAPSHOT_NOT_FOUND", message: "저장된 시장분석 스냅샷이 없습니다." } }, { status: 503 });
    return NextResponse.json({ error: { code: "MARKET_ANALYSIS_READ_FAILED", message: "시장분석 저장 결과를 읽지 못했습니다." } }, { status: 500 });
  }
  if (filenames.length === 0) return NextResponse.json({ error: { code: "MARKET_ANALYSIS_SNAPSHOT_NOT_FOUND", message: "저장된 시장분석 스냅샷이 없습니다." } }, { status: 503 });
  try {
    const snapshot = JSON.parse(await fs.readFile(path.join(directory, filenames[0]), "utf8"));
    const record = snapshot.records?.find((item: { code?: string }) => item.code === code);
    if (!record) return NextResponse.json({ error: { code: "MARKET_ANALYSIS_RECORD_NOT_FOUND", message: "최신 저장 결과에 해당 종목이 없습니다." } }, { status: 404 });
    return NextResponse.json({ requestedDate: snapshot.requestedDate, generatedAt: snapshot.generatedAt, calculatorVersion: snapshot.calculatorVersion, formulaHash: snapshot.formulaHash, sourceManifest: snapshot.sourceManifest, dataQuality: snapshot.dataQuality, record }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: { code: "MARKET_ANALYSIS_SNAPSHOT_INVALID", message: "최신 시장분석 스냅샷이 손상되었습니다." } }, { status: 500 });
  }
}
