// Isolated regression fixture: no real clock change, credentials or networking.
import { registerHooks } from "node:module";
import { readFileSync } from "node:fs";
const RealDate = Date;
let lastClock = RealDate.parse("2026-10-19T13:59:00+09:00");
class FixtureDate extends RealDate {
  constructor(...args) { super(...(args.length ? args : [FixtureDate.now()])); }
  static now() {
    const value = Number(readFileSync(process.env.TB_TEST_CLOCK_FILE, "utf8"));
    if (Number.isSafeInteger(value) && value >= lastClock) lastClock = value;
    return lastClock;
  }
}
globalThis.Date = FixtureDate;
globalThis.fetch = async () => { throw new Error("TEST_NETWORK_FORBIDDEN"); };
registerHooks({ load(url, context, nextLoad) {
  if (url.endsWith("/infra/live-executor/runtime.mjs")) return { format: "module", shortCircuit: true,
    source: `export function repositoryInputs(){return {
      verifyFormula:async()=>({}),
      verifyClock:async()=>{throw new Error('CLOCK_REFERENCE_UNAVAILABLE')},
      loadSeed:async()=>{throw new Error('TEST_SEED_FORBIDDEN')}
    }}` };
  return nextLoad(url, context);
} });
