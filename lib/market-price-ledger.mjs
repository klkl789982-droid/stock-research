export const MARKET_PRICE_LEDGER_SCHEMA_VERSION = 1;

export function createMarketPriceLedger(date, records) {
  return {
    schemaVersion: MARKET_PRICE_LEDGER_SCHEMA_VERSION,
    date,
    source: "data-go-kr-official-daily-price",
    coverage: "currentModelUniverse",
    records: records.map((record) => ({
      code: record.code,
      openPrice: record.openPrice,
      closePrice: record.closePrice,
    })),
  };
}

export function validateMarketPriceLedger(ledger, expectedCount) {
  const errors = [];
  if (ledger.schemaVersion !== MARKET_PRICE_LEDGER_SCHEMA_VERSION) errors.push("가격 원장 schemaVersion이 올바르지 않습니다.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ledger.date ?? "")) errors.push("가격 원장 날짜 형식이 올바르지 않습니다.");
  if (ledger.records?.length !== expectedCount) errors.push(`가격 원장 종목 수 불일치: ${ledger.records?.length ?? 0}/${expectedCount}`);
  const codes = new Set();
  for (const record of ledger.records ?? []) {
    if (codes.has(record.code)) errors.push(`가격 원장 중복 종목: ${record.code}`);
    codes.add(record.code);
    if (!Number.isFinite(record.openPrice) || record.openPrice <= 0) errors.push(`${record.code} 원장 시가가 유효하지 않습니다.`);
    if (!Number.isFinite(record.closePrice) || record.closePrice <= 0) errors.push(`${record.code} 원장 종가가 유효하지 않습니다.`);
  }
  return errors;
}
