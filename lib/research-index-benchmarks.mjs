import { hashObject } from "./rank-backtest-engine.mjs";
import { createKisEodPrivateStore } from "./kis-eod-private-store.mjs";

// KIS domestic daily index chart. Output 2 is historical OHLC; output 1 alone cannot price a leg.
const ENDPOINT = "https://openapi.koreainvestment.com:9443/uapi/domestic-stock/v1/quotations/inquire-daily-indexchartprice";
const SERIES = { KOSPI: "0001", KOSDAQ: "1001" };
const iso = (v) => /^\d{8}$/.test(v) ? `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6)}` : null;
const positive = (v) => Number.isFinite(v) && v > 0;
const day = 86400000;
const cache = new Map();
const LEG_PREFIX = "research-index-legs-v1";
export const indexLegKey = (v) => [v.market, v.entryDate, v.exitDate].join("/");

export async function readIndexPage(market, from, to, request) {
  const code = SERIES[market], url = new URL(ENDPOINT);
  url.search = new URLSearchParams({ FID_COND_MRKT_DIV_CODE: "U", FID_INPUT_ISCD: code, FID_INPUT_DATE_1: from.replaceAll("-", ""),
    FID_INPUT_DATE_2: to.replaceAll("-", ""), FID_PERIOD_DIV_CODE: "D" });
  const response = await request(url, { headers: { tr_id: "FHKUP03500100", custtype: "P" }, signal: AbortSignal.timeout(7500) });
  if (!response.ok) throw new Error("INDEX_UNAVAILABLE");
  const payload = await response.json(), observedAt = new Date().toISOString();
  if (payload.rt_cd !== "0" || payload.output1?.bstp_cls_code !== code || !Array.isArray(payload.output2)) throw new Error("INDEX_IDENTITY_UNVERIFIED");
  return {items:payload.output2,observedAt};
}
async function getChunk(market, from, to, request) {
  const {items,observedAt}=await readIndexPage(market,from,to,request),dates=new Set(),code=SERIES[market];
  const rows = [];
  for (const item of items) {
    if (!item.stck_bsop_date) continue;
    const date = iso(item.stck_bsop_date), open = Number(item.bstp_nmix_oprc), close = Number(item.bstp_nmix_prpr);
    if (!date || !Number.isFinite(Date.parse(date)) || new Date(date + "T00:00:00Z").toISOString().slice(0, 10) !== date ||
        date < from || date > to) continue;
    if (dates.has(date)) throw new Error("INDEX_DUPLICATE_DATE");
    dates.add(date);
    if (!positive(open) || !positive(close) || Date.parse(date + "T15:30:00+09:00") > Date.parse(observedAt)) continue;
    rows.push({ market, date, open, close, observedAt, sourceHash: hashObject({ operation: "FHKUP03500100", code, date, open, close }) });
  }
  return rows;
}

/** Authenticated, derived-statistics research only. A failed market/chunk leaves a gap. */
export async function loadResearchIndexSeries(dates, request) {
  const sorted = dates.filter((v) => /^\d{4}-\d{2}-\d{2}$/.test(v)).sort();
  if (!sorted.length || !request) return [];
  const result = [];
  for (let ms = Date.parse(sorted[0]); ms <= Date.parse(sorted.at(-1)); ms += 90 * day) {
    const from = new Date(ms).toISOString().slice(0, 10), to = new Date(Math.min(ms + 89 * day, Date.parse(sorted.at(-1)))).toISOString().slice(0, 10);
    for (const market of Object.keys(SERIES)) {
      const key = [market, from, to].join("/");
      let entry = cache.get(key);
      if (!entry || entry.until < Date.now()) {
        if (cache.size > 64) cache.delete(cache.keys().next().value);
        // A cached morning response may not yet include today's close.
        const today = new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10);
        entry = { until: Date.now() + (to >= today ? 5 * 60_000 : day), task: getChunk(market, from, to, request).catch(() => []) };
        cache.set(key, entry);
      }
      const rows = await entry.task;
      if (!rows.length) entry.until = Math.min(entry.until, Date.now() + 60_000);
      result.push(...rows);
    }
  }
  return result;
}

export function deriveMarketBenchmarkLegs(series, pairs) {
  const index = new Map(series.map((row) => [row.market + row.date, row])), legs = [];
  for (const { entryDate, exitDate } of pairs) for (const market of Object.keys(SERIES)) {
    const entry = index.get(market + entryDate), exit = index.get(market + exitDate);
    if (!entry || !exit || entryDate > exitDate || !positive(entry.open) || !positive(exit.close)) continue;
    legs.push({ market, entryDate, exitDate, entryBasis: "officialDailyOpen", exitBasis: "officialDailyClose", source: "official-index",
      returnPercent: (exit.close / entry.open - 1) * 100,
      provenance: { provider: "KIS", operation: "FHKUP03500100", indexCode: SERIES[market], verified: true, observedAt: [entry.observedAt, exit.observedAt].sort().at(-1),
        sourceHash: hashObject({ entry: entry.sourceHash, exit: exit.sourceHash }) } });
  }
  return legs;
}

export function buildPrivateBenchmarkArchive(legs) {
  if (!legs.length) throw new Error("INDEX_ARCHIVE_EMPTY");
  const sorted = [...legs].sort((a, b) => indexLegKey(a).localeCompare(indexLegKey(b)));
  const body = { schema: LEG_PREFIX, through: sorted.map((v) => v.exitDate).sort().at(-1), observedAt: sorted.map((v) => v.provenance.observedAt).sort().at(-1), legs: sorted };
  return { ...body, contentHash: hashObject(body) };
}

function validateArchive(value, filename, asOf) {
  if (!value || value.schema !== LEG_PREFIX || !Array.isArray(value.legs) || !value.legs.length || value.legs.length > 1500) return false;
  const { contentHash, ...body } = value;
  if (filename !== `${value.through}-${contentHash}.json` || !/^[a-f\d]{64}$/.test(contentHash) || contentHash !== hashObject(body) ||
      !Number.isFinite(Date.parse(value.observedAt)) || Date.parse(value.observedAt) > asOf || new Set(value.legs.map(indexLegKey)).size !== value.legs.length) return false;
  return value.legs.every((v) => v.source === "official-index" && v.entryBasis === "officialDailyOpen" && v.exitBasis === "officialDailyClose" &&
    /^\d{4}-\d{2}-\d{2}$/.test(v.entryDate) && /^\d{4}-\d{2}-\d{2}$/.test(v.exitDate) && v.entryDate <= v.exitDate && v.exitDate <= value.through &&
    Object.hasOwn(SERIES, v.market) && v.provenance?.provider === "KIS" && v.provenance.operation === "FHKUP03500100" && v.provenance.indexCode === SERIES[v.market] &&
    v.provenance.verified === true && /^[a-f\d]{64}$/.test(v.provenance.sourceHash) && Number.isFinite(v.returnPercent) && v.returnPercent > -100 &&
    Date.parse(v.provenance.observedAt) >= Date.parse(v.exitDate + "T15:30:00+09:00") && Date.parse(v.provenance.observedAt) <= Date.parse(value.observedAt));
}

/** Read only precomputed index interval returns. No index OHLC is placed in the public repository. */
export async function loadPrivateBenchmarkLegs(pairs, { env = process.env, store, asOf = Date.now() } = {}) {
  try {
    const reader = store ?? createKisEodPrivateStore({ repository: env.PRIVATE_LIVE_DELIVERY_REPOSITORY, token: env.PRIVATE_LIVE_DELIVERY_READ_TOKEN });
    const entries = (await reader.listKeys(LEG_PREFIX)).filter((x) => x.type === "file" && /^\d{4}-\d{2}-\d{2}-[a-f\d]{64}\.json$/.test(x.name));
    const min = pairs.map((p) => p.entryDate).sort()[0], wanted = new Set(pairs.flatMap((v) => Object.keys(SERIES).map((market) => indexLegKey({ ...v, market }))));
    const legs = new Map();
    for (const { name } of entries.filter((e) => e.name.slice(0, 10) >= min)) {
      const artifact = (await reader.read(LEG_PREFIX + "/" + name))?.value;
      if (!validateArchive(artifact, name, asOf)) continue;
      for (const v of artifact.legs) if (wanted.has(indexLegKey(v)) && !legs.has(indexLegKey(v))) legs.set(indexLegKey(v), v);
      if (legs.size === wanted.size) break;
    }
    return [...legs.values()];
  } catch { return []; }
}
