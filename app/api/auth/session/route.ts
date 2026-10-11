import { authenticateRequest, AUTH_HEADERS, authError } from "@/lib/admin-auth.mjs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const result = await authenticateRequest(request);
  if (result.unavailable) return authError(503, "AUTH_UNAVAILABLE");
  if (!result.session) return authError();
  return Response.json({ authenticated: true, role: "admin", expiresAt: result.session.expiresAt }, { headers: AUTH_HEADERS });
}
