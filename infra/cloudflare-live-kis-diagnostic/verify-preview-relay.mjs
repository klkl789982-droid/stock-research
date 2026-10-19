import fs from "node:fs/promises";
import path from "node:path";
import { parseEnv } from "node:util";
import { pathToFileURL } from "node:url";
import { deliveryFixtureHash } from "../../lib/private-live-delivery-fixture.mjs";
export const VERIFIED_PREVIEW_ORIGIN = "https://stock-research-git-integrate-9e3966-klkl789982-droids-projects.vercel.app";

export async function verifyPreviewRelay({ origin, username, password, fixtureId, protectionToken = null, fetchImpl = fetch }) {
  const site = new URL(origin);
  if (site.protocol !== "https:" || site.origin !== origin || origin !== VERIFIED_PREVIEW_ORIGIN) throw new Error("PREVIEW_ORIGIN_REJECTED");
  const request = async (route, init = {}) => {
    try { return await fetchImpl(`${origin}${route}`, { ...init, headers: { ...init.headers,
      ...(protectionToken ? { "x-vercel-trusted-oidc-idp-token": protectionToken } : {}) }, redirect: "manual", cache: "no-store", signal: AbortSignal.timeout(20000) }); }
    catch { throw new Error("PREVIEW_TRANSPORT_UNAVAILABLE"); }
  };
  const blocked = await request("/api/private-live-delivery");
  if (!blocked.headers.get("content-type")?.includes("application/json")) throw new Error([301, 302, 303, 307, 308, 401, 403].includes(blocked.status) ? "PREVIEW_DEPLOYMENT_PROTECTION" : "PREVIEW_RESPONSE_INVALID");
  if (blocked.status !== 401 || (await blocked.json()).error?.code !== "AUTH_REQUIRED") throw new Error("PREVIEW_UNAUTHENTICATED_BOUNDARY_UNVERIFIED");
  const login = await request("/api/auth/login", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ username, password }) });
  if (login.status !== 200) throw new Error(login.status === 503 ? "PREVIEW_AUTH_UNAVAILABLE" : "PREVIEW_LOGIN_FAILED");
  const cookie = login.headers.get("set-cookie")?.split(";")[0];
  if (!cookie || !cookie.startsWith("__Host-tb-session=")) throw new Error("PREVIEW_SESSION_UNVERIFIED");
  try {
    const response = await request("/api/private-live-delivery", { headers: { Cookie: cookie } }), body = await response.json();
    const expected = deliveryFixtureHash(fixtureId);
    if (response.status !== 200 || body.status !== "SYNTHETIC_FIXTURE_VERIFIED" || body.deliveryHash !== expected
      || body.delivery?.models?.length !== 4 || body.delivery.models.reduce((n, m) => n + m.records.length, 0) !== 20) throw new Error("PREVIEW_RELAY_READBACK_UNVERIFIED");
    return { status: "AUTHENTICATED_PREVIEW_API_VERIFIED", fixtureHash: expected, models: 4, topRows: 20, source: "SYNTHETIC_FIXTURE",
      unauthenticatedStatus: blocked.status, browserRenderingVerified: false, productionChanged: false };
  } finally {
    const logout = await request("/api/auth/logout", { method: "POST", headers: { Origin: origin, Cookie: cookie } });
    const after = await request("/api/private-live-delivery", { headers: { Cookie: cookie } });
    if (logout.status !== 200 || after.status !== 401 || (await after.json()).error?.code !== "AUTH_REQUIRED") throw new Error("PREVIEW_LOGOUT_BOUNDARY_UNVERIFIED");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const root = path.join(process.env.LOCALAPPDATA, "TightBudget", "preview-relay-20261017");
    const env = parseEnv(await fs.readFile(path.join(root, "preview-import.env"), "utf8"));
    const credentials = await fs.readFile(path.join(root, "preview-login.private.txt"), "utf8");
    const username = /^Username:\s*(.+)$/mu.exec(credentials)?.[1]?.trim(), password = /^Password:\s*(.+)$/mu.exec(credentials)?.[1]?.trim();
    if (!username || !password) throw new Error("PREVIEW_TEST_CREDENTIAL_UNAVAILABLE");
    console.log(JSON.stringify(await verifyPreviewRelay({ origin: env.TB_AUTH_ORIGIN, fixtureId: env.PRIVATE_LIVE_DELIVERY_FIXTURE_ID, username, password,
      protectionToken: process.env.VERCEL_OIDC_TOKEN ?? null })));
  } catch (e) {
    console.error(JSON.stringify({ status: "BLOCKED", reason: /^PREVIEW_[A-Z_]+$/u.test(e?.message ?? "") ? e.message : "PREVIEW_VERIFICATION_FAILED" }));
    process.exitCode = 1;
  }
}
