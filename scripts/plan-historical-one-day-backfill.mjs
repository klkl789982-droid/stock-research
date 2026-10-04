import fs from "node:fs/promises";
import path from "node:path";
import { buildHistoricalOneDayBackfillPlan } from "../lib/historical-one-day-outcome-backfill.mjs";

if (!process.argv.includes("--dry-run")) throw new Error("이 단계에서는 --dry-run만 지원합니다. 실제 API 수집은 별도 승인 후 진행합니다.");
const root = process.cwd();
const historyDirectory = path.join(root, "data", "history");
const names = (await fs.readdir(historyDirectory)).filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/u.test(name)).sort();
const snapshots = await Promise.all(names.map((name) => fs.readFile(path.join(historyDirectory, name), "utf8").then(JSON.parse)));
const calendar = JSON.parse(await fs.readFile(path.join(root, "data", "trading-calendar", "status.json"), "utf8"));
const coverageAsOfDate = Object.keys(calendar.dates ?? {}).sort().at(-1);
const plan = buildHistoricalOneDayBackfillPlan({ snapshots, coverageAsOfDate });
console.log(`HISTORICAL_1D_BACKFILL_DRY_RUN_JSON=${JSON.stringify(plan)}`);
