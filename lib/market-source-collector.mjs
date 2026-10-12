// Opt-in research coordinator. No schedules, credentials, production writes or fallback promotion.
import { requireResearchRights, SOURCE_IDS, validResearchDate, verifyResearchObservation } from "./market-source-contract.mjs";
import { normalizeStockCode } from "./stock-code.mjs";
const transient = new Set(["SOURCE_RATE_LIMIT", "SOURCE_SERVER_ERROR", "SOURCE_NETWORK_ERROR"]);
export function createResearchCollector({ providers, grants = {}, now = Date.now, wait = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  if (!Array.isArray(providers) || new Set(providers.map((p) => p.id)).size !== providers.length) throw new Error("SOURCE_PROVIDERS_INVALID");
  const states = new Map();
  for (const p of providers) {
    if (!SOURCE_IDS.includes(p.id) || typeof p.request !== "function") throw new Error("SOURCE_PROVIDER_INVALID");
    const config = { minIntervalMs: 1000, timeoutMs: 15000, maxAttempts: 1, breakerThreshold: 2, cooldownMs: 60000, ...p };
    for (const [key, min, max] of [["minIntervalMs", 0, 60000], ["timeoutMs", 1, 30000], ["maxAttempts", 1, 3], ["breakerThreshold", 1, 10], ["cooldownMs", 1, 300000]]) {
      if (!Number.isInteger(config[key]) || config[key] < min || config[key] > max) throw new Error("SOURCE_LIMITS_INVALID");
    }
    states.set(p.id, { config, tail: Promise.resolve(), lastRequest: null, failures: 0, openUntil: 0, orphan: false,
      status: { latestProvidedDate: null, latestCollectedDate: null, latestValidatedDate: null, latestPublishedDate: null, lastSuccessAt: null, lastFailureCode: null, nextCheckAt: null } });
  }
  const inFlight = new Map();
  function collect(id, query, { automatic = false } = {}) {
    const state = states.get(id);
    if (!state || normalizeStockCode(query?.ticker) !== query.ticker || !validResearchDate(query?.referenceDate)
      || !["UNKNOWN", "unadjusted", "adjusted"].includes(query?.adjustment ?? "UNKNOWN")) return Promise.resolve({ status: "FAILED", reason: "SOURCE_QUERY_INVALID" });
    try { requireResearchRights(grants, id, automatic ? ["apiQuery", "automaticCollection"] : ["apiQuery"]); }
    catch { return Promise.resolve({ provider: id, status: "BLOCKED", reason: "SOURCE_RIGHTS_NOT_VERIFIED" }); }
    const key = `${id}:${query.ticker}:${query.referenceDate}:${query.adjustment ?? "UNKNOWN"}`;
    if (inFlight.has(key)) return inFlight.get(key);
    if (inFlight.size >= 1200) return Promise.resolve({ provider: id, status: "BLOCKED", reason: "SOURCE_QUEUE_LIMIT" });
    const work = state.tail.then(async () => {
      const { config } = state;
      const failed = (reason, status = "FAILED") => {
        state.status.lastFailureCode = reason;
        state.status.nextCheckAt = new Date(Math.max(now() + config.cooldownMs, state.openUntil)).toISOString();
        return { provider: id, ticker: query.ticker, referenceDate: query.referenceDate, status, reason };
      };
      if (state.orphan) return failed("SOURCE_TIMEOUT_STILL_IN_FLIGHT", "BLOCKED");
      if (now() < state.openUntil) return failed("SOURCE_CIRCUIT_OPEN", "BLOCKED");
      let reason = "SOURCE_REQUEST_FAILED";
      for (let attempt = 1; attempt <= config.maxAttempts; attempt++) {
        if (state.lastRequest !== null) await wait(Math.max(0, config.minIntervalMs - (now() - state.lastRequest)));
        state.lastRequest = now(); const requestedAt = new Date(state.lastRequest).toISOString();
        const controller = new AbortController(); let timer, settled = false;
        const request = Promise.resolve().then(() => config.request({ ...query, signal: controller.signal })).then(
          (value) => { settled = true; state.orphan = false; return { value }; },
          (error) => { settled = true; state.orphan = false; return { reason: transient.has(error?.code) ? error.code : "SOURCE_REQUEST_FAILED" }; });
        const response = await Promise.race([request, new Promise((resolve) => { timer = setTimeout(() => { state.orphan = !settled; controller.abort(); resolve({ reason: "SOURCE_TIMEOUT" }); }, config.timeoutMs); })]);
        clearTimeout(timer);
        if (!response.reason) {
          try {
            verifyResearchObservation(response.value);
            if (response.value.provider !== id || response.value.ticker !== query.ticker || response.value.referenceDate !== query.referenceDate
              || query.adjustment && query.adjustment !== "UNKNOWN" && response.value.adjustment !== query.adjustment) throw new Error("IDENTITY");
          } catch { response.reason = "SOURCE_RESPONSE_CONTRACT_INVALID"; }
        }
        if (!response.reason) {
          state.failures = 0; state.openUntil = 0;
          const receivedAt = new Date(now()).toISOString();
          // Collection success does not imply quality, calculation or publication success.
          state.status.lastSuccessAt = receivedAt; state.status.lastFailureCode = null; state.status.nextCheckAt = null;
          if (response.value.quality.issues.includes("EXACT_DATE_UNAVAILABLE")) {
            state.status.nextCheckAt = new Date(now() + config.cooldownMs).toISOString();
            return { provider: id, ticker: query.ticker, status: "SOURCE_PENDING", reason: "EXACT_DATE_UNAVAILABLE", requestedAt, receivedAt, attempts: attempt, value: response.value };
          }
          if (response.value?.referenceDate === query.referenceDate && response.value?.quality?.status === "VALIDATED_FIELDS_ONLY") {
            state.status.latestCollectedDate = [state.status.latestCollectedDate, query.referenceDate].filter(Boolean).sort().at(-1);
          }
          return { provider: id, ticker: query.ticker, status: "COLLECTED", requestedAt, receivedAt, attempts: attempt, value: response.value };
        }
        reason = response.reason;
        if (!transient.has(reason) || attempt === config.maxAttempts) break;
        await wait(500 * 2 ** (attempt - 1));
      }
      state.failures++; if (state.failures >= config.breakerThreshold || reason === "SOURCE_TIMEOUT") state.openUntil = now() + config.cooldownMs;
      return failed(reason);
    });
    state.tail = work.then(() => {}, () => {});
    const shared = work.catch(() => ({ provider: id, status: "FAILED", reason: "SOURCE_COORDINATOR_FAILED" })).finally(() => inFlight.delete(key));
    inFlight.set(key, shared); return shared;
  }
  return { collect, async collectIndependent(jobs, options) {
    if (!Array.isArray(jobs) || jobs.length > 1200) throw new Error("SOURCE_BATCH_LIMIT");
    return Promise.all(jobs.map(({ provider, ...query }) => collect(provider, query, options)));
  }, status: () => Object.fromEntries([...states].map(([id, s]) => [id, { ...s.status, circuitOpen: now() < s.openUntil, requestStillRunning: s.orphan }])) };
}
