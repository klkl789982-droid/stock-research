// The timestamp belongs to the minute trade itself. Never timestamp the
// separate inquire-price response with a nearby (possibly different) trade.
export function latestMinuteTrade(payload, code, receivedAt) {
  if (payload?.rt_cd !== "0" || !Array.isArray(payload.output2) || !Number.isFinite(Date.parse(receivedAt))) return null;
  const symbol = payload.output1?.stck_shrn_iscd;
  if (symbol && symbol !== code) return null;
  let latest = null;
  for (const row of payload.output2) {
    const day = /^(\d{4})(\d{2})(\d{2})$/u.exec(row.stck_bsop_date);
    const time = /^([01]\d|2[0-3])([0-5]\d)([0-5]\d)$/u.exec(row.stck_cntg_hour);
    const price = Number(row.stck_prpr);
    if (!day || !time || !Number.isFinite(price) || price <= 0) continue;
    const asOfDate = day.slice(1).join("-"), asOfTime = time.slice(1).join(":");
    const at = Date.parse(`${asOfDate}T${asOfTime}+09:00`);
    if (!Number.isFinite(at) || at > Date.parse(receivedAt) ||
        new Date(at + 9 * 3600000).toISOString().slice(0, 10) !== asOfDate) continue;
    if (!latest || at > latest.at) latest = { code, price, asOfDate, asOfTime, at, receivedAt, source: "KIS_MINUTE_TRADE" };
    else if (at === latest.at && price !== latest.price) return null;
  }
  return latest;
}
