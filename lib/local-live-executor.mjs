import fs from "node:fs/promises";
import path from "node:path";
import { CURRENT_LIVE_PROFILE } from "./intraday-model-top-time-policy.mjs";

const headers = { "Cache-Control": "private, no-store, max-age=0", "X-Content-Type-Options": "nosniff" };
const response = (status, body) => Response.json(body, { status, headers });
const fail = () => { throw new Error("LOCAL_EXECUTOR_UNAVAILABLE"); };
const loopback = new Set(["127.0.0.1", "localhost", "[::1]"]);
const statuses = new Set(["READY", "STORED", "PREPARED", "COLLECTING", "PARTIAL", "FAILED", "MISSED", "MARKET_CLOSED", "NEW", "WAITING", "NO_OBSERVATION", "UNAVAILABLE"]);
const stamp = (value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/u.test(value) && Number.isFinite(Date.parse(value)) ? value : null;
const date = (value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value ? value : null;
const count = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;
const expectedType = (mode) => mode === "live" ? "LIVE_OBSERVATION" : "CURRENT_TIME_SHADOW";
const inside = (file, directory) => {
  const a = process.platform === "win32" ? file.toLowerCase() : file;
  const b = process.platform === "win32" ? directory.toLowerCase() : directory;
  return a === b || a.startsWith(`${b}${path.sep}`);
};

export function isLocalRequest(request) {
  const url = new URL(request.url), host = request.headers.get("host");
  // Next may normalize its internal URL to localhost while preserving an
  // original 127.0.0.1 Host. Accept only loopback aliases on the exact same port.
  const sameLocalOrigin = value => {
    try {
      const candidate = new URL(value);
      return candidate.protocol === "http:" && loopback.has(candidate.hostname) && candidate.port === url.port
        && !candidate.username && !candidate.password && candidate.pathname === "/" && !candidate.search && !candidate.hash;
    } catch { return false; }
  };
  if (url.protocol !== "http:" || !loopback.has(url.hostname) || url.username || url.password || (host && !sameLocalOrigin(`http://${host}`))) return false;
  const origin = request.headers.get("origin"), forwardedHost = request.headers.get("x-forwarded-host");
  if ((origin && !sameLocalOrigin(origin)) || (forwardedHost && !sameLocalOrigin(`http://${forwardedHost}`))
    || ![null, "same-origin", "none"].includes(request.headers.get("sec-fetch-site"))) return false;
  const forwardedFor = request.headers.get("x-forwarded-for");
  return !forwardedFor || forwardedFor.split(",").every((entry) => ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(entry.trim()));
}

async function privateReadToken(filename, repositoryRoot) {
  if (typeof filename !== "string" || !path.isAbsolute(filename)) fail();
  const resolved = path.resolve(filename);
  if (inside(resolved, path.resolve(repositoryRoot)) || resolved.split(path.sep).some((part) => ["public", ".git"].includes(part.toLowerCase()))) fail();
  let cursor = path.parse(resolved).root;
  for (const part of resolved.slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    if ((await fs.lstat(cursor)).isSymbolicLink()) fail();
  }
  const stat = await fs.stat(resolved);
  if (!stat.isFile() || stat.size > 4096 || (process.platform !== "win32" && (stat.mode & 0o077))) fail();
  const token = (await fs.readFile(resolved, "utf8")).trim();
  if (!/^[A-Za-z0-9_-]{32,256}$/u.test(token)) fail();
  return token;
}

async function readJson(responseValue) {
  if (!responseValue.body) fail();
  const reader = responseValue.body.getReader(), chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 131072) fail();
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { fail(); }
}

function statusDto(value, mode) {
  if (!value || value.mode !== mode) fail();
  if (value.observationType != null && value.observationType !== expectedType(mode)) fail();
  return { status: statuses.has(value.status) ? value.status : "UNAVAILABLE", signalDate: date(value.signalDate),
    observationType: value.observationType ?? null,
    collectionStartedAt: stamp(value.collectionStartedAt), collectionCompletedAt: stamp(value.collectionCompletedAt),
    storedAt: stamp(value.storedAt), lastSuccessAt: stamp(value.lastSuccessAt), heartbeatAt: stamp(value.heartbeatAt), queryVerifiedAt: stamp(value.queryVerifiedAt),
    reason: /^[A-Z][A-Z0-9_]{1,95}$/u.test(value.reason ?? "") ? value.reason : null,
    collection: { successful: count(value.collection?.successful), failed: count(value.collection?.failed), ineligible: count(value.collection?.ineligible) } };
}

function topDto(value, mode, model) {
  if (mode === "live") {
    const start = Date.parse(`${value?.signalDate}T${CURRENT_LIVE_PROFILE.signalTime}+09:00`);
    const end = Date.parse(`${value?.signalDate}T${CURRENT_LIVE_PROFILE.windowEnd}+09:00`);
    if (value?.schemaVersion !== CURRENT_LIVE_PROFILE.schemaVersion || value.observationPolicyId !== CURRENT_LIVE_PROFILE.policyId
      || value.officialSignalTime !== CURRENT_LIVE_PROFILE.signalTime || !Number.isFinite(start)
      || Date.parse(value.collectionStartedAt) < start || Date.parse(value.collectionCompletedAt) > end) fail();
  }
  if (value?.mode !== mode || value.observationType !== expectedType(mode) || value.modelVersion !== `${model}-v1`
    || !date(value.signalDate) || !date(value.seedReferenceDate) || value.seedReferenceDate >= value.signalDate
    || !/^[a-f0-9]{64}$/u.test(value.contentHash ?? "") || !stamp(value.collectionStartedAt) || !stamp(value.collectionCompletedAt)
    || Date.parse(value.collectionStartedAt) > Date.parse(value.collectionCompletedAt)
    || !Array.isArray(value.records) || value.records.length > 5) fail();
  const records = value.records.map((record, index) => {
    if (!/^\d{6}$/u.test(record?.ticker ?? "") || typeof record.companyName !== "string" || !record.companyName.trim() || record.companyName.length > 100
      || !Number.isFinite(record.score) || record.score < 0 || record.score > 100 || record.rank !== index + 1) fail();
    return { ticker: record.ticker, companyName: record.companyName, score: record.score, rank: record.rank };
  });
  if (new Set(records.map((record) => record.ticker)).size !== records.length) fail();
  return { model, modelVersion: value.modelVersion, signalDate: value.signalDate, seedReferenceDate: value.seedReferenceDate,
    officialSignalTime: mode === "live" ? CURRENT_LIVE_PROFILE.signalTime : null, freshnessStatus: "NOT_EVALUATED",
    contentHash: value.contentHash, collectionStartedAt: value.collectionStartedAt, collectionCompletedAt: value.collectionCompletedAt, records };
}

// Called only behind withAdminAccess. This bridge is never usable in Vercel and
// never grants automation tokens access to private models or local credentials.
export async function localLiveExecutorResponse(request, { env = process.env, fetchImpl = fetch, repositoryRoot = process.cwd() } = {}) {
  if (env.LIVE_EXECUTOR_LOCAL_READ_ENABLED !== "true" || Object.hasOwn(env, "VERCEL")) return response(404, { error: "NOT_FOUND" });
  if (!isLocalRequest(request)) return response(403, { error: "LOCAL_ACCESS_REQUIRED" });
  if (request.method !== "GET" || new URL(request.url).search) return response(400, { error: "INVALID_QUERY" });
  const mode = env.LIVE_EXECUTOR_LOCAL_MODE;
  if (!["live", "shadow"].includes(mode)) return response(503, { error: "LOCAL_EXECUTOR_NOT_CONFIGURED" });
  const unavailable = () => response(200, { source: "localPrivateExecutor", mode, status: "UNAVAILABLE", reason: "LOCAL_EXECUTOR_UNAVAILABLE", models: [] });
  try {
    const origin = new URL(env.LIVE_EXECUTOR_LOCAL_ORIGIN ?? "http://127.0.0.1:4318");
    if (origin.protocol !== "http:" || origin.hostname !== "127.0.0.1" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash
      || !/^\d{4,5}$/u.test(origin.port) || Number(origin.port) < 1024 || Number(origin.port) > 65535) fail();
    const token = await privateReadToken(env.LIVE_EXECUTOR_LOCAL_TOKEN_FILE, repositoryRoot);
    const requestUpstream = async (suffix, optional = false) => {
      const value = await fetchImpl(`${origin.origin}${suffix}`, { method: "GET", headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        cache: "no-store", redirect: "error", signal: AbortSignal.timeout(3000) });
      if (!value.ok) {
        await value.body?.cancel().catch(() => {});
        if (optional && value.status === 503) return null;
        fail();
      }
      return readJson(value);
    };
    const [rawStatus, ...rawModels] = await Promise.all([requestUpstream("/status"), ...["A", "B", "C", "D"].map((model) => requestUpstream(`/top?model=${model}&limit=5`, true))]);
    const status = statusDto(rawStatus, mode);
    if (rawModels.some((value) => value === null)) return response(200, { source: "localPrivateExecutor", mode, ...status, models: [], modelStatus: "UNAVAILABLE" });
    const models = rawModels.map((value, index) => topDto(value, mode, ["A", "B", "C", "D"][index]));
    if (models.some((value) => value.contentHash !== models[0].contentHash || value.signalDate !== models[0].signalDate
      || value.seedReferenceDate !== models[0].seedReferenceDate || value.collectionStartedAt !== models[0].collectionStartedAt || value.collectionCompletedAt !== models[0].collectionCompletedAt)) fail();
    return response(200, { source: "localPrivateExecutor", mode, ...status, models, modelStatus: "AVAILABLE" });
  } catch { return unavailable(); }
}
