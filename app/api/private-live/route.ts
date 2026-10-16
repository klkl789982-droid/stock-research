import { withAdminAccess } from "@/lib/admin-access";
import { localLiveExecutorResponse } from "@/lib/local-live-executor.mjs";

export const runtime = "nodejs";

// Existing administrator session/Redis validation remains the only access path.
// This endpoint is not part of the automation-read allowlist.
async function handleGet(request: Request) {
  return localLiveExecutorResponse(request);
}

export const GET = withAdminAccess(handleGet);
