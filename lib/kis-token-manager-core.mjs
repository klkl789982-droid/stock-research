const DEFAULT_REFRESH_WINDOW_MS = 5 * 60 * 1000;

export class KisTokenManagerError extends Error {
  constructor(code) {
    super(code);
    this.name = "KisTokenManagerError";
    this.code = code;
  }
}

function parseAbsoluteExpiry(value) {
  if (typeof value !== "string" || value.trim() === "") return null;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u.test(value)
    ? `${value.replace(" ", "T")}+09:00`
    : value;
  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function parseKisTokenExpiry(payload, issuedAtMs) {
  const candidates = [];
  const expiresIn = Number(payload?.expires_in);
  if (Number.isFinite(expiresIn) && expiresIn > 0) candidates.push(issuedAtMs + expiresIn * 1000);
  for (const field of ["access_token_token_expired", "expires_at"]) {
    const timestamp = parseAbsoluteExpiry(payload?.[field]);
    if (timestamp !== null) candidates.push(timestamp);
  }
  const futureCandidates = candidates.filter((timestamp) => timestamp > issuedAtMs);
  return futureCandidates.length > 0 ? Math.min(...futureCandidates) : null;
}

export function createKisTokenManager({
  fetchImpl,
  getCredentials,
  now = () => Date.now(),
  refreshWindowMs = DEFAULT_REFRESH_WINDOW_MS,
  tokenUrl = "https://openapi.koreainvestment.com:9443/oauth2/tokenP",
}) {
  let cached = null;
  let inFlight = null;
  let generation = 0;

  const isUsable = (record) => record && record.expiresAtMs - now() > refreshWindowMs;

  async function issueToken() {
    const credentials = getCredentials();
    if (!credentials?.appKey || !credentials?.appSecret) throw new KisTokenManagerError("KIS_CREDENTIALS_MISSING");
    let response;
    try {
      response = await fetchImpl(tokenUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ grant_type: "client_credentials", appkey: credentials.appKey, appsecret: credentials.appSecret }),
        cache: "no-store",
      });
    } catch {
      throw new KisTokenManagerError("KIS_TOKEN_NETWORK_ERROR");
    }
    if (!response.ok) throw new KisTokenManagerError(`KIS_TOKEN_HTTP_${response.status}`);
    let payload;
    try { payload = await response.json(); }
    catch { throw new KisTokenManagerError("KIS_TOKEN_INVALID_JSON"); }
    if (typeof payload?.access_token !== "string" || payload.access_token.length === 0) throw new KisTokenManagerError("KIS_TOKEN_MISSING");
    const issuedAtMs = now();
    const expiresAtMs = parseKisTokenExpiry(payload, issuedAtMs);
    if (expiresAtMs === null) throw new KisTokenManagerError("KIS_TOKEN_EXPIRY_MISSING");
    if (expiresAtMs - issuedAtMs <= refreshWindowMs) throw new KisTokenManagerError("KIS_TOKEN_EXPIRY_TOO_SOON");
    generation += 1;
    return Object.freeze({ accessToken: payload.access_token, expiresAtMs, generation });
  }

  async function getToken() {
    if (isUsable(cached)) return cached;
    if (inFlight) return inFlight;
    inFlight = issueToken();
    try {
      cached = await inFlight;
      return cached;
    } finally {
      inFlight = null;
    }
  }

  function invalidateIfCurrent(record) {
    if (!cached || !record) return false;
    if (cached.generation !== record.generation || cached.accessToken !== record.accessToken) return false;
    cached = null;
    return true;
  }

  function clear() {
    cached = null;
    inFlight = null;
  }

  return {
    getToken,
    invalidateIfCurrent,
    clear,
    getState: () => ({ hasUsableToken: Boolean(isUsable(cached)), generation: cached?.generation ?? 0, issuing: Boolean(inFlight) }),
  };
}
