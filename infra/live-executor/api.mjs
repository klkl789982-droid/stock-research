import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { hashIntradayModelTop } from "../../lib/intraday-model-top-official-signal.mjs";
export async function startPrivateApi({ store, mode = "shadow", token, port = 0 }) {
  if (!["live", "shadow"].includes(mode) || typeof token !== "string" || token.length < 32) throw new Error("EXECUTOR_API_AUTH_REQUIRED");
  const expected = Buffer.from(`Bearer ${token}`);
  const server = http.createServer(async (request, response) => {
    const send = (code, value) => { response.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" }); response.end(JSON.stringify(value)); };
    const given = Buffer.from(request.headers.authorization ?? "");
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return send(401, { error: "UNAUTHORIZED" });
    if (!/^127\.0\.0\.1:\d+$/u.test(request.headers.host ?? "") || request.headers.origin || request.headers["sec-fetch-site"] === "cross-site") return send(403, { error: "ORIGIN_REJECTED" });
    if (request.method !== "GET") return send(405, { error: "METHOD_NOT_ALLOWED" });
    try {
      const url = new URL(request.url, "http://127.0.0.1");
      if ([...url.searchParams.keys()].length !== new Set(url.searchParams.keys()).size) return send(400, { error: "INVALID_QUERY" });
      if (url.pathname !== "/top" || [...url.searchParams.keys()].some((key) => !["model", "limit"].includes(key))) return send(404, { error: "NOT_FOUND" });
      const model = url.searchParams.get("model") ?? "B", limit = Number(url.searchParams.get("limit") ?? 5);
      if (!["A", "B", "C", "D"].includes(model) || ![5, 10, 20].includes(limit)) return send(400, { error: "INVALID_QUERY" });
      const latest = await store.read(`${mode}/latest.json`);
      if (!latest) return send(503, { status: "NO_OBSERVATION", mode });
      if (!latest.artifactKey?.startsWith(`${mode}/`) || !latest.artifactKey.endsWith("/result.json")) throw new Error("POINTER_INVALID");
      const artifact = await store.read(latest.artifactKey);
      const { contentHash, ...base } = artifact ?? {};
      if (!artifact || contentHash !== latest.contentHash || contentHash !== hashIntradayModelTop(base) || artifact.status !== "READY" || artifact.observationType !== (mode === "live" ? "LIVE_OBSERVATION" : "CURRENT_TIME_SHADOW")) throw new Error("ARTIFACT_INVALID");
      const version = `${model}-v1`;
      const records = artifact.records.filter((r) => Number.isFinite(r.ranks?.[version])).sort((a, b) => a.ranks[version] - b.ranks[version]).slice(0, limit).map((r) => ({ ticker: r.ticker, companyName: r.companyName, score: r.scores[version], rank: r.ranks[version] }));
      return send(200, { mode, signalDate: artifact.signalDate, seedReferenceDate: artifact.seedReferenceDate, observationType: artifact.observationType, contentHash, collectionStartedAt: artifact.collectionStartedAt, collectionCompletedAt: artifact.collectionCompletedAt, collection: artifact.collection, modelVersion: version, records });
    } catch { return send(503, { error: "STORAGE_VERIFICATION_FAILED" }); }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) };
}
