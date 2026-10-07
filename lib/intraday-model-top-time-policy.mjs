export const OFFICIAL_SIGNAL_TIME = "14:30:00";
export const OFFICIAL_SIGNAL_WINDOW_END = "14:35:00";

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
