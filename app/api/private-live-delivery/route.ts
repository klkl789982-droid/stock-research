import { withAdminAccess } from "@/lib/admin-access";
import { privateLiveDeliveryResponse } from "@/lib/private-live-delivery.mjs";

export const runtime = "nodejs";

// No machine-auth exemption, write endpoint or local executor port exposure.
async function handleGet(request: Request) {
  return privateLiveDeliveryResponse(request);
}

export const GET = withAdminAccess(handleGet);
