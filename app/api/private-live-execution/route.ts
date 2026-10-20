import { withAdminAccess } from "@/lib/admin-access";
import { privateLiveExecutionResponse } from "@/lib/private-live-execution-status.mjs";

export const runtime = "nodejs";
// Existing administrator boundary; no automation exemption or write endpoint.
export const GET = withAdminAccess(async (request: Request) => privateLiveExecutionResponse(request));
