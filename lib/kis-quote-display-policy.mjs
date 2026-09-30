export function isVerifiedKisRealtimeQuote(quote) {
  return quote?.metadataAvailability?.status === "complete"
    && quote?.freshnessStatus === "freshObservation"
    && typeof quote?.asOfDate === "string"
    && quote.asOfDate.length > 0
    && typeof quote?.asOfTime === "string"
    && quote.asOfTime.length > 0;
}
