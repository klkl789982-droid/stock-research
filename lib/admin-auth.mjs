import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const derive = promisify(scrypt);
const COST = { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };
export const SESSION_SECONDS = 8 * 60 * 60;
export const LIMIT_SECONDS = 15 * 60;
export const COOKIE_NAME = (env = process.env) => env.NODE_ENV === "production" ? "__Host-tb-session" : "tb-session";
const digest = (text) => createHash("sha256").update(text).digest("hex");
const mac = (text, secret) => createHmac("sha256", secret).update(text).digest("base64url");
const equal = (left, right) => {
  const a = Buffer.from(String(left)), b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
};
const failure = () => Object.assign(new Error("AUTH_UNAVAILABLE"), { code: "AUTH_UNAVAILABLE" });
const validHash = (hash) => /^scrypt\$131072\$8\$1\$[a-f0-9]{32}\$[a-f0-9]{64}$/u.test(hash ?? "");
export const ADMIN_PASSWORD_POLICY_MESSAGE = "Use at least 8 characters including an English letter and a digit; special characters are optional (maximum 1024 bytes).";
export function isValidNewAdminPassword(password) {
  return typeof password === "string" && Array.from(password).length >= 8 && Buffer.byteLength(password) <= 1024 && /[A-Za-z]/u.test(password) && /[0-9]/u.test(password);
}

// Node's memory-hard scrypt, OWASP fallback parameters. No custom password crypto.
export async function hashAdminPassword(password) {
  if (!isValidNewAdminPassword(password)) throw new Error(ADMIN_PASSWORD_POLICY_MESSAGE);
  const salt = randomBytes(16).toString("hex");
  const key = await derive(password, salt, 32, COST);
  return `scrypt$131072$8$1$${salt}$${key.toString("hex")}`;
}

export function authConfig(env = process.env) {
  const username = env.TB_ADMIN_USERNAME, passwordHash = env.TB_ADMIN_PASSWORD_HASH, secret = env.TB_SESSION_SECRET;
  const origin = env.TB_AUTH_ORIGIN, redisUrl = env.TB_AUTH_REDIS_URL, redisToken = env.TB_AUTH_REDIS_TOKEN;
  if (!username || username.length > 100 || !validHash(passwordHash) || !/^[A-Za-z0-9_-]{43,128}$/u.test(secret ?? "") || !origin || !redisUrl || !redisToken) throw failure();
  try {
    const site = new URL(origin), store = new URL(redisUrl);
    const local = (url) => url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname) && env.NODE_ENV !== "production" && !env.VERCEL;
    if (site.origin !== origin || (site.protocol !== "https:" && !local(site)) || store.username || store.password || store.search || store.hash || (store.protocol !== "https:" && !local(store))) throw failure();
  } catch { throw failure(); }
  return { username, passwordHash, secret, origin, redisUrl, redisToken, binding: digest(`${username}\0${passwordHash}\0${secret}`).slice(0, 32) };
}

export function createRedisAuthStore(config, fetchImpl = fetch) {
  async function command(args) {
    try {
      const response = await fetchImpl(config.redisUrl, { method: "POST", headers: { Authorization: `Bearer ${config.redisToken}`, "Content-Type": "application/json" }, body: JSON.stringify(args), cache: "no-store", redirect: "error", signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw failure();
      const body = await response.json();
      if (body.error || !("result" in body)) throw failure();
      return body.result;
    } catch { throw failure(); } // Never propagate upstream URL/token/response details.
  }
  return {
    async create(key, record, seconds) { if (await command(["SET", key, JSON.stringify(record), "EX", seconds, "NX"]) !== "OK") throw failure(); },
    async read(key) { const value = await command(["GET", key]); if (value === null) return null; try { return JSON.parse(value); } catch { throw failure(); } },
    async remove(key) { await command(["DEL", key]); },
    async takeAttempt(identity) {
      // One atomic operation across serverless instances, before expensive hashing.
      const result = await command(["EVAL", "local a=redis.call('INCR',KEYS[1]); if a==1 then redis.call('EXPIRE',KEYS[1],ARGV[1]) end; local b=redis.call('INCR',KEYS[2]); if b==1 then redis.call('EXPIRE',KEYS[2],ARGV[1]) end; return {a,b}", 2, `tb:auth:attempt:${identity}`, "tb:auth:attempt:global", LIMIT_SECONDS]);
      if (!Array.isArray(result) || result.length !== 2 || result.some((n) => !Number.isSafeInteger(n) || n < 1)) throw failure();
      return result[0] <= 5 && result[1] <= 30;
    },
  };
}

export function readCookie(request, env = process.env) {
  const name = COOKIE_NAME(env);
  return request.headers.get("cookie")?.split(";").map((value) => value.trim()).find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1) ?? "";
}

export function parseSession(token, config, now = Date.now()) {
  if (typeof token !== "string" || token.length > 300) return null;
  const parts = token.split(".");
  if (parts.length !== 5 || parts[0] !== "v1" || !/^[A-Za-z0-9_-]{43}$/u.test(parts[1]) || !/^\d{13}$/u.test(parts[2]) || !equal(parts[3], config.binding)) return null;
  const expiresAt = Number(parts[2]);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now || expiresAt > now + SESSION_SECONDS * 1000 || !equal(parts[4], mac(parts.slice(0, 4).join("."), config.secret))) return null;
  return { key: `tb:auth:session:${digest(parts[1])}`, expiresAt, binding: parts[3] };
}

export function createAdminAuth(config, store = createRedisAuthStore(config), now = Date.now) {
  return {
    async login(username, password, identity, previousToken) {
      if (!await store.takeAttempt(mac(identity, config.secret))) return { status: 429, code: "LOGIN_LIMITED" };
      // Creation policy must not lock out previously configured administrator hashes.
      if (typeof username !== "string" || username.length > 100 || typeof password !== "string" || password.length === 0 || Buffer.byteLength(password) > 1024) return { status: 401, code: "INVALID_CREDENTIALS" };
      const fields = config.passwordHash.split("$");
      // Same password work for unknown users; never reveal which field was wrong.
      const calculated = await derive(password, fields[4], 32, COST);
      if (!equal(username, config.username) || !timingSafeEqual(calculated, Buffer.from(fields[5], "hex"))) return { status: 401, code: "INVALID_CREDENTIALS" };
      const previous = parseSession(previousToken, config, now());
      if (previous) await store.remove(previous.key);
      const expiresAt = now() + SESSION_SECONDS * 1000;
      const unsigned = `v1.${randomBytes(32).toString("base64url")}.${expiresAt}.${config.binding}`;
      const token = `${unsigned}.${mac(unsigned, config.secret)}`;
      const session = parseSession(token, config, now());
      await store.create(session.key, { role: "admin", expiresAt, binding: config.binding }, SESSION_SECONDS);
      return { status: 200, token, expiresAt };
    },
    async verify(token) {
      const parsed = parseSession(token, config, now());
      if (!parsed) return null;
      const session = await store.read(parsed.key);
      return session?.role === "admin" && session.expiresAt === parsed.expiresAt && session.binding === config.binding && session.expiresAt > now() ? { role: "admin", expiresAt: session.expiresAt } : null;
    },
    async logout(token) { const parsed = parseSession(token, config, now()); if (parsed) await store.remove(parsed.key); },
  };
}

export function sameOriginMutation(request, config) {
  return request.headers.get("origin") === config.origin && [null, "same-origin", "none"].includes(request.headers.get("sec-fetch-site"));
}

export function loginIdentity(request, env = process.env) {
  // Vercel replaces this header. Never trust user-supplied x-forwarded-for.
  return env.VERCEL === "1" ? (request.headers.get("x-vercel-forwarded-for") ?? "unknown").slice(0, 100) : "local";
}

export function isAutomationRequest(request, env = process.env) {
  const pathname = new URL(request.url).pathname;
  const token = env.TB_AUTOMATION_READ_TOKEN;
  return request.method === "GET" && ["/api/top-stocks", "/api/model-performance", "/api/daily-production-status", "/api/intraday-model-top"].includes(pathname) && /^[A-Za-z0-9_-]{43,128}$/u.test(token ?? "") && equal(request.headers.get("authorization") ?? "", `Bearer ${token}`);
}

export function automationPublicationDto(pathname, body) {
  if (pathname === "/api/intraday-model-top") return { signalDate: body?.signalDate ?? null, observationType: body?.observationType ?? null, collectionCompletedAt: body?.collectionCompletedAt ?? null };
  if (pathname === "/api/top-stocks") return { rankingAsOfDate: body?.rankingAsOfDate ?? null, freshness: { freshnessStatus: body?.freshness?.freshnessStatus ?? null } };
  if (pathname === "/api/model-performance") return { latestEodReferenceDate: body?.latestEodReferenceDate ?? null };
  return { siteApiReferenceDate: body?.siteApiReferenceDate ?? null, publicationStatus: body?.publicationStatus ?? null };
}

export const AUTH_HEADERS = { "Cache-Control": "private, no-store, max-age=0", "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY", "Referrer-Policy": "same-origin" };
export function authError(status = 401, code = "AUTH_REQUIRED") { return Response.json({ error: { code, message: status === 503 ? "인증 서비스 설정 또는 연결을 확인해 주세요." : "관리자 로그인이 필요합니다." } }, { status, headers: AUTH_HEADERS }); }
export function sessionCookie(token, env = process.env, maxAge = SESSION_SECONDS) { return `${COOKIE_NAME(env)}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${env.NODE_ENV === "production" ? "; Secure" : ""}`; }

export async function authenticateRequest(request, env = process.env) {
  try { return { session: await createAdminAuth(authConfig(env)).verify(readCookie(request, env)), unavailable: false }; }
  catch { return { session: null, unavailable: true }; }
}
