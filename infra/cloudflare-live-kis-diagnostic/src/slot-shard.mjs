import { DurableObject } from "cloudflare:workers";
import { createKisApiClient } from "../../../lib/kis-api-client-core.mjs";
import { hashIntradayModelTop } from "../../../lib/intraday-model-top-official-signal.mjs";
import { BASE, assertDiagnostic, edgeFetch, diagnosticMinuteTime, projectDiagnosticResult, safeCode, transportReason } from "../core.mjs";
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Binding-only, one security/rate-bounded symbol per runtime invocation. The
// controller grants unique 220ms grid slots; a >20ms late slot is NOT used.
// This avoids per-request cross-region permit/ack round trips without exceeding
// five actual starts/second. Source prices and bearer material stay in memory.
export class KisSlotShard extends DurableObject {
  assertInvocation() { assertDiagnostic(this.env); }
  brokerFor() { return this.env.BROKER.get(this.env.BROKER.idFromName("single-approved-kis-credential-v1")); }
  minuteQueryTime() { return diagnosticMinuteTime(Date.now()); }
  projectResult(args) { return projectDiagnosticResult(args); }
  async fetch(request, budget = { calls: 0 }) {
    this.assertInvocation();
    const u = new URL(request.url), run = u.searchParams.get("run"), code = u.searchParams.get("codes");
    if (u.pathname === "/collect-batch") {
      const codes = code?.split(",") ?? [], retryCodes = new Set((u.searchParams.get("retryCodes") ?? "").split(","));
      if (!/^[A-Za-z0-9_-]{1,48}$/u.test(run ?? "") || !codes.length || codes.length > 8 || new Set(codes).size !== codes.length || codes.some(c => !/^[0-9A-Z]{6}$/u.test(c))) return new Response(null, { status: 400 });
      const records = []; let next = 0;
      await Promise.all(Array.from({ length: Math.min(2, codes.length) }, async () => {
        while (next < codes.length) {
          const ticker = codes[next++];
          try {
            const r = await this.fetch(new Request(`https://isolated/collect?run=${run}&codes=${ticker}&dropFirst=${retryCodes.has(ticker)}`), budget);
            if (!r.ok) throw new Error("DIAG_SHARD_FAILED"); records.push(...(await r.json()).records);
          } catch (error) {
            // Settle BOTH lanes and every fixed symbol; one failed completion
            // must not leave an unobserved Promise lane running after response.
            records.push({ code: ticker, reason: safeCode(error), rawPricesStored: false, eligibleForLive: false });
          }
        }
      }));
      return Response.json({ records, rawPricesStored: false, eligibleForLive: false });
    }
    if (!/^[A-Za-z0-9_-]{1,48}$/u.test(run ?? "") || !/^[0-9A-Z]{6}$/u.test(code ?? "")) return new Response(null, { status: 400 });
    const broker = this.brokerFor(run);
    const control = async (path, body = null) => {
      const r = await broker.fetch(`https://isolated${path}${path.includes("?") ? "&" : "?"}run=${run}`, body ? { method: "POST", body: JSON.stringify(body) } : undefined), value = await r.json();
      if (!r.ok) { const e = new Error(safeCode({ code: value.reason })); if (value.transportFailure) e.sourceFailure = safeCode({ code: value.transportFailure }); throw e; }
      return value;
    };
    let lease = null, bearer = null, invalidating = Promise.resolve(), result;
    const calls = [], skipped = [], retries = [], timing = {};
    try {
      lease = await control(`/slot-pair-acquire?code=${code}`);
      if (lease.existing) return Response.json({ records: [lease.existing], rawPricesStored: false, eligibleForLive: false });
      bearer = lease.authenticationRecord;
      const available = { quote: [lease.quoteSlot], minute: [lease.minuteSlot] };
      const manager = {
        async getToken() { await invalidating; if (bearer && bearer.expiresAtMs > lease.deadline + 5000) return bearer; bearer = await control("/shared-auth"); return bearer; },
        invalidateIfCurrent(record) { bearer = null; invalidating = control("/shared-invalidate", record).then(() => {}); },
      };
      const credentials = { appKey: this.env.KIS_APP_KEY, appSecret: this.env.KIS_APP_SECRET };
      let lastFailure = null;
      const transport = async (url, init) => {
        if (calls.length >= 16 || budget.calls >= 40) throw new Error("DIAG_SHARD_EXTERNAL_BUDGET_EXHAUSTED");
        const kind = String(url).includes("inquire-price?") ? "quote" : "minute";
        let slot;
        for (let attempts = 0; attempts < 3; attempts++) {
          slot = available[kind].shift() ?? await control(`/extra-slot?code=${code}&kind=${kind}`);
          while (Date.now() < slot.notBefore) await sleep(slot.notBefore - Date.now());
          if (Date.now() <= slot.notBefore + 20) break;
          skipped.push({ slot: slot.slot, kind, reason: "MISSED_BEFORE_API_REQUEST" }); slot = null;
        }
        if (!slot) throw new Error("DIAG_RATE_SLOT_MISSED");
        const started = Date.now();
        if (started >= lease.deadline) throw new Error("DIAG_COLLECTION_DEADLINE");
        budget.calls++;
        const call = { slot: slot.slot, kind, started, completed: started, status: 0, failure: null }; calls.push(call);
        try {
          const response = await edgeFetch(url, { ...init, signal: AbortSignal.timeout(Math.max(1, Math.min(15000, lease.deadline - started))) });
          const body = await response.text(); call.completed = Date.now(); call.status = response.status;
          if (call.completed > lease.deadline) throw new Error("DIAG_COLLECTION_DEADLINE");
          timing[`${kind}RequestedAt`] = new Date(started).toISOString(); timing[`${kind}ReceivedAt`] = new Date(call.completed).toISOString();
          return new Response(body, { status: call.status, headers: response.headers });
        } catch (e) { call.completed = Date.now(); call.failure = transportReason(e); throw new Error(call.failure); }
      };
      const client = createKisApiClient({ getCredentials: () => credentials, tokenManager: manager,
        fetchImpl: (url, init) => transport(url, init).catch(e => { lastFailure = safeCode(e); throw e; }) });
      const read = async (suffix, trId) => {
        for (let attempt = 0; attempt < 2; attempt++) {
          let response;
          try { response = await client.request(`${BASE}${suffix}`, { headers: { "Content-Type": "application/json", tr_id: trId } }); }
          catch (e) {
            if (attempt === 0 && e.code === "KIS_BUSINESS_NETWORK_ERROR" && !lastFailure?.startsWith("DIAG_PLATFORM_") && !lastFailure?.includes("BUDGET") && !lastFailure?.includes("DEADLINE") && Date.now() + 1000 < lease.deadline) { await sleep(1000); continue; }
            const error = new Error(lastFailure ?? safeCode(e)); if (e.sourceFailure) error.sourceFailure = e.sourceFailure; throw error;
          }
          // Upstream500/429 responses may be HTML or empty. Parsing them first
          // used to bypass the existing bounded transient retry entirely.
          // Never retain/echo that body or call malformed200 a valid quote.
          let payload = null;
          try { payload = await response.json(); } catch { /* HTTP status still governs retries. */ }
          if (response.ok && (!payload || typeof payload.rt_cd !== "string")) throw new Error("KIS_RESPONSE_INVALID");
          if (!response.ok && calls.length) calls.at(-1).failure = `KIS_HTTP_${response.status}`;
          if (payload?.rt_cd !== "0" && /^[A-Z0-9]{3,24}$/u.test(payload?.msg_cd ?? "") && calls.length)
            calls.at(-1).failure = `KIS_BUSINESS_${payload.msg_cd}`;
          if (u.searchParams.get("dropFirst") === "true" && trId === "FHKST01010100" && attempt === 0 && response.ok && payload?.rt_cd === "0") {
            retries.push({ kind: "quote", reason: "TEST_RESPONSE_DROP", responseHash: hashIntradayModelTop(payload), requestedAt: timing.quoteRequestedAt, receivedAt: timing.quoteReceivedAt });
            if (Date.now() + 1000 >= lease.deadline) throw new Error("DIAG_COLLECTION_DEADLINE"); await sleep(1000); continue;
          }
          const retryable = response.status === 429 || response.status >= 500 || payload?.msg_cd === "EGW00201";
          if (retryable && attempt === 0 && Date.now() + 1000 < lease.deadline) {
            retries.push({ kind: trId === "FHKST01010100" ? "quote" : "minute", reason: response.ok ? "KIS_RATE_LIMITED" : `KIS_HTTP_${response.status}`,
              requestedAt: timing[`${calls.at(-1).kind}RequestedAt`], receivedAt: timing[`${calls.at(-1).kind}ReceivedAt`] });
            await sleep(1000); continue;
          }
          if (!response.ok || payload?.rt_cd !== "0") throw new Error(response.ok ? payload?.msg_cd === "EGW00201" ? "KIS_RATE_LIMITED" : "KIS_BUSINESS_ERROR" : `KIS_HTTP_${response.status}`);
          return payload;
        }
        throw new Error("DIAG_RETRY_EXHAUSTED");
      };
      const quote = await read(`/uapi/domestic-stock/v1/quotations/inquire-price?FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD=${code}`, "FHKST01010100");
      timing.minuteRequestedExchangeTime = this.minuteQueryTime(timing);
      const minute = await read(`/uapi/domestic-stock/v1/quotations/inquire-time-itemchartprice?FID_ETC_CLS_CODE=&FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD=${code}&FID_INPUT_HOUR_1=${timing.minuteRequestedExchangeTime.replaceAll(":", "")}&FID_PW_DATA_INCU_YN=N`, "FHKST03010200");
      result = this.projectResult({ quote, minute, code, timing, input: lease.record, seedReferenceDate: lease.seedReferenceDate, seedContext: lease.seedContext, signalDate: lease.signalDate });
      if (retries.length) result.retryEvidence = retries;
    } catch (e) { result = { code, reason: safeCode(e), ...(e.sourceFailure ? { sourceFailure: e.sourceFailure } : {}),
      ...(calls.length ? { failedEndpoint: calls.at(-1).kind, httpStatus: calls.at(-1).status,
        providerFailureCode: calls.at(-1).failure, inputEligible: lease?.record?.eligible === true } : {}), rawPricesStored: false, eligibleForLive: false }; }
    if (lease && !lease.existing) {
      try { await control(`/slot-pair-complete?code=${code}`, { metadata: result, calls, skipped, authHint: bearer }); }
      catch (error) {
        console.error(JSON.stringify({ event: "LIVE_COMPLETION_RECORD_FAILED", code, primaryCode: result.reason ?? "OBSERVATION_READY", recordingCode: safeCode(error) }));
        throw new Error(result.reason ?? "DIAG_COMPLETION_RECORD_FAILED");
      }
    }
    return Response.json({ records: [result], rawPricesStored: false, eligibleForLive: false });
  }
}
