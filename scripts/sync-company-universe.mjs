import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { validateFinancialStatement } from "../lib/financial-statement-ledger.mjs";

const option = (name) => process.argv.find((value) => value.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
const requestedDate = option("date"); const businessYear = option("year");
if (!/^\d{4}-\d{2}-\d{2}$/u.test(requestedDate ?? "")) throw new Error("--date=YYYY-MM-DD가 필요합니다.");
if (!/^\d{4}$/u.test(businessYear ?? "")) throw new Error("--year=YYYY가 필요합니다.");
if (!process.env.DART_API_KEY) throw new Error("DART_API_KEY가 설정되지 않았습니다.");
const root = process.cwd();
const archive = JSON.parse(await fs.readFile(path.join(root, "data", "universe-history", `${requestedDate}.json`), "utf8"));
const stocks = archive.observedUniverse ?? [];
const results = [];
const runSync = (code) => new Promise((resolve) => {
  const child = spawn(process.execPath, ["scripts/sync-financial-statements.mjs", `--code=${code}`, `--year=${businessYear}`, "--report=11011", "--fs-div=CFS"], { cwd: root, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = ""; let stderr = ""; child.stdout.on("data", (chunk) => { stdout += chunk; }); child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.on("close", (exitCode) => resolve({ exitCode, stdout, stderr }));
});
for (let index = 0; index < stocks.length; index += 1) {
  const stock = stocks[index]; const ledgerPath = path.join(root, "data", "financial-statements", `${stock.code}.json`);
  let existing = false;
  try { const ledger = JSON.parse(await fs.readFile(ledgerPath, "utf8")); existing = (ledger.statements ?? []).some((row) => row.businessYear === businessYear && row.reportCode === "11011" && row.fsDivision === "CFS" && validateFinancialStatement(row).length === 0); } catch {}
  if (existing) results.push({ code: stock.code, name: stock.name, outcome: "success", source: "existingValidatedLedger" });
  else {
    const run = await runSync(stock.code);
    if (run.exitCode === 0) results.push({ code: stock.code, name: stock.name, outcome: "success", source: "DART" });
    else {
      const message = `${run.stderr}\n${run.stdout}`;
      const category = /corp_code 매핑/u.test(message) ? "corpCode" : /DART_REQUIRED_ACCOUNT_MISSING/u.test(message) ? "normalization" : /DART_(?:HTTP|BUSINESS)|fetch failed|timeout|ETIMEDOUT/u.test(message) ? "dart" : "pipeline";
      const reason = message.match(/(?:DART_REQUIRED_ACCOUNT_MISSING:[A-Za-z,]+|DART_(?:HTTP|BUSINESS)_[A-Z0-9]+|DART corp_code 매핑을 찾을 수 없습니다|FINANCIAL_STATEMENT_INVALID:[A-Za-z,]+)/u)?.[0] ?? "syncFailed";
      results.push({ code: stock.code, name: stock.name, outcome: "failed", category, reason });
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if ((index + 1) % 25 === 0 || index + 1 === stocks.length) console.log(`[${index + 1}/${stocks.length}] success=${results.filter((item) => item.outcome === "success").length} failed=${results.filter((item) => item.outcome === "failed").length}`);
}
const report = { requestedDate, businessYear, total: stocks.length, success: results.filter((item) => item.outcome === "success").length, failed: results.filter((item) => item.outcome === "failed").length, failures: results.filter((item) => item.outcome === "failed") };
const reportPath = path.join(root, "reports", `company-financial-sync-${requestedDate}.json`); await fs.mkdir(path.dirname(reportPath), { recursive: true }); await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ ...report, failures: report.failures.length, reportPath }, null, 2));
