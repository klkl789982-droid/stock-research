import { createKisTokenManager } from "../../lib/kis-token-manager-core.mjs";
import { createKisApiClient } from "../../lib/kis-api-client-core.mjs";
import { parseKisQuote, inspectKisMinuteObservation, attachKisMinuteObservation } from "../../lib/kis-quote-provider-core.mjs";
import { hashIntradayModelTop, calculateIntradayModelTopScores } from "../../lib/intraday-model-top-official-signal.mjs";
import { mergeProvisionalCandle } from "../../lib/intraday-model-b-official-signal.mjs";
import { fetchWithoutRedirects } from "../cloudflare-live-free-probe/core.mjs";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const authContext = "tight-budget-isolated-kis-auth-cache-v1";
export async function freezeDiagnosticReport({ readLocal, readRemote, build, saveLocal, validate }) {
  const local = readLocal();
  if (local) { validate(local); return local; }
  // A previous deployment may have completed the remote write but lost its
  // receipt. Restore the SAME bytes before considering a new measurement.
  const value = (await readRemote())?.value ?? await build();
  validate(value); saveLocal(value); return value;
}
function cacheKey(credentials) {
  if (!credentials.appKey || !credentials.appSecret) throw new Error("KIS_CREDENTIALS_MISSING");
  return createHash("sha256").update(authContext).update("\0").update(credentials.appSecret).digest();
}
export function sealAuthentication(record, credentials) {
  const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", cacheKey(credentials), iv);
  cipher.setAAD(Buffer.from(`${authContext}:${credentials.appKey}`));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(record), "utf8"), cipher.final()]);
  return JSON.stringify({ version: 1, iv: iv.toString("base64"), ciphertext: ciphertext.toString("base64"), tag: cipher.getAuthTag().toString("base64") });
}
export function openAuthentication(box, credentials) {
  try {
    const b = JSON.parse(box);
    if (b.version !== 1) throw new Error();
    const decipher = createDecipheriv("aes-256-gcm", cacheKey(credentials), Buffer.from(b.iv, "base64"));
    decipher.setAAD(Buffer.from(`${authContext}:${credentials.appKey}`)); decipher.setAuthTag(Buffer.from(b.tag, "base64"));
    const r = JSON.parse(Buffer.concat([decipher.update(Buffer.from(b.ciphertext, "base64")), decipher.final()]).toString("utf8"));
    if (typeof r.accessToken !== "string" || !r.accessToken.length || r.accessToken.length > 16384 || !Number.isSafeInteger(r.expiresAtMs) || !Number.isSafeInteger(r.generation)) throw new Error();
    return Object.freeze(r);
  } catch { throw new Error("DIAG_AUTH_CACHE_INTEGRITY_FAILED"); }
}

export const BASE = "https://openapi.koreainvestment.com:9443";
// Four bounded full-universe diagnostic attempts plus control/retry allowance.
// This is NOT a provider/platform limit increase; Free's hard limits stay intact.
export const DIAGNOSTIC_REQUEST_CAP = 4800;
export const quotaDay = ms => new Date(ms).toISOString().slice(0, 10);
export function advertisedMain(text) {
  // Git smart-HTTP's public ref advertisement, same transport family as the
  // existing PC's git fetch. No alternate account, proxy or elevated permission.
  const matches = [...text.matchAll(/(?:^|\n|[0-9a-f]{4})([a-f0-9]{40}) refs\/heads\/main(?=\n|\x00|$)/gu)].map(m => m[1]);
  if (matches.length !== 1) throw new Error("DIAG_EOD_COMMIT_INVALID");
  return matches[0];
}
export const safeCode = e => /^(?:KIS|PRIVATE_STORE|DIAG|LIVE_CLOUD)_[A-Z0-9_]+$/u.test(e?.code ?? e?.message ?? "") ? (e.code ?? e.message) : "DIAG_REQUEST_FAILED";
export function transportReason(error) {
  const message = String(error?.message ?? "");
  if (/too many subrequests|subrequest.*limit/iu.test(message)) return "DIAG_PLATFORM_SUBREQUEST_LIMIT";
  if (/different request|request context|I\/O.*context/iu.test(message)) return "DIAG_PLATFORM_IO_CONTEXT";
  if (/CPU time|exceeded.*CPU/iu.test(message)) return "DIAG_PLATFORM_CPU_LIMIT";
  if (error?.name === "TimeoutError" || error?.name === "AbortError") return "DIAG_TRANSPORT_TIMEOUT";
  // Whitelist known network causes only. Never persist provider error text,
  // URLs, headers or arbitrary cause fields while diagnosing unknown failures.
  const network = {
    ECONNRESET: "DIAG_TRANSPORT_CONNECTION_RESET", EPIPE: "DIAG_TRANSPORT_CONNECTION_RESET",
    ENOTFOUND: "DIAG_TRANSPORT_DNS", EAI_AGAIN: "DIAG_TRANSPORT_DNS",
    ETIMEDOUT: "DIAG_TRANSPORT_TIMEOUT", UND_ERR_CONNECT_TIMEOUT: "DIAG_TRANSPORT_TIMEOUT",
    UND_ERR_HEADERS_TIMEOUT: "DIAG_TRANSPORT_TIMEOUT", UND_ERR_BODY_TIMEOUT: "DIAG_TRANSPORT_TIMEOUT",
    UND_ERR_SOCKET: "DIAG_TRANSPORT_SOCKET", ECONNREFUSED: "DIAG_TRANSPORT_CONNECTION_REFUSED",
  };
  const known = network[error?.code] ?? network[error?.cause?.code];
  if (typeof known === "string") return known;
  if (message === "PROBE_HTTP_STATUS_UNVERIFIED") return "DIAG_HTTP_STATUS_UNVERIFIED";
  if (message === "PROBE_REDIRECT_REJECTED") return "DIAG_REDIRECT_REJECTED";
  return safeCode(error) === "DIAG_REQUEST_FAILED" ? "DIAG_UNKNOWN_TRANSPORT_FAILURE" : safeCode(error);
}
export const kst = ms => { const s = new Date(ms + 9 * 3600000).toISOString(); return { date: s.slice(0, 10), time: s.slice(11, 19) }; };
export function diagnosticMinuteTime(ms) {
  const time = kst(ms).time;
  // An explicit historical-clock query, not a backdated observation. At
  // midnight a 00:xx query returns no market rows. Retain actual request/receipt
  // times and the returned exchange date; these records can NEVER be LIVE.
  return time < "09:00:00" || time > "15:30:00" ? "15:30:00" : time;
}
export function assertDiagnostic(env, now = Date.now()) {
  if (env.LIVE_PRODUCTION_ENABLED === "true") throw new Error("DIAG_DISABLED_DURING_PRODUCTION");
  if (env.LIVE_ENABLED !== "false" || env.DIAGNOSTIC_ONLY !== "true") throw new Error("DIAG_FAIL_CLOSED");
  const t = kst(now), day = new Date(`${t.date}T00:00:00Z`).getUTCDay();
  // A management test must never compete with the still-authoritative PC.
  if (day > 0 && day < 6 && t.time >= "13:35:00" && t.time <= "14:10:00") throw new Error("DIAG_PC_COLLECTION_EXCLUSION");
}
export function metadataOnly(quotePayload, minutePayload, code, timing) {
  let quoteStatus = "VALID", quote = null;
  try { quote = parseKisQuote(quotePayload, code, timing.quoteReceivedAt); } catch (e) { quoteStatus = safeCode(e); }
  const rows = Array.isArray(minutePayload?.output2) ? minutePayload.output2 : [];
  const dates = rows.map(r => String(r.stck_bsop_date ?? "")).filter(s => /^\d{8}$/u.test(s)).sort();
  const latestDate = dates.at(-1) ?? null;
  const inspection = latestDate ? inspectKisMinuteObservation(minutePayload, { requestedDate: latestDate, requestedTime: timing.minuteRequestedExchangeTime ?? kst(Date.parse(timing.minuteRequestedAt)).time }) : null;
  return { code, ...timing, quoteStatus, quoteDate: quote?.asOfDate ?? null, quoteTime: quote?.asOfTime ?? null,
    observedDate: latestDate, timestampRows: inspection?.timestampCompleteCount ?? 0,
    minuteStatus: minutePayload?.rt_cd !== "0" ? "KIS_BUSINESS_ERROR" : inspection?.eligibleTimestampCount ? "SUCCESS" : "TIMESTAMP_UNAVAILABLE",
    responseHash: hashIntradayModelTop({ quotePayload, minutePayload }),
    rawPricesStored: false, eligibleForLive: false };
}
export function projectDiagnosticResult({ quote, minute, code, timing, input, seedReferenceDate }) {
  const value = metadataOnly(quote, minute, code, timing);
  value.companyName = input?.name ?? null;
  value.modelStatus = input ? input.eligible ? "TIMESTAMP_OR_QUOTE_UNAVAILABLE" : "EXISTING_SEED_INELIGIBLE" : "INPUT_NOT_PREPARED";
  const receivedDay = kst(Date.parse(timing.minuteReceivedAt)).date.replaceAll("-", "");
  if (input?.eligible && value.quoteStatus === "VALID" && value.observedDate && value.observedDate <= receivedDay
    && (!value.quoteDate || value.quoteDate.replaceAll("-", "") === value.observedDate)
    && value.observedDate > seedReferenceDate.replaceAll("-", "")) {
    const date = value.observedDate.replace(/^(\d{4})(\d{2})(\d{2})$/u, "$1-$2-$3");
    const observed = attachKisMinuteObservation(parseKisQuote(quote, code, timing.quoteReceivedAt), minute, { requestedDate: date, requestedTime: timing.minuteRequestedExchangeTime ?? kst(Date.parse(timing.minuteRequestedAt)).time });
    const rows = mergeProvisionalCandle(input.rows, observed);
    if (rows) { value.scores = calculateIntradayModelTopScores(rows, observed).scores; value.modelStatus = "OFF_HOURS_DIAGNOSTIC_ONLY"; }
  }
  return value;
}
// The caller supplies one credential-scoped, durable, rate-limited transport.
// Token material stays in this object's memory; never in Workflow params/results.
export function createDiagnosticClient(credentials, transport) {
  const manager = createKisTokenManager({ getCredentials: () => credentials, fetchImpl: transport });
  const client = createKisApiClient({ getCredentials: () => credentials, tokenManager: manager, fetchImpl: transport });
  return { manager, client };
}
export async function edgeFetch(input, init, fetchImpl = fetch) {
  return fetchWithoutRedirects(input, { ...init, headers: { ...init?.headers, "User-Agent": "tight-budget-isolated-kis-diagnostic" } }, fetchImpl);
}
