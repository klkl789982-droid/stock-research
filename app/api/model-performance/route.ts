import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { buildModelTopPerformance } from "@/lib/model-top-performance.mjs";

export async function GET() {
  const root = process.cwd(); const outcomeDir = path.join(root, "data", "historical-outcomes", "1d"); const historyDir = path.join(root, "data", "history");
  try {
    const names = (await readdir(outcomeDir)).filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/u.test(name)).sort();
    const outcomes = await Promise.all(names.map(async (name) => JSON.parse(await readFile(path.join(outcomeDir, name), "utf8"))));
    const snapshots = await Promise.all(names.map(async (name) => { try { return JSON.parse(await readFile(path.join(historyDir, name), "utf8")); } catch { return null; } }));
    return NextResponse.json(buildModelTopPerformance({ snapshots: snapshots.filter(Boolean), outcomes }), { headers: { "Cache-Control": "no-store" } });
  } catch { return NextResponse.json({ schemaVersion: 1, dataset: "model-top-performance-1d", matureSignalDates: [], daily: [], summary: [] }, { headers: { "Cache-Control": "no-store" } }); }
}
