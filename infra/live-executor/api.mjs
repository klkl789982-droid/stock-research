import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { hashIntradayModelTop, isCurrentIntradayModelTopSignal } from "../../lib/intraday-model-top-official-signal.mjs";
import { clockKst } from "./engine.mjs";
const validTime = (value) => typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
const safeCount = (value) => Number.isInteger(value) && value >= 0 ? value : null;
const safeCode = (value) => /^[A-Z][A-Z0-9_]{0,95}$/u.test(value ?? "") ? value : null;
async function statusDto(store, mode) {
  const latest = await store.read(`${mode}/latest.json`);
  const heartbeat = mode === "live" ? await store.read("live/daemon-status.json") : null;
  const clock = mode === "live" ? await store.read("live/clock-status.json") : null;
  const verified = await store.read(`${mode}/query-verification.json`);
  const today = clockKst(Date.now()).date;
  const todayState = mode === "live" ? await store.read(`live/${today}/${today}/status.json`) : null;
  let saved = null;
  if (latest?.artifactKey?.startsWith(`${mode}/`) && latest.artifactKey.endsWith("/result.json")) {
    saved = await store.read(latest.artifactKey);
    const { contentHash, ...base } = saved ?? {};
    if (saved?.status !== "READY" || contentHash !== latest.contentHash || hashIntradayModelTop(base) !== contentHash) throw new Error("ARTIFACT_INVALID");
  }
  const clockFailure = clock?.date === today && clock.status === "FAILED";
  const archived = mode === "live" && saved && !isCurrentIntradayModelTopSignal(saved);
  if (archived) saved = null;
  return { mode, status: clockFailure ? "FAILED" : safeCode(todayState?.status ?? (saved?.signalDate === today ? "STORED" : "WAITING")),
    freshnessStatus: "NOT_EVALUATED", currentSessionVerified: false,
    officialSignalTime: saved?.officialSignalTime ?? null, observationPolicyId: saved?.observationPolicyId ?? null,
    observationType: saved?.observationType === (mode === "live" ? "LIVE_OBSERVATION" : "CURRENT_TIME_SHADOW") ? saved.observationType : null,
    signalDate: saved?.signalDate ?? null, operationalDate: today,
    collectionStartedAt: validTime(saved?.collectionStartedAt), collectionCompletedAt: validTime(saved?.collectionCompletedAt),
    storedAt: saved ? validTime(latest?.storedAt) : null, lastSuccessAt: saved ? validTime(latest?.storedAt) : null,
    reason: safeCode(clockFailure ? clock.reason : todayState?.reason), heartbeatAt: validTime(heartbeat?.heartbeatAt),
    queryVerifiedAt: saved && verified?.contentHash === latest?.contentHash ? validTime(verified?.verifiedAt) : null,
    collection: { successful: safeCount(saved?.collection?.successful), failed: safeCount(saved?.collection?.failed), ineligible: safeCount(saved?.collection?.ineligible) },
  };
}
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
      if (url.pathname === "/status" && !url.search) return send(200, await statusDto(store, mode));
      if (url.pathname !== "/top" || [...url.searchParams.keys()].some((key) => !["model", "limit"].includes(key))) return send(404, { error: "NOT_FOUND" });
      const model = url.searchParams.get("model") ?? "B", limit = Number(url.searchParams.get("limit") ?? 5);
      if (!["A", "B", "C", "D"].includes(model) || ![5, 10, 20].includes(limit)) return send(400, { error: "INVALID_QUERY" });
      const latest = await store.read(`${mode}/latest.json`);
      if (!latest) return send(503, { status: "NO_OBSERVATION", mode });
      if (!latest.artifactKey?.startsWith(`${mode}/`) || !latest.artifactKey.endsWith("/result.json")) throw new Error("POINTER_INVALID");
      const artifact = await store.read(latest.artifactKey);
      const { contentHash, ...base } = artifact ?? {};
      if (!artifact || contentHash !== latest.contentHash || contentHash !== hashIntradayModelTop(base) || artifact.status !== "READY" || artifact.observationType !== (mode === "live" ? "LIVE_OBSERVATION" : "CURRENT_TIME_SHADOW")) throw new Error("ARTIFACT_INVALID");
      if (mode === "live" && !isCurrentIntradayModelTopSignal(artifact)) return send(503, { status: "NO_CURRENT_POLICY_OBSERVATION", reason: "LEGACY_OR_INVALID_OBSERVATION", mode });
      if (latest.signalDate !== artifact.signalDate) throw new Error("POINTER_INVALID");
      const version = `${model}-v1`;
      const records = artifact.records.filter((r) => Number.isFinite(r.ranks?.[version])).sort((a, b) => a.ranks[version] - b.ranks[version]).slice(0, limit).map((r) => ({ ticker: r.ticker, companyName: r.companyName, score: r.scores[version], rank: r.ranks[version] }));
      return send(200, { mode, view: "STORED_OBSERVATION_READBACK", freshnessStatus: "NOT_EVALUATED", currentSessionVerified: false,
        schemaVersion: artifact.schemaVersion, signalVersion: artifact.signalVersion ?? null, observationPolicyId: artifact.observationPolicyId ?? null,
        officialSignalTime: artifact.officialSignalTime ?? null, signalDate: artifact.signalDate, seedReferenceDate: artifact.seedReferenceDate,
        observationType: artifact.observationType, contentHash, collectionStartedAt: artifact.collectionStartedAt, collectionCompletedAt: artifact.collectionCompletedAt, collection: artifact.collection, modelVersion: version, records });
    } catch { return send(503, { error: "STORAGE_VERIFICATION_FAILED" }); }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) };
}
