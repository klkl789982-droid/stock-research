const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export async function collectKisQuotes({ codes, fetchQuote, delayMs = 150, now = () => new Date().toISOString() }) {
  const startedAt = now(); const quotesByCode = new Map(); const failures = [];
  for (let index = 0; index < codes.length; index += 1) {
    const code = codes[index];
    try { quotesByCode.set(code, await fetchQuote(code)); }
    catch (error) { failures.push({ code, reason: error instanceof Error ? error.message.slice(0, 80) : "quoteFailed" }); }
    if (index + 1 < codes.length) await delay(delayMs);
  }
  return { startedAt, completedAt: now(), quotesByCode, failures };
}
