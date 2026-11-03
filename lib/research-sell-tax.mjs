import { sha256Canonical } from "./snapshot-quality-pipeline.mjs";

// Ordinary, non-exempt investor selling a domestic listed common share on exchange.
// Limit this dated comparison to the tax year reviewed; never project it onto other products or years.
export const SELL_TAX_2026 = {
  KOSPI: { transactionBps: 5, ruralBps: 15 },
  KOSDAQ: { transactionBps: 20, ruralBps: 0 },
};

export function taxEligibilityForStudy(universe, snapshots) {
  const stocks = [...(universe?.stocks ?? [])].sort((a,b) => a.code.localeCompare(b.code));
  const contentHash = sha256Canonical(stocks);
  const byCode = new Map(stocks.map(s => [s.code, s]));
  const dates = new Set(snapshots.filter(s => s.sourceManifest?.universe?.contentHash === contentHash).map(s => s.asOfDate));
  return (signalDate, row, exitDate) => {
    if (!dates.has(signalDate) || !/^2026-\d{2}-\d{2}$/.test(exitDate ?? "") || !(exitDate > signalDate)) return false;
    const stock = byCode.get(row.code);
    return byCode.size === stocks.length && !!stock && stock.market === row.market && Object.hasOwn(SELL_TAX_2026, row.market)
      && stock.securityGroupCode === "ST" && stock.etpProductCode === "" && stock.isSpac === false && stock.preferredStockCode === "0"
      && /^KR7[A-Z0-9]{9}$/.test(stock.isinCode);
  };
}

// Compare identical whole baskets. Never quietly drop an unverified security and reweight its peers.
export function compareSellTax({ lines, cost, eligible, applyCosts, simulate }) {
  const rate = SELL_TAX_2026.KOSPI.transactionBps + SELL_TAX_2026.KOSPI.ruralBps;
  const taxed = { ...cost, sellTaxBps: rate };
  if (cost.mode !== "USER_INPUT" || cost.sellTaxBps !== 0) return null;
  const mean = values => values.length ? values.reduce((a,b) => a+b, 0) / values.length : null;
  const without = [], withTax = [];
  let unsupportedDates = 0, unsupportedMatureLegs = 0, immatureOrMissingDates = 0, accountVerified = true;
  for (const line of lines) {
    const unknown = line.members.filter(m => !eligible(line.signalDate, m, line.exitDate));
    if (unknown.length) accountVerified = false;
    if (line.complete !== true || !line.members.every(m => Number.isFinite(m.gross))) { immatureOrMissingDates++; continue; }
    if (unknown.length) { unsupportedDates++; unsupportedMatureLegs += unknown.length; continue; }
    const basket = basis => line.members.reduce((sum, m) => sum + applyCosts(m.gross, basis), 0) * line.allocationFraction / line.capacity;
    without.push(basket(cost));
    withTax.push(basket(taxed));
  }
  // An incomplete or still-open portfolio is not a completed tax comparison.
  const account = accountVerified && without.length && !immatureOrMissingDates ? simulate(taxed) : null;
  return { dates: without.length, unsupportedDates, unsupportedMatureLegs, immatureOrMissingDates,
    meanExcluding: mean(without), meanIncluding: mean(withTax),
    totalIncluding: account?.status === "VALUED" ? account.totalReturn : null,
    drawdownIncluding: account?.status === "VALUED" ? account.maxDrawdown : null };
}
