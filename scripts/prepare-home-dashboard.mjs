import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { getHomeDashboard } from "../lib/home-dashboard-store.mjs";
import { privateReportDirectory } from "../lib/private-report-directory.mjs";

// These three views depend only on files shipped with this release. Build them
// using the existing ranking, transition and publication validation code.
const output = path.join(privateReportDirectory(process.cwd()), "private-home-dashboard");
await mkdir(output, { recursive: true });
const calendar = JSON.parse(await readFile("data/trading-calendar/status.json", "utf8"));
for (const topN of [5, 10, 20]) {
  const summary = { ...await getHomeDashboard(topN), calendar: undefined };
  if (!summary.dataIdentity || summary.dataIdentity.referenceDate !== summary.referenceDate) {
    throw new Error("HOME_BUILD_IDENTITY_MISSING");
  }
  await writeFile(path.join(output, topN + ".json"), JSON.stringify({ summary, calendar }), "utf8");
}
