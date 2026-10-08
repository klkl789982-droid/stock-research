import fs from "node:fs/promises";
import path from "node:path";
import { waitForDailyProductionDeployment } from "../lib/daily-production-deployment-verifier.mjs";

const option = (name) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const siteUrl = option("site");
const expectedReferenceDate = option("date");
const output = option("output");
if (!siteUrl || !/^https:\/\//u.test(siteUrl)) throw new Error("--site=https://... 값이 필요합니다.");
if (!/^\d{4}-\d{2}-\d{2}$/u.test(expectedReferenceDate ?? "")) throw new Error("--date=YYYY-MM-DD 값이 필요합니다.");

const result = await waitForDailyProductionDeployment({ siteUrl, expectedReferenceDate });
if (output) {
  const target = path.resolve(output);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, `${JSON.stringify(result, null, 2)}\n`, "utf8");
}
console.log(`DAILY_DEPLOYMENT_RESULT_JSON=${JSON.stringify(result)}`);
if (result.status !== "VERIFIED") process.exitCode = 1;
