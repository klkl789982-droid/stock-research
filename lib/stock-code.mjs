export const STOCK_CODE_PATTERN = /^[0-9A-Z]{6}$/u;

export function normalizeStockCode(value) {
  if (typeof value !== "string") return null;
  const code = value.length === 7 && value.startsWith("A") ? value.slice(1) : value;
  return STOCK_CODE_PATTERN.test(code) ? code : null;
}
