import { NextRequest, NextResponse } from "next/server";
import { AUTH_HEADERS, authenticateRequest, authError, isAutomationRequest } from "./lib/admin-auth.mjs";
import { isPublicResource } from "./lib/admin-route-policy.mjs";

export async function proxy(request: NextRequest) {
  let response: Response;
  if (isPublicResource(request.nextUrl) || isAutomationRequest(request)) {
    response = NextResponse.next();
  } else {
    const result = await authenticateRequest(request);
    if (result.session) response = NextResponse.next();
    else if (request.nextUrl.pathname.startsWith("/api/")) response = authError(result.unavailable ? 503 : 401, result.unavailable ? "AUTH_UNAVAILABLE" : "AUTH_REQUIRED");
    else response = NextResponse.redirect(new URL("/login", request.url));
  }
  for (const [name, value] of Object.entries(AUTH_HEADERS)) response.headers.set(name, value);
  return response;
}

// Covers pages, RSC, APIs and public files; only explicit safe resources pass.
export const config = { matcher: "/:path*" };
