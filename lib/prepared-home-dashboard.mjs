import { readFile } from "node:fs/promises";
import path from "node:path";
import { calendarContext } from "./home-dashboard.mjs";
import { isCommitSha } from "./publication-identity.mjs";
import { privateReportDirectory } from "./private-report-directory.mjs";

export async function getHomeDashboard(topN = 5, now = new Date()) {
  if (![5, 10, 20].includes(topN)) throw new Error("HOME_TOP_N_INVALID");
  const { summary, calendar } = JSON.parse(await readFile(
    path.join(privateReportDirectory(process.cwd()), "private-home-dashboard", topN + ".json"), "utf8"));
  const sha = process.env.VERCEL_GIT_COMMIT_SHA;
  if (summary.dataIdentity.commitSha && isCommitSha(sha) && summary.dataIdentity.commitSha !== sha) {
    throw new Error("HOME_RELEASE_IDENTITY_MISMATCH");
  }
  return { ...summary, dataIdentity: { ...summary.dataIdentity, commitSha: summary.dataIdentity.commitSha ?? (isCommitSha(sha) ? sha : null) },
    calendar: calendarContext(calendar, now) };
}
