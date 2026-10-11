import { authConfig, createAdminAuth, readCookie, sameOriginMutation, sessionCookie, AUTH_HEADERS, authError } from "@/lib/admin-auth.mjs";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  try {
    const config = authConfig();
    if (!sameOriginMutation(request, config)) return authError(403, "CSRF_REJECTED");
    await createAdminAuth(config).logout(readCookie(request));
    return Response.json({ authenticated: false }, { headers: { ...AUTH_HEADERS, "Set-Cookie": sessionCookie("", process.env, 0) } });
  } catch { return authError(503, "AUTH_UNAVAILABLE"); } // No false logout success if revocation failed.
}
