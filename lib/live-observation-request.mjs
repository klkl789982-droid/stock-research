import { OFFICIAL_SIGNAL_TIME, OFFICIAL_SIGNAL_WINDOW_END, signalWeekday } from "./intraday-model-top-time-policy.mjs";

// Guard the actual transport, including the API client's internal auth retry.
// Calendar/token prewarming is intentionally outside this observation-price gate.
export function createLiveObservationFetch({ signalDate, fetchImpl = fetch, now = Date.now, timeoutMs = 15_000, nonObservational = false }) {
  const start = Date.parse(`${signalDate}T${OFFICIAL_SIGNAL_TIME}+09:00`);
  const end = Date.parse(`${signalDate}T${OFFICIAL_SIGNAL_WINDOW_END}+09:00`);
  const isOpen = () => ![0, 6].includes(signalWeekday(signalDate)) && now() >= start && now() <= end;
  return async (input, init = {}) => {
    const pathname = new URL(typeof input === "string" ? input : input.url ?? String(input)).pathname;
    const observation = /\/quotations\/(?:inquire-price|inquire-time-itemchartprice)$/u.test(pathname);
    if (!observation) return fetchImpl(input, init);
    if (!nonObservational && !isOpen()) throw new Error("QUOTE_COLLECTION_WINDOW_EXPIRED");
    const budget = nonObservational ? timeoutMs : Math.max(1, Math.min(timeoutMs, end - now()));
    const deadline = AbortSignal.timeout(budget);
    const signal = init.signal ? AbortSignal.any([init.signal, deadline]) : deadline;
    try {
      const response = await fetchImpl(input, { ...init, signal });
      // Arrival means the full response body, not just HTTP headers.
      const body = await response.text();
      if (!nonObservational && !isOpen()) throw new Error("QUOTE_COLLECTION_WINDOW_EXPIRED");
      return new Response([204, 205, 304].includes(response.status) ? null : body, { status: response.status, statusText: response.statusText, headers: response.headers });
    } catch (error) {
      if (!nonObservational && (!isOpen() || deadline.aborted && now() >= end)) throw new Error("QUOTE_COLLECTION_WINDOW_EXPIRED");
      throw error;
    }
  };
}
