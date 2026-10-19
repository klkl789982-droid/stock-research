// One counter per relay invocation, not per object lifetime. Leave ten of the
// Free50 external-subrequest allowance unused. Adapter retries share this cap.
export function privateRequestBudget(fetchImpl, maximum = 40) {
  if (typeof fetchImpl !== "function" || !Number.isInteger(maximum) || maximum < 1 || maximum > 40) throw new Error("LIVE_CLOUD_RELAY_BUDGET_INVALID");
  let calls = 0, exhausted = false;
  return {
    get calls() { return calls; }, get exhausted() { return exhausted; },
    async fetch(input, init) {
      if (calls >= maximum) { exhausted = true; throw new Error("LIVE_CLOUD_RELAY_HTTP_BUDGET"); }
      calls++;
      return fetchImpl(input, init);
    },
  };
}
