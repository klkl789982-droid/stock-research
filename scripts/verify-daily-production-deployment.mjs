import { execFileSync } from "node:child_process";
import { snapshotIdentity, isCommitSha } from "../lib/publication-identity.mjs";
import fs from "node:fs/promises";
import path from "node:path";
import { waitForDailyProductionDeployment } from "../lib/daily-production-deployment-verifier.mjs";

const option = (name) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const siteUrl = option("site");
const expectedReferenceDate = option("date");
const output = option("output");
if (!siteUrl || !/^https:\/\//u.test(siteUrl)) throw new Error("--site=https://... 값이 필요합니다.");
if (!/^\d{4}-\d{2}-\d{2}$/u.test(expectedReferenceDate ?? "")) throw new Error("--date=YYYY-MM-DD 값이 필요합니다.");

const expectedCommitSha = option("commit") ?? execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
if (!isCommitSha(expectedCommitSha)) throw new Error("검증 대상 커밋 SHA가 필요합니다.");
const snapshot = JSON.parse(await fs.readFile(path.join(process.cwd(), "data", "history", `${expectedReferenceDate}.json`), "utf8"));
const expectedSnapshotHash = snapshotIdentity(snapshot)?.snapshotHash;
const result = await waitForDailyProductionDeployment({ siteUrl, expectedReferenceDate, expectedSnapshotHash, expectedCommitSha });
// Only bounded non-sensitive identity and enumerated reasons enter job metadata.
if (process.env.GITHUB_OUTPUT) await fs.appendFile(process.env.GITHUB_OUTPUT, `status=${result.status}\nreference_date=${expectedReferenceDate}\nsnapshot_hash=${expectedSnapshotHash}\ncommit_sha=${expectedCommitSha}\nreason=${result.reason ?? "NONE"}\n`);
if (output) {
  const target = path.resolve(output);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, `${JSON.stringify(result, null, 2)}\n`, "utf8");
}
console.log(`DAILY_DEPLOYMENT_RESULT_JSON=${JSON.stringify(result)}`);
if (result.status !== "VERIFIED") process.exitCode = 1;
