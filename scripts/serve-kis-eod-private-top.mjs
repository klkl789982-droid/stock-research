import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { kisEodPrivateStoreFromEnv } from "../lib/kis-eod-private-store.mjs";
import { queryPrivateModelTop } from "../lib/kis-eod-private-models.mjs";
import { createLocalPrivateModelStore } from "../lib/kis-eod-private-local-store.mjs";

// Deliberately NOT a Next/Vercel route. Loopback binding, Host and Origin gates
// prevent remote access and browser cross-site/DNS-rebinding reads. No CORS.
export function createPrivateTopServer({ store, query = queryPrivateModelTop } = {}) {
  return http.createServer(async (request, response) => {
    response.setHeader("Cache-Control", "no-store"); response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.setHeader("X-Content-Type-Options", "nosniff"); response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    const address = request.socket.remoteAddress, port = request.socket.localPort;
    const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(address) || !hosts.includes(request.headers.host)
      || (request.headers.origin && !hosts.map((host) => `http://${host}`).includes(request.headers.origin))
      || (request.headers["sec-fetch-site"] && !["same-origin", "none"].includes(request.headers["sec-fetch-site"]))) {
      response.writeHead(403); response.end('{"status":"PRIVATE_ACCESS_DENIED"}'); return;
    }
    const url = new URL(request.url, `http://${request.headers.host}`);
    if (request.method !== "GET" || url.pathname !== "/api/kis-eod-private-top-stocks") { response.writeHead(404); response.end('{"status":"NOT_FOUND"}'); return; }
    const permitted = new Set(["model", "version", "limit", "mode"]);
    if ([...url.searchParams.keys()].some((key) => !permitted.has(key) || url.searchParams.getAll(key).length !== 1)) { response.writeHead(400); response.end('{"status":"INVALID_QUERY"}'); return; }
    try {
      const result = await query(store, { model: url.searchParams.get("model") ?? "B", version: url.searchParams.get("version"), limit: Number(url.searchParams.get("limit") ?? 5), mode: url.searchParams.get("mode") ?? "live" });
      response.end(JSON.stringify(result));
    } catch (error) {
      response.writeHead(error?.code === "PRIVATE_MODEL_QUERY_INVALID" ? 400 : 503);
      response.end('{"status":"PRIVATE_DATA_UNAVAILABLE"}');
    }
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== "--local")) throw new Error("PRIVATE_TOP_CLI_ARGUMENTS_INVALID");
  const store = args[0] === "--local" ? createLocalPrivateModelStore() : kisEodPrivateStoreFromEnv(); await store.verifyPrivateRepository();
  createPrivateTopServer({ store }).listen(3101, "127.0.0.1", () => console.log("Private TOP: http://127.0.0.1:3101/api/kis-eod-private-top-stocks (no public binding)"));
}
