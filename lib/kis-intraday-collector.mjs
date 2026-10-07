const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const retryableNetworkCode = (error) => ["KIS_BUSINESS_NETWORK_ERROR", "KIS_TOKEN_NETWORK_ERROR"].includes(error?.code) || ["KIS_BUSINESS_NETWORK_ERROR", "KIS_TOKEN_NETWORK_ERROR"].includes(error?.message);

export async function requestKisWithTransientRetry({ request, retries = 1, backoffMs = 250, wait = delay }) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await request();
      if (response?.ok || response?.status < 500 || attempt === retries) return response;
      lastError = new Error(`KIS_HTTP_${response.status}`);
    } catch (error) {
      if (!retryableNetworkCode(error) || attempt === retries) throw error;
      lastError = error;
    }
    await wait(backoffMs * (attempt + 1));
  }
  throw lastError ?? new Error("KIS_TRANSIENT_RETRY_FAILED");
}

export async function collectKisQuotes({ codes, fetchQuote, delayMs = 150, concurrency = 1, now = () => new Date().toISOString() }) {
  const startedAt = now(); const quotesByCode = new Map(); const failures = [];
  const batchSize = Number.isInteger(concurrency) && concurrency > 0 ? concurrency : 1;
  for (let index = 0; index < codes.length; index += batchSize) {
    const batch = codes.slice(index, index + batchSize);
    const results = await Promise.all(batch.map(async (code) => {
      try { return { code, quote: await fetchQuote(code) }; }
      catch (error) { return { code, error: error instanceof Error ? error.message.slice(0, 80) : "quoteFailed" }; }
    }));
    for (const result of results) {
      if ("quote" in result) quotesByCode.set(result.code, result.quote);
      else failures.push({ code: result.code, reason: result.error });
    }
    if (index + batchSize < codes.length) await delay(delayMs);
  }
  return { startedAt, completedAt: now(), quotesByCode, failures };
}
