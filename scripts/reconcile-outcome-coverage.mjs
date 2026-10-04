import { writeOutcomeCoverageArtifacts } from "../lib/outcome-coverage-reconciliation.mjs";

const argument = process.argv.find((value) => value.startsWith("--as-of-date="));
const coverageAsOfDate = argument?.slice("--as-of-date=".length);
const result = await writeOutcomeCoverageArtifacts({ coverageAsOfDate });
console.log(JSON.stringify({ coverageAsOfDate, signalDates: result.summary.signalDates, changedPaths: result.changedPaths }, null, 2));
