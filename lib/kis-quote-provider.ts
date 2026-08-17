import "server-only";
import { kisRequest } from "./kis-token-manager";
import { createKisQuoteProvider, parseKisQuote, KisQuoteError } from "./kis-quote-provider-core.mjs";
async function fetchQuote(code:string){const response=await kisRequest(`https://openapi.koreainvestment.com:9443/uapi/domestic-stock/v1/quotations/inquire-price?FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD=${code}`,{headers:{"Content-Type":"application/json",tr_id:"FHKST01010100"}});if(!response.ok)throw new KisQuoteError(`KIS_HTTP_${response.status}`);return parseKisQuote(await response.json(),code,new Date().toISOString());}
export const kisQuoteProvider=createKisQuoteProvider({fetchQuote,ttlMs:5000});
export async function getKisQuote(code:string){return kisQuoteProvider.getQuote(code);}
