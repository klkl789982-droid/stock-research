import { validateIntradaySeedAvailability } from "./intraday-model-top-official-signal.mjs";
import { signalWeekday } from "./intraday-model-top-time-policy.mjs";

// Missing weekday evidence is unknown, never an inferred holiday or a license
// to bridge a missing trading session with an older candle history.
export function assertLiveSeedSession(seed, signalDate, calendar) {
  if (validateIntradaySeedAvailability(seed, signalDate).length) throw new Error("LIVE_INPUT_NOT_READY_SEED_AVAILABILITY");
  const day = new Date(`${signalDate}T00:00:00Z`);
  for (let offset = 1; offset <= 370; offset += 1) {
    day.setUTCDate(day.getUTCDate() - 1);
    const date = day.toISOString().slice(0, 10);
    if ([0, 6].includes(signalWeekday(date))) continue;
    const entry = calendar?.dates?.[date];
    if (entry?.status === "marketClosed") continue;
    if (entry?.status !== "tradingDay" || entry.observedBasDt !== date) throw new Error("LIVE_INPUT_NOT_READY_PREVIOUS_SESSION_UNVERIFIED");
    if (seed.requestedDate !== date) throw new Error("LIVE_INPUT_NOT_READY_PREVIOUS_SESSION_MISSING");
    const sourceHash = seed.sourceManifest.sources.officialDailyPrice.normalizedInputHash;
    for (const record of seed.records ?? []) {
      if (!record.eligible) continue;
      const rows = record.rows;
      if (record.officialAsOfDate !== date || record.sourceHash !== sourceHash) throw new Error("LIVE_INPUT_NOT_READY_PREVIOUS_SESSION_MISSING");
      if (!Array.isArray(rows) || rows.length !== 260 || String(rows[0]?.[0]) !== date.replaceAll("-", "")) throw new Error("LIVE_INPUT_NOT_READY_HISTORY_GAP");
      // Earlier per-security gaps may represent a suspension. Do not invent a
      // new 260-session completeness policy for the existing 260-observation model.
    }
    return date;
  }
  throw new Error("LIVE_INPUT_NOT_READY_PREVIOUS_SESSION_UNVERIFIED");
}
