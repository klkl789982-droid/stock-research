import { authConfig, createAdminAuth, loginIdentity, readCookie, sameOriginMutation, sessionCookie, AUTH_HEADERS, authError } from "@/lib/admin-auth.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  try {
    const config = authConfig();
    if (!sameOriginMutation(request, config)) return authError(403, "CSRF_REJECTED");
    if (request.headers.get("content-type")?.split(";")[0] !== "application/json") return authError(415, "INVALID_LOGIN_REQUEST");
    if (Number(request.headers.get("content-length") ?? 0) > 4096) return authError(413, "INVALID_LOGIN_REQUEST");
    // Stream bound also covers requests with no Content-Length.
    const reader = request.body?.getReader();
    if (!reader) return authError(400, "INVALID_LOGIN_REQUEST");
    const chunks: Uint8Array[] = []; let size = 0;
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > 4096) { await reader.cancel(); return authError(413, "INVALID_LOGIN_REQUEST"); }
      chunks.push(value);
    }
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return authError(400, "INVALID_LOGIN_REQUEST"); }
    const result = await createAdminAuth(config).login(body?.username, body?.password, loginIdentity(request), readCookie(request));
    if (result.status !== 200) return Response.json({ error: { code: result.code, message: result.status === 429 ? "로그인 시도가 많습니다. 15분 후 다시 시도해 주세요." : "아이디 또는 비밀번호를 확인해 주세요." } }, { status: result.status, headers: { ...AUTH_HEADERS, ...(result.status === 429 ? { "Retry-After": "900" } : {}) } });
    return Response.json({ authenticated: true, expiresAt: result.expiresAt }, { headers: { ...AUTH_HEADERS, "Set-Cookie": sessionCookie(result.token) } });
  } catch { return authError(503, "AUTH_UNAVAILABLE"); }
}
