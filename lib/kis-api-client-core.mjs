export class KisApiClientError extends Error {
  constructor(code) {
    super(code);
    this.name = "KisApiClientError";
    this.code = code;
  }
}

export function classifyKisHttpStatus(status) {
  if (status === 401) return { code: "KIS_UNAUTHORIZED", httpStatus: 502, message: "KIS 인증에 실패했습니다." };
  if (status === 403) return { code: "KIS_FORBIDDEN", httpStatus: 502, message: "KIS API 권한 또는 계정 설정을 확인해야 합니다." };
  if (status === 429) return { code: "KIS_RATE_LIMITED", httpStatus: 503, message: "KIS API 호출 한도를 초과했습니다." };
  if (status >= 500) return { code: "KIS_UPSTREAM_FAILURE", httpStatus: 502, message: "KIS API가 일시적으로 응답하지 않습니다." };
  return { code: "KIS_UPSTREAM_REJECTED", httpStatus: 502, message: "KIS API 요청이 거부되었습니다." };
}

export function safeKisError(error) {
  const code = typeof error?.code === "string" && /^KIS_[A-Z0-9_]+$/u.test(error.code) ? error.code : "KIS_INTERNAL_ERROR";
  return { code, httpStatus: 502, message: "KIS 요청을 안전하게 처리하지 못했습니다." };
}

export function createKisApiClient({ fetchImpl, tokenManager, getCredentials }) {
  async function call(input, init, tokenRecord) {
    const credentials = getCredentials();
    if (!credentials?.appKey || !credentials?.appSecret) throw new KisApiClientError("KIS_CREDENTIALS_MISSING");
    try {
      return await fetchImpl(input, {
        ...init,
        headers: {
          ...(init?.headers ?? {}),
          authorization: `Bearer ${tokenRecord.accessToken}`,
          appkey: credentials.appKey,
          appsecret: credentials.appSecret,
        },
        cache: "no-store",
      });
    } catch {
      throw new KisApiClientError("KIS_BUSINESS_NETWORK_ERROR");
    }
  }

  async function request(input, init = {}) {
    const firstToken = await tokenManager.getToken();
    const firstResponse = await call(input, init, firstToken);
    if (firstResponse.status !== 401) return firstResponse;

    tokenManager.invalidateIfCurrent(firstToken);
    const refreshedToken = await tokenManager.getToken();
    return call(input, init, refreshedToken);
  }

  return { request };
}
