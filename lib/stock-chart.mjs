// Presentation-only adapter. Never feeds model calculation or accepts KIS data.
export const PUBLIC_PRICE_CHART_APPROVED = false;
const dateOf = (value) => /^\d{8}$/u.test(String(value)) ? `${String(value).slice(0, 4)}-${String(value).slice(4, 6)}-${String(value).slice(6, 8)}` : null;
const numeric = (value) => typeof value === "number" || (typeof value === "string" && /^\d+(?:\.\d+)?$/u.test(value)) ? Number(value) : NaN;

export function prepareOfficialChart(rows, meta) {
  if (meta?.source !== "officialDailyPrice" || meta?.priceBasis !== "officialDailyClose" || !/^[0-9A-Z]{6}$/u.test(meta?.code ?? "") || !/^\d{4}-\d{2}-\d{2}$/u.test(meta?.asOfDate ?? "")) throw new Error("CHART_OFFICIAL_PROVENANCE_REQUIRED");
  const seen = new Set();
  const bars = rows.map((row) => {
    const date = dateOf(row.basDt), code = String(row.srtnCd ?? "").replace(/^A/, "");
    const [open, high, low, close, volume] = [row.mkp, row.hipr, row.lopr, row.clpr, row.trqu].map(numeric);
    const parsed = date ? new Date(`${date}T00:00:00Z`) : null;
    if (!date || !parsed || parsed.toISOString().slice(0, 10) !== date || [0, 6].includes(parsed.getUTCDay()) || date > meta.asOfDate || seen.has(date) || code !== meta.code
      || ![open, high, low, close].every((n) => Number.isFinite(n) && n > 0) || !Number.isFinite(volume) || volume < 0 || low > Math.min(open, close) || high < Math.max(open, close) || high < low) throw new Error("CHART_BAR_INVALID");
    seen.add(date);
    return { date, open, high, low, close, volume, ma5: null, ma20: null, ma60: null };
  }).sort((a, b) => a.date.localeCompare(b.date));
  if (!bars.length || bars.at(-1).date !== meta.asOfDate || bars.at(-1).close !== meta.closePrice) throw new Error("CHART_REFERENCE_MISMATCH");
  // Causal rolling display averages, equivalent to the engine's simple means.
  for (const period of [5, 20, 60]) for (let i = period - 1; i < bars.length; i++) bars[i][`ma${period}`] = bars.slice(i - period + 1, i + 1).reduce((sum, bar) => sum + bar.close, 0) / period;
  const crosses = [];
  for (const [short, long] of [[5, 20], [20, 60]]) for (let i = 1; i < bars.length; i++) {
    const a = bars[i - 1], b = bars[i], s = `ma${short}`, l = `ma${long}`;
    if (a[s] === null || a[l] === null || b[s] === null || b[l] === null) continue;
    if (a[s] <= a[l] && b[s] > b[l]) crosses.push({ date: b.date, pair: `${short}/${long}`, direction: "golden" });
    if (a[s] >= a[l] && b[s] < b[l]) crosses.push({ date: b.date, pair: `${short}/${long}`, direction: "dead" });
  }
  return { bars, crosses, referenceDate: meta.asOfDate, source: meta.source };
}
