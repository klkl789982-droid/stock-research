import { writeModelMaturityCoverageReport } from "../lib/model-maturity-coverage-report.mjs";

const result = await writeModelMaturityCoverageReport();
console.log(JSON.stringify({ coverageAsOfDate: result.report.coverageAsOfDate, changedPaths: result.changedPaths, models: result.report.models }, null, 2));
