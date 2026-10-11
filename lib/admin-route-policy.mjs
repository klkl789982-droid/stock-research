const ASSETS = new Set(["/favicon.ico", "/tb-mark-v3.png", "/tb-material-bg-v2.png"]);
export function isPublicResource(url) {
  const pathname = url.pathname;
  if (pathname === "/login" || ["/api/auth/login", "/api/auth/logout", "/api/auth/session"].includes(pathname) || ASSETS.has(pathname)) return true;
  if (pathname.startsWith("/_next/static/") && !pathname.endsWith(".map")) return true;
  // Do not exempt the optimizer broadly: its URL could point at protected data.
  if (pathname === "/_next/image") return ASSETS.has(url.searchParams.get("url"));
  return false;
}
