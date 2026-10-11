import { withAdminAccess } from "@/lib/admin-access";
import { NextRequest, NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { getHomeDashboard } from "@/lib/home-dashboard-store.mjs";
import { nextProductionSchedule } from "@/lib/production-schedule.mjs";

async function handleGet(request: NextRequest) {
  const raw = request.nextUrl.searchParams.get("topN") ?? "5";
  if (!["5", "10", "20"].includes(raw)) return NextResponse.json({ error: "TOP 범위는 5/10/20이어야 합니다." }, { status: 400 });
  const [summary, live] = await Promise.allSettled([
    getHomeDashboard(Number(raw)),
    readFile(path.join(process.cwd(), "data", "intraday-signals", "model-top", "latest.json"), "utf8").then((text) => {
      const value = JSON.parse(text);
      return { status: ["READY", "FAILED", "FAILED_COLLECTION", "WAITING", "MARKET_CLOSED"].includes(value.status) ? value.status : "UNKNOWN", reason: ["OFFICIAL_SIGNAL_OUTSIDE_COLLECTION_WINDOW", "LIVE_TRADING_CALENDAR_UNAVAILABLE", "QUOTE_COLLECTION_WINDOW_EXPIRED"].includes(value.reason) ? value.reason : null, runStartedAt: typeof value.runStartedAt === "string" && Number.isFinite(Date.parse(value.runStartedAt)) ? value.runStartedAt : null, nextScheduledAt: nextProductionSchedule("LIVE"), signalDate: /^\d{4}-\d{2}-\d{2}$/u.test(value.signalDate) ? value.signalDate : null, updatedAt: typeof value.updatedAt === "string" && Number.isFinite(Date.parse(value.updatedAt)) ? value.updatedAt : null };
    }),
  ]);
  return NextResponse.json({ ...(summary.status === "fulfilled" ? summary.value : { models: null, transitions: null, calendar: null, referenceDate: null }),
    liveStatus: live.status === "fulfilled" ? live.value : null,
  }, { headers: { "Cache-Control": "no-store" } });
}

export const GET = withAdminAccess(handleGet);
