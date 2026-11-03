import { withAdminAccess } from "@/lib/admin-access";
import { kisRequest } from "@/lib/kis-token-manager";
import { loadMarketOverview } from "@/lib/market-overview.mjs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = withAdminAccess(async () => {
  const headers = { "Cache-Control": "private, no-store" };
  try {
    return Response.json(await loadMarketOverview({ requestIndex: kisRequest }), { headers });
  } catch {
    return Response.json({ message: "시장 현황을 불러오지 못했습니다." }, { status: 503, headers });
  }
});
