// A source observation policy is versioned separately from model scoring formulas.
// Archived 14:30 artifacts retain their original identity and are never current.
export const CURRENT_LIVE_PROFILE = Object.freeze({ schemaVersion: 2, signalVersion: "intraday-model-top-official-signal-v2",
  policyId: "intraday-1400-v1", signalTime: "14:00:00", windowEnd: "15:30:00", slot: "1400" });
export const LEGACY_LIVE_PROFILE = Object.freeze({ schemaVersion: 1, signalVersion: "intraday-model-top-official-signal-v1",
  policyId: "intraday-1430-v1", signalTime: "14:30:00", windowEnd: "14:35:00", slot: "1430" });
export const LIVE_INPUT_WAIT_REASONS = Object.freeze([
  "LIVE_INPUT_NOT_READY_SEED_AVAILABILITY",
  "LIVE_INPUT_NOT_READY_PREVIOUS_SESSION_UNVERIFIED",
  "LIVE_INPUT_NOT_READY_PREVIOUS_SESSION_MISSING",
  "LIVE_INPUT_NOT_READY_HISTORY_GAP",
  "LIVE_INPUT_NOT_READY_REFRESH_DATE_INVALID",
  "LIVE_INPUT_NOT_READY_REFRESH_TOO_EARLY",
  "LIVE_INPUT_NOT_READY_REFRESH_LATE",
  "LIVE_INPUT_NOT_READY_REFRESH_FAILED",
  "LIVE_INPUT_NOT_READY_REFRESH_ORIGIN_REJECTED",
  "LIVE_INPUT_NOT_READY_REFRESH_CODE_MISMATCH",
  "LIVE_INPUT_NOT_READY_REFRESH_COMMIT_INVALID",
  "LIVE_INPUT_NOT_READY_REFRESH_INPUT_INVALID",
  "LIVE_INPUT_NOT_READY_REFRESH_FORMULA_MISMATCH",
]);
export const OFFICIAL_SIGNAL_TIME = CURRENT_LIVE_PROFILE.signalTime;
export const OFFICIAL_SIGNAL_WINDOW_END = CURRENT_LIVE_PROFILE.windowEnd;
export function intradaySignalProfile(signal) {
  if (signal?.schemaVersion === CURRENT_LIVE_PROFILE.schemaVersion && signal?.signalVersion === CURRENT_LIVE_PROFILE.signalVersion
    && signal?.officialSignalTime === CURRENT_LIVE_PROFILE.signalTime && signal?.observationPolicyId === CURRENT_LIVE_PROFILE.policyId) return CURRENT_LIVE_PROFILE;
  if (signal?.schemaVersion === LEGACY_LIVE_PROFILE.schemaVersion && signal?.signalVersion === LEGACY_LIVE_PROFILE.signalVersion
    && signal?.officialSignalTime === LEGACY_LIVE_PROFILE.signalTime && (signal?.observationPolicyId === undefined || signal.observationPolicyId === LEGACY_LIVE_PROFILE.policyId)) return LEGACY_LIVE_PROFILE;
  return null;
}

// The input is already a Korean calendar date; parsing KST midnight as UTC
// shifts it to the previous weekday (and incorrectly rejects every Monday).
export function signalWeekday(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date ?? "")) throw new Error("OFFICIAL_SIGNAL_DATE_INVALID");
  const instant = new Date(`${date}T00:00:00Z`);
  if (!Number.isFinite(instant.getTime()) || instant.toISOString().slice(0, 10) !== date) throw new Error("OFFICIAL_SIGNAL_DATE_INVALID");
  return instant.getUTCDay();
}

export function liveAttemptStatus(previous, attempt) {
  const lastGood = previous?.status === "READY" ? Object.fromEntries(["signalDate", "officialSignalTime", "observationPolicyId", "signalPath", "contentHash", "collectionStartedAt", "collectionCompletedAt"].map((key) => [key, previous[key] ?? null])) : previous?.lastGood ?? null;
  // Operational failures are not new signals. Preserve the last successful pointer.
  return { ...attempt, lastGood, lastSuccessAt: attempt.status === "READY" ? attempt.collectionCompletedAt ?? null : lastGood?.collectionCompletedAt ?? previous?.lastSuccessAt ?? null };
}

export function liveStatusLabel(value) {
  if (value?.status === "MARKET_CLOSED") return "휴장 · 관측 대상 아님";
  if (value?.reason === "OFFICIAL_SIGNAL_OUTSIDE_COLLECTION_WINDOW") return "예약 지연 · 관측창 놓침";
  if (value?.reason === "QUOTE_COLLECTION_WINDOW_EXPIRED") return "수집 지연 · 관측창 초과";
  if (value?.status === "WAITING" && LIVE_INPUT_WAIT_REASONS.includes(value.reason)) return "직전 공식 EOD 입력 확인 대기";
  if (value?.status === "WAITING") return "예약 실행 대기";
  if (value?.status === "FAILED") {
    const labels = { collection: "수집 실패", validation: "검증 실패", calculation: "모델 계산 실패", storage: "저장 실패", publication: "게시 실패", calendar: "거래일 검증 실패" };
    if (labels[value.failureStage]) return labels[value.failureStage];
  }
  if (["FAILED", "FAILED_COLLECTION"].includes(value?.status)) return "수집·검증 실패";
  return null;
}

export function liveSchedulerMetadata(env, runStartedAt) {
  const started = Date.parse(runStartedAt);
  const firstStep = Date.parse(env.INTRADAY_RUNNER_FIRST_STEP_AT ?? "");
  const requested = env.INTRADAY_SCHEDULED_AT ?? "";
  const scheduled = Date.parse(requested);
  const fromWorker = env.INTRADAY_TRIGGER_TYPE === "workflow_dispatch" && env.INTRADAY_TRIGGER_SOURCE === "cloudflare-live-prewarm";
  const valid = fromWorker && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(requested)
    && Number.isFinite(scheduled) && scheduled <= started;
  // Never infer the intended event date from a delayed runner's current date.
  return { scheduler: fromWorker ? "cloudflare-live-prewarm" : env.INTRADAY_TRIGGER_TYPE === "schedule" ? "github-schedule" : "manual_or_unknown",
    scheduledAt: valid ? new Date(scheduled).toISOString() : null, scriptStartedAt: runStartedAt,
    runnerFirstStepAt: Number.isFinite(firstStep) && firstStep <= started ? new Date(firstStep).toISOString() : null,
    schedulerToScriptDelayMs: valid ? started - scheduled : null };
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
