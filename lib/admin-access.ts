import "server-only";
import { authenticateRequest, authError, AUTH_HEADERS, isAutomationRequest, automationPublicationDto } from "./admin-auth.mjs";

// Check again at the data boundary, independently of Proxy and incoming headers.
export async function requireAdminApi(request: Request) {
  const result = await authenticateRequest(request);
  return result.session ? null : authError(result.unavailable ? 503 : 401, result.unavailable ? "AUTH_UNAVAILABLE" : "AUTH_REQUIRED");
}

export function withAdminAccess<T extends Request>(handler: (request: T) => Promise<Response>) {
  return async function authenticatedHandler(request: T): Promise<Response> {
    const machine = isAutomationRequest(request);
    if (!machine) {
      const denied = await requireAdminApi(request);
      if (denied) return denied;
    }
    const response = await handler(request);
    if (machine) {
      // Deployment checker may read dates/status only, never rankings or prices.
      if (!response.ok) return Response.json({ error: { code: "PUBLICATION_CHECK_FAILED" } }, { status: response.status, headers: AUTH_HEADERS });
      return Response.json(automationPublicationDto(new URL(request.url).pathname, await response.json()), { headers: AUTH_HEADERS });
    }
    for (const [name, value] of Object.entries(AUTH_HEADERS)) response.headers.set(name, value);
    return response;
  };
}
