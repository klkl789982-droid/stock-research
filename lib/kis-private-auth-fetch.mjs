const TOKEN_ENDPOINT = "https://openapi.koreainvestment.com:9443/oauth2/tokenP";
const waitDefault = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

// Private full-collection transport ONLY. A parallel short preflight can issue
// the same key's token less than a minute earlier. Retry only documented token
// issuance throttling, never invalid credentials, authorization or generic 403.
// Nothing from the response/token/headers is logged, returned as metadata or saved.
export function createPrivateAuthFetch({ fetchImpl = fetch, wait = waitDefault } = {}) {
  return async (input, init = {}) => {
    const request = () => fetchImpl(input, { ...init, redirect: "error", signal: init.signal ?? AbortSignal.timeout(15_000) });
    const response = await request();
    if (String(input) !== TOKEN_ENDPOINT || init.method !== "POST" || response.status !== 403) return response;
    let code;
    try { code = (await response.clone().json()).error_code; } catch { return response; }
    if (code !== "EGW00133") return response;
    await response.body?.cancel().catch(() => {});
    await wait(65_000);
    if (init.signal?.aborted) throw Object.assign(new Error("KIS_TOKEN_NETWORK_ERROR"), { code: "KIS_TOKEN_NETWORK_ERROR" });
    return request();
  };
}
