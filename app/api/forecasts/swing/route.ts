import { NextRequest, NextResponse } from "next/server";
import { withAdminAccess } from "@/lib/admin-access";
import { loadForecastSwingDashboard, forecastSwingRootForRequest } from "@/lib/forecast-swing-store.mjs";

async function handleGet(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  if (code !== null && !/^[0-9A-Z]{6}$/u.test(code)) return NextResponse.json({ error: { code: "INVALID_STOCK_CODE", message: "6자리 종목코드를 입력해 주세요." } }, { status: 400, headers: { "Cache-Control": "no-store" } });
  try {
    const result = await loadForecastSwingDashboard({ code, root: await forecastSwingRootForRequest(request) });
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: { code: "FORECAST_PREPARATION_UNAVAILABLE", message: "예측 준비 자료를 확인할 수 없습니다. 잠시 후 다시 시도해 주세요." } }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
export const GET = withAdminAccess(handleGet);
