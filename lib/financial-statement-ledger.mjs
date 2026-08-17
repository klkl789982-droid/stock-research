import { createHash } from "node:crypto";

const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
export const financialSourceHash = (value) => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
export function validateFinancialStatement(statement) {
  const errors = [];
  if (statement?.schemaVersion !== 1) errors.push("schemaVersion");
  if (!/^\d{6}$/.test(statement?.code ?? "")) errors.push("code");
  if (!/^\d{8}$/.test(statement?.corpCode ?? "")) errors.push("corpCode");
  if (!['CFS','OFS'].includes(statement?.fsDivision)) errors.push("fsDivision");
  for (const key of ["fiscalPeriodEnd", "filingDate"]) if (!/^\d{4}-\d{2}-\d{2}$/.test(statement?.[key] ?? "")) errors.push(key);
  if (!statement?.receiptNumber || !statement?.reportCode || !statement?.businessYear) errors.push("reportIdentity");
  if (!statement?.sourceHash || statement.sourceHash !== financialSourceHash(statement.normalizedAccounts)) errors.push("sourceHash");
  if (JSON.stringify(statement).match(/crtfc_key|DART_API_KEY|access_token/i)) errors.push("secretMaterial");
  return [...new Set(errors)];
}
export function classifyLedgerWrite(existing, incoming) {
  if (!existing) return "create";
  const sameId = existing.receiptNumber === incoming.receiptNumber && existing.reportCode === incoming.reportCode && existing.fsDivision === incoming.fsDivision;
  if (sameId && existing.sourceHash === incoming.sourceHash) return "idempotent";
  if (sameId) return incoming.correctionOfReceiptNumber ? "correction" : "conflict";
  return "append";
}
