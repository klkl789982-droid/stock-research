import { isVerifiedKisRealtimeQuote } from "./kis-quote-display-policy.mjs";

export const TOP_INTRADAY_POLL_MS = 60_000;

const finite = (value) => typeof value === "number" && Number.isFinite(value);

export function toTopIntradayOverlay(code, quote) {
  const trade = quote?.lastTrade;
  if (quote?.code === code && !isVerifiedKisRealtimeQuote(quote) && trade?.code === code &&
      trade.source === "KIS_MINUTE_TRADE" && finite(trade.price) && trade.price > 0 &&
      Number.isFinite(trade.at) && trade.at === Date.parse(`${trade.asOfDate}T${trade.asOfTime}+09:00`) &&
      trade.at <= Date.parse(trade.receivedAt)) {
    return { code, status: "available", price: trade.price, rate: null, asOfDate: trade.asOfDate,
      asOfTime: trade.asOfTime, receivedAt: trade.receivedAt, source: "KIS" };
  }
  if (!quote || quote.code !== code || !finite(quote.price) || quote.price <= 0 || !isVerifiedKisRealtimeQuote(quote)) {
    return { code, status: "unavailable" };
  }

  return {
    code,
    status: "available",
    price: quote.price,
    rate: finite(quote.rate) ? quote.rate : null,
    asOfDate: typeof quote.asOfDate === "string" ? quote.asOfDate : null,
    asOfTime: typeof quote.asOfTime === "string" ? quote.asOfTime : null,
    receivedAt: typeof quote.responseAt === "string" ? quote.responseAt : null,
    source: quote.source === "KIS" ? "KIS" : null,
  };
}
