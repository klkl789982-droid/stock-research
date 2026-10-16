import { withAdminAccess } from "@/lib/admin-access";
import { privateLiveDeliveryResponse } from "@/lib/private-live-delivery.mjs";
import { authConfig, sameOriginMutation, authError } from "@/lib/admin-auth.mjs";
import { verifySiteRelayReader } from "@/lib/private-live-reader-probe.mjs";

export const runtime = "nodejs";

// No machine-auth exemption or local executor port exposure.
async function handleGet(request: Request) {
  return privateLiveDeliveryResponse(request);
}

export const GET = withAdminAccess(handleGet);

// Explicit administrator action in an isolated Preview, never a GET side effect.
// Attempts only a new synthetic marker to prove that the reader cannot write.
async function handlePost(request: Request) {
  if (process.env.VERCEL_ENV !== "preview" || process.env.PRIVATE_LIVE_DELIVERY_READ_ENABLED !== "true"
    || !process.env.PRIVATE_LIVE_DELIVERY_FIXTURE_ID) return Response.json({ error: "NOT_FOUND" }, { status: 404 });
  try {
    if (!sameOriginMutation(request, authConfig())) return authError(403, "CSRF_REJECTED");
    if (new URL(request.url).search || request.headers.get("content-type") !== "application/json"
      || await request.text() !== '{"action":"verify-read-only"}') return Response.json({ error: "INVALID_PROBE" }, { status: 400 });
    const result = await verifySiteRelayReader();
    return Response.json(result, { status: result.writeDenied ? 200 : 409 });
  } catch { return Response.json({ error: "READER_VERIFICATION_FAILED" }, { status: 503 }); }
}
export const POST = withAdminAccess(handlePost);
