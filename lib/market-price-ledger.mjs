import { normalizeStockCode } from "./stock-code.mjs";

export const MARKET_PRICE_LEDGER_SCHEMA_VERSION = 2;

export function createMarketPriceLedger(date, records, tracking = {}) {
  return {
    schemaVersion: MARKET_PRICE_LEDGER_SCHEMA_VERSION,
    date,
    source: "data-go-kr-official-daily-price",
    coverage: "trackingUniverse",
    trackingUniverse: tracking.trackingUniverse ?? records.map((record) => ({ code: record.code, reasons: record.trackingReasons ?? ["currentObservedUniverse"] })),
    trackingPriceUnavailable: tracking.trackingPriceUnavailable ?? [],
    records: records.map((record) => ({
      code: normalizeStockCode(record.code),
      date,
      openPrice: record.executable === false ? null : record.openPrice,
      closePrice: record.executable === false ? null : record.closePrice,
      referenceClose: record.executable === false ? record.referenceClose ?? record.closePrice : null,
      executable: record.executable !== false,
      priceStatus: record.executable === false ? "tradingHaltOrNoTrade" : "executable",
      trackingReasons: record.trackingReasons ?? ["currentObservedUniverse"],
    })),
  };
}

export function validateMarketPriceLedger(ledger, expectedCount) {
  const errors = [];
  if (ledger.schemaVersion !== MARKET_PRICE_LEDGER_SCHEMA_VERSION) errors.push("가격 원장 schemaVersion이 올바르지 않습니다.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ledger.date ?? "")) errors.push("가격 원장 날짜 형식이 올바르지 않습니다.");
  if ((ledger.records?.length ?? 0) < expectedCount) errors.push(`가격 원장 관찰 Universe 종목 수 부족: ${ledger.records?.length ?? 0}/${expectedCount}`);
  const codes = new Set();
  for (const record of ledger.records ?? []) {
    const code = normalizeStockCode(record.code);
    if (!code) errors.push(`가격 원장 종목코드가 유효하지 않습니다: ${record.code}`);
    if (code && codes.has(code)) errors.push(`가격 원장 중복 종목: ${code}`);
    if (code) codes.add(code);
    if (record.executable === false) {
      if (record.openPrice !== null || record.closePrice !== null || !Number.isFinite(record.referenceClose) || record.referenceClose <= 0) errors.push(`${record.code} 무거래 원장 구조가 유효하지 않습니다.`);
    } else {
      if (!Number.isFinite(record.openPrice) || record.openPrice <= 0) errors.push(`${record.code} 원장 시가가 유효하지 않습니다.`);
      if (!Number.isFinite(record.closePrice) || record.closePrice <= 0) errors.push(`${record.code} 원장 종가가 유효하지 않습니다.`);
    }
  }
  return errors;
}
