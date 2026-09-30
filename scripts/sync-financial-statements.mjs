import fs from "node:fs/promises";
import path from "node:path";
import corpMap from "../data/corp-map.json" with { type: "json" };
import { classifyLedgerWrite, financialSourceHash, validateFinancialStatement } from "../lib/financial-statement-ledger.mjs";
import { FINANCIAL_ACCOUNT_RULES as rules, findFinancialAccountRow } from "../lib/financial-account-normalization.mjs";
import { createCagrProvenance } from "../lib/company-analysis-provenance.mjs";

const option = (name) => process.argv.find((value) => value.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
const code = option("code");
const businessYear = option("year");
const reportCode = option("report") ?? "11011";
const fsDivision = option("fs-div") ?? "CFS";
if (!/^[0-9A-Z]{6}$/u.test(code ?? "")) throw new Error("--code=6자리 종목코드가 필요합니다.");
if (!/^\d{4}$/u.test(businessYear ?? "")) throw new Error("--year=YYYY가 필요합니다.");
if (reportCode !== "11011") throw new Error("최초 vertical slice는 사업보고서(11011)만 지원합니다.");
if (!new Set(["CFS", "OFS"]).has(fsDivision)) throw new Error("--fs-div는 CFS 또는 OFS여야 합니다.");
const apiKey = process.env.DART_API_KEY;
if (!apiKey) throw new Error("DART_API_KEY가 설정되지 않았습니다.");
const company = corpMap[code];
if (!company) throw new Error("DART corp_code 매핑을 찾을 수 없습니다.");

const params = new URLSearchParams({ crtfc_key: apiKey, corp_code: company.corpCode, bsns_year: businessYear, reprt_code: reportCode, fs_div: fsDivision });
const response = await fetch(`https://opendart.fss.or.kr/api/fnlttSinglAcntAll.json?${params}`, { signal: AbortSignal.timeout(20_000) });
if (!response.ok) throw new Error(`DART_HTTP_${response.status}`);
const payload = await response.json();
if (payload.status !== "000" || !Array.isArray(payload.list)) throw new Error(`DART_BUSINESS_${payload.status ?? "UNKNOWN"}`);

const list = payload.list;
const amount = (value) => {
  if (value == null || value === "") return null;
  const parsed = Number(String(value).replaceAll(",", "").trim());
  return Number.isFinite(parsed) ? parsed : null;
};
const findRow = (rule) => findFinancialAccountRow(list, rule);
const current = (rule) => amount(findRow(rule)?.thstrm_amount);
const twoYearCagr = (rule) => {
  const row = findRow(rule); const latest = amount(row?.thstrm_amount); const twoYearsAgo = amount(row?.bfefrmtrm_amount);
  return latest != null && twoYearsAgo != null && latest > 0 && twoYearsAgo > 0 ? (Math.pow(latest / twoYearsAgo, 1 / 2) - 1) * 100 : null;
};
const operatingProfit = current(rules.operatingProfit); const interestExpense = current(rules.interestExpense);
const featureProvenance = { revenueCagr: createCagrProvenance(findRow(rules.revenue), amount), operatingProfitCagr: createCagrProvenance(findRow(rules.operatingProfit), amount) };
const normalizedAccounts = {
  revenue: current(rules.revenue), operatingProfit, netIncome: current(rules.netIncome), assets: current(rules.assets),
  liabilities: current(rules.liabilities), equity: current(rules.equity), revenueCagr: twoYearCagr(rules.revenue),
  operatingProfitCagr: twoYearCagr(rules.operatingProfit), interestExpense,
  interestCoverage: operatingProfit != null && interestExpense != null && interestExpense > 0 ? operatingProfit / interestExpense : null,
};
const required = ["revenue", "operatingProfit", "netIncome", "assets", "liabilities", "equity"];
const missing = required.filter((key) => normalizedAccounts[key] == null);
if (missing.length) throw new Error(`DART_REQUIRED_ACCOUNT_MISSING:${missing.join(",")}`);
const identity = list[0];
const receiptNumber = String(identity.rcept_no ?? "");
const filingDate = /^\d{8}/u.test(receiptNumber) ? `${receiptNumber.slice(0, 4)}-${receiptNumber.slice(4, 6)}-${receiptNumber.slice(6, 8)}` : null;
if (!filingDate) throw new Error("DART_RECEIPT_DATE_MISSING");
const statement = {
  schemaVersion: 1, code, corpCode: company.corpCode, companyName: company.corpName,
  source: { provider: "DART", endpoint: "fnlttSinglAcntAll" }, reportCode, reportName: "사업보고서", businessYear,
  fiscalPeriodEnd: `${businessYear}-12-31`, filingDate, receiptNumber, fsDivision,
  unit: identity.currency ?? "KRW", normalizedAccounts, featureProvenance, sourceHash: financialSourceHash(normalizedAccounts),
  generatedAt: new Date().toISOString(), qualityStatus: "PROVISIONAL", qualityReasons: ["singleCompanyVerticalSlice"],
};
const errors = validateFinancialStatement(statement);
if (errors.length) throw new Error(`FINANCIAL_STATEMENT_INVALID:${errors.join(",")}`);
const directory = path.join(process.cwd(), "data", "financial-statements"); const output = path.join(directory, `${code}.json`);
await fs.mkdir(directory, { recursive: true });
let ledger = null; try { ledger = JSON.parse(await fs.readFile(output, "utf8")); } catch (error) { if (error?.code !== "ENOENT") throw error; }
const existing = ledger?.statements?.find((item) => item.receiptNumber === statement.receiptNumber && item.reportCode === reportCode && item.fsDivision === fsDivision);
const action = classifyLedgerWrite(existing, statement);
if (action === "conflict") throw new Error("FINANCIAL_LEDGER_CONFLICT");
if (action !== "idempotent") {
  const statements = [...(ledger?.statements ?? []).filter((item) => !(item.receiptNumber === statement.receiptNumber && item.reportCode === reportCode && item.fsDivision === fsDivision)), statement]
    .sort((a, b) => a.filingDate.localeCompare(b.filingDate) || a.receiptNumber.localeCompare(b.receiptNumber));
  await fs.writeFile(output, `${JSON.stringify({ schemaVersion: 1, code, companyName: company.corpName, statements }, null, 2)}\n`, { flag: ledger ? "w" : "wx" });
}
console.log(JSON.stringify({ code, companyName: company.corpName, businessYear, reportCode, fsDivision, filingDate, unit: statement.unit, action, validator: "passed", fields: Object.fromEntries(Object.entries(normalizedAccounts).map(([key, value]) => [key, value != null ? "available" : "missing"])) }, null, 2));
