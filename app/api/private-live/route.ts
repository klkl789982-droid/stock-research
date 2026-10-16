import { withAdminAccess } from "@/lib/admin-access";
import { localLiveExecutorResponse } from "@/lib/local-live-executor.mjs";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = withAdminAccess((request: Request) => localLiveExecutorResponse(request));
