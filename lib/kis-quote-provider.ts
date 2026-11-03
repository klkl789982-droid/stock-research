import "server-only";
import { kisRequest } from "./kis-token-manager";
import { createKisQuoteProvider, parseKisQuote, KisQuoteError } from "./kis-quote-provider-core.mjs";
import { latestMinuteTrade } from "./recent-kis-price.mjs";

const quotations = "https://openapi.koreainvestment.com:9443/uapi/domestic-stock/v1/quotations";
async function fetchQuote(code: string) {
  const query = new URLSearchParams({ FID_COND_MRKT_DIV_CODE: "J", FID_INPUT_ISCD: code });
  const response = await kisRequest(`${quotations}/inquire-price?${query}`, { headers: { tr_id: "FHKST01010100" } });
  if (!response.ok) throw new KisQuoteError(`KIS_HTTP_${response.status}`);
  const quote = parseKisQuote(await response.json(), code, new Date().toISOString());
  if (quote.metadataAvailability.usableForFreshness) return { ...quote, lastTrade: null };
  const kst = new Date(Date.now() + 9 * 3600000).toISOString().slice(11, 19).replaceAll(":", "");
  query.set("FID_INPUT_HOUR_1", kst > "153000" ? "153000" : kst);
  query.set("FID_ETC_CLS_CODE", "");
  query.set("FID_PW_DATA_INCU_YN", "N");
  try {
    const minute = await kisRequest(`${quotations}/inquire-time-itemchartprice?${query}`, { headers: { tr_id: "FHKST03010200" } });
    const payload = minute.ok ? await minute.json() : null;
    return { ...quote, lastTrade: latestMinuteTrade(payload, code, new Date().toISOString()) };
  } catch {
    return { ...quote, lastTrade: null };
  }
}
export const kisQuoteProvider=createKisQuoteProvider({fetchQuote,ttlMs:5000});
export async function getKisQuote(code:string){return kisQuoteProvider.getQuote(code);}
