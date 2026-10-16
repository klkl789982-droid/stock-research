import { withAdminAccess } from "@/lib/admin-access";
import { NextRequest, NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { getHomeDashboard } from "@/lib/home-dashboard-store.mjs";
import { CURRENT_LIVE_PROFILE, LIVE_INPUT_WAIT_REASONS } from "@/lib/intraday-model-top-time-policy.mjs";
import { nextProductionSchedule } from "@/lib/production-schedule.mjs";
const calendarDate = (value: unknown) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value ? value : null;
const timestamp = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;

async function handleGet(request: NextRequest) {
  const raw = request.nextUrl.searchParams.get("topN") ?? "5";
  if (!["5", "10", "20"].includes(raw)) return NextResponse.json({ error: "TOP 범위는 5/10/20이어야 합니다." }, { status: 400 });
  const [summary, live] = await Promise.allSettled([
    getHomeDashboard(Number(raw)),
    readFile(path.join(process.cwd(), "data", "intraday-signals", "model-top", "latest.json"), "utf8").then((text) => {
      const value = JSON.parse(text);
      // Archived 14:30 attempts never become current 14:00 operational status.
      if (value.schemaVersion !== CURRENT_LIVE_PROFILE.schemaVersion || value.officialSignalTime !== CURRENT_LIVE_PROFILE.signalTime || value.observationPolicyId !== CURRENT_LIVE_PROFILE.policyId
        || (value.status === "READY" && value.signalPath !== `data/intraday-signals/model-top/${value.signalDate}/${CURRENT_LIVE_PROFILE.slot}.json`)) return {
        status: "WAITING", reason: "CURRENT_LIVE_NOT_OBSERVED", officialSignalTime: CURRENT_LIVE_PROFILE.signalTime, observationPolicyId: CURRENT_LIVE_PROFILE.policyId,
        signalDate: null, lastGoodDate: null, lastSuccessAt: null, nextScheduledAt: nextProductionSchedule("LIVE"),
      };
      const currentLastGood = calendarDate(value.lastGood?.signalDate) !== null && value.lastGood?.observationPolicyId === CURRENT_LIVE_PROFILE.policyId
        && value.lastGood?.officialSignalTime === CURRENT_LIVE_PROFILE.signalTime && value.lastGood?.signalPath === `data/intraday-signals/model-top/${value.lastGood.signalDate}/${CURRENT_LIVE_PROFILE.slot}.json`;
      return {
        officialSignalTime: value.officialSignalTime, observationPolicyId: value.observationPolicyId,
        status: ["READY", "FAILED", "FAILED_COLLECTION", "WAITING", "MARKET_CLOSED"].includes(value.status) ? value.status : "UNKNOWN",
        reason: [...LIVE_INPUT_WAIT_REASONS, "OFFICIAL_SIGNAL_OUTSIDE_COLLECTION_WINDOW", "LIVE_TRADING_CALENDAR_UNAVAILABLE", "QUOTE_COLLECTION_WINDOW_EXPIRED"].includes(value.reason) ? value.reason : null,
        failureStage: ["calendar", "collection", "calculation", "validation", "storage", "publication"].includes(value.failureStage) ? value.failureStage : null,
        runStartedAt: timestamp(value.runStartedAt), nextScheduledAt: nextProductionSchedule("LIVE"),
        signalDate: calendarDate(value.signalDate), updatedAt: timestamp(value.updatedAt),
        lastSuccessAt: value.status === "READY" || currentLastGood ? timestamp(value.lastSuccessAt) : null, lastGoodDate: currentLastGood ? calendarDate(value.lastGood.signalDate) : null,
        scheduledAt: timestamp(value.operations?.scheduledAt), storedAt: timestamp(value.operations?.storedAt),
        runnerFirstStepAt: timestamp(value.operations?.runnerFirstStepAt),
      };
    }),
  ]);
  return NextResponse.json({ ...(summary.status === "fulfilled" ? summary.value : { models: null, transitions: null, calendar: null, referenceDate: null }),
    liveStatus: live.status === "fulfilled" ? live.value : null,
  }, { headers: { "Cache-Control": "no-store" } });
}

export const GET = withAdminAccess(handleGet);
