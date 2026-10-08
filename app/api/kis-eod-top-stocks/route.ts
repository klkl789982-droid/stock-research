import { NextRequest, NextResponse } from "next/server";
import { latestOfficialKisFallbackDate, readKisEodTopStocks } from "@/lib/kis-eod-publication.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const model = (request.nextUrl.searchParams.get("model") ?? "B").toUpperCase();
  const version = request.nextUrl.searchParams.get("version");
  const limit = Number(request.nextUrl.searchParams.get("limit") ?? "5");
  if (!["A", "B", "C", "D"].includes(model) || (version !== null && (model !== "A" || !["A-v1", "A-v2"].includes(version))) || !Number.isInteger(limit) || limit < 1 || limit > 50) return NextResponse.json({ error: { code: "INVALID_QUERY", message: "모델·버전·조회 개수를 확인해 주세요." } }, { status: 400, headers: { "Cache-Control": "no-store" } });
  try {
    const root = process.cwd();
    const officialDate = await latestOfficialKisFallbackDate(root);
    const result = await readKisEodTopStocks({ root, enabled: process.env.KIS_EOD_PUBLISH_ENABLED === "true", model, version, limit, officialDate });
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ available: false, dataMode: "kisProvisionalEod", status: "KIS_EOD_FAILED", reason: "PUBLICATION_READ_FAILED" }, { headers: { "Cache-Control": "no-store" } });
  }
}
