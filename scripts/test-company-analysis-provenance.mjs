import assert from "node:assert/strict";
import { classifyLedgerReadFailure, createCagrProvenance, diagnosePointInTimeStatements, validateLedgerContainer } from "../lib/company-analysis-provenance.mjs";

const amount = (value) => value == null || value === "" ? null : Number(value);
assert.equal(classifyLedgerReadFailure({ code: "ENOENT" }), "missingFile");
assert.equal(classifyLedgerReadFailure(new SyntaxError("bad json")), "invalidJson");
assert.equal(classifyLedgerReadFailure(new Error("disk")), "readFailure");
assert.deepEqual(validateLedgerContainer({ schemaVersion: 1, statements: [] }), []);
assert.deepEqual(validateLedgerContainer({ schemaVersion: 1 }), ["schemaInvalid"]);
const available = createCagrProvenance({ account_id: "revenue", account_nm: "매출액", thstrm_amount: "100", bfefrmtrm_amount: "64", thstrm_nm: "2025", bfefrmtrm_nm: "2023" }, amount);
assert.equal(available.calculationStatus, "available"); assert.equal(available.accountFound, true);
assert.equal(createCagrProvenance({ thstrm_amount: "100", bfefrmtrm_amount: "" }, amount).calculationStatus, "missing");
assert.equal(createCagrProvenance({ thstrm_amount: "100", bfefrmtrm_amount: "0" }, amount).calculationStatus, "nonPositive");
const validate = (statement) => statement.valid ? [] : ["schema"];
assert.equal(diagnosePointInTimeStatements([], "2026-09-22", validate).detail, "noStatements");
assert.equal(diagnosePointInTimeStatements([{ valid: false, filingDate: "2026-01-01" }], "2026-09-22", validate).detail, "allStatementsSchemaInvalid");
assert.equal(diagnosePointInTimeStatements([{ valid: true, filingDate: "2026-10-01" }], "2026-09-22", validate).detail, "allValidStatementsAfterAnalysisDate");
console.log("company ledger·CAGR provenance 테스트 통과");
