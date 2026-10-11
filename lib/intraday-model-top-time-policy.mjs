export const OFFICIAL_SIGNAL_TIME = "14:30:00";
export const OFFICIAL_SIGNAL_WINDOW_END = "14:35:00";

// The input is already a Korean calendar date; parsing KST midnight as UTC
// shifts it to the previous weekday (and incorrectly rejects every Monday).
export function signalWeekday(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date ?? "")) throw new Error("OFFICIAL_SIGNAL_DATE_INVALID");
  const instant = new Date(`${date}T00:00:00Z`);
  if (!Number.isFinite(instant.getTime()) || instant.toISOString().slice(0, 10) !== date) throw new Error("OFFICIAL_SIGNAL_DATE_INVALID");
  return instant.getUTCDay();
}

export function liveAttemptStatus(previous, attempt) {
  const lastGood = previous?.status === "READY" ? Object.fromEntries(["signalDate", "signalPath", "contentHash", "collectionStartedAt", "collectionCompletedAt"].map((key) => [key, previous[key] ?? null])) : previous?.lastGood ?? null;
  // Operational failures are not new signals. Preserve the last successful pointer.
  return { ...attempt, lastGood, lastSuccessAt: attempt.status === "READY" ? attempt.collectionCompletedAt ?? null : lastGood?.collectionCompletedAt ?? previous?.lastSuccessAt ?? null };
}

export function liveStatusLabel(value) {
  if (value?.status === "MARKET_CLOSED") return "휴장 · 관측 대상 아님";
  if (value?.reason === "OFFICIAL_SIGNAL_OUTSIDE_COLLECTION_WINDOW") return "예약 지연 · 관측창 놓침";
  if (["FAILED", "FAILED_COLLECTION"].includes(value?.status)) return "수집·검증 실패";
  return null;
}

export function classifyOfficialSignalWindow({ time, weekday }) {
  if (!Number.isInteger(weekday) || weekday === 0 || weekday === 6) return "WEEKEND";
  if (typeof time !== "string" || !/^\d{2}:\d{2}:\d{2}$/u.test(time)) return "INVALID_TIME";
  if (time < OFFICIAL_SIGNAL_TIME) return "BEFORE_WINDOW";
  if (time > OFFICIAL_SIGNAL_WINDOW_END) return "AFTER_WINDOW";
  return "COLLECT";
}

export function millisecondsUntilKstTime({ date, time, nowMs }) {
  const target = Date.parse(`${date}T${time}+09:00`);
  if (!Number.isFinite(target) || !Number.isFinite(nowMs)) throw new Error("OFFICIAL_SIGNAL_WAIT_TARGET_INVALID");
  return Math.max(0, target - nowMs);
}
