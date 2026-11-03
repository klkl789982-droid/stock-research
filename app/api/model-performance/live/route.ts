import { withAdminAccess } from "@/lib/admin-access";
import { loadPublishedLivePerformance } from "@/lib/published-live-performance.mjs";

export const GET = withAdminAccess(async () => {
  const headers = { "Cache-Control": "private, no-store" };
  try { return Response.json(await loadPublishedLivePerformance(), { headers }); }
  catch { return Response.json({ error: "LIVE_PERFORMANCE_UNAVAILABLE" }, { status: 503, headers }); }
});
