import { DurableObject } from "cloudflare:workers";
import { createKisApiClient } from "../../../lib/kis-api-client-core.mjs";
import { BASE, assertDiagnostic, edgeFetch, kst, projectDiagnosticResult, safeCode, transportReason } from "../core.mjs";
import { hashIntradayModelTop } from "../../../lib/intraday-model-top-official-signal.mjs";
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// A separate DO per symbol gives external I/O a genuine runtime
// invocation boundary. Sharing only metadata permits and an in-memory bearer
// avoids attributing a whole universe's outgoing calls to a shared async chain.
// Raw seed/price data never enter Workflow parameters/results or SQLite.
export class KisDiagnosticShard extends DurableObject {
  async fetch(request) {
    assertDiagnostic(this.env);
    const u = new URL(request.url), run = u.searchParams.get("run"), codes = u.searchParams.get("codes")?.split(",") ?? [];
    if (!/^[A-Za-z0-9_-]{1,48}$/u.test(run ?? "") || codes.length !== 1 || codes.some(c => !/^[0-9A-Z]{6}$/u.test(c))) return new Response(null, { status: 400 });
    const broker = this.env.BROKER.get(this.env.BROKER.idFromName("single-approved-kis-credential-v1"));
    const control = async (path, body = null) => {
      const response = await broker.fetch(`https://isolated${path}${path.includes("?") ? "&" : "?"}run=${run}`, body ? { method: "POST", body: JSON.stringify(body) } : undefined);
      const value = await response.json();
      if (!response.ok) {
        const error = new Error(safeCode({ code: value.reason }));
        if (value.transportFailure) error.sourceFailure = safeCode({ code: value.transportFailure });
        throw error;
      }
      return value;
    };
    let cached = null, issuing = null, invalidating = Promise.resolve(), externalRequests = 0;
    const manager = {
      async getToken() {
        await invalidating;
        if (cached && cached.expiresAtMs - Date.now() > 300000) return cached;
        issuing ??= control("/shared-auth").then(value => { cached = value; return value; }).finally(() => { issuing = null; });
        return issuing;
      },
      invalidateIfCurrent(record) { cached = null; invalidating = control("/shared-invalidate", record).then(() => {}); },
    };
    const credentials = { appKey: this.env.KIS_APP_KEY, appSecret: this.env.KIS_APP_SECRET };
    const records = await Promise.all(codes.map(async code => {
      let lease = null, result;
      try {
        lease = await control(`/pair-acquire?code=${code}`);
        if (lease.existing) return lease.existing;
        const seed = await control(`/seed-source?code=${code}`);
        const timing = {}, retryEvidence = [];
        const transport = async (url, init) => {
          if (externalRequests >= 40) throw new Error("DIAG_SHARD_EXTERNAL_BUDGET_EXHAUSTED");
          const kind = String(url).includes("inquire-price?") ? "quote" : "minute";
          const permit = await control(`/http-permit?code=${code}&kind=${kind}`);
          while (Date.now() < permit.notBefore) await sleep(permit.notBefore - Date.now());
          const started = Date.now(), timeout = Math.min(15000, Math.max(1, permit.deadline - started));
          if (started >= permit.deadline) throw new Error("DIAG_COLLECTION_DEADLINE");
          externalRequests++;
          const abort = new AbortController(), timer = setTimeout(() => abort.abort(), timeout);
          let status = 0, completed = started, failure = null;
          try {
            // Start in THIS shard's invocation, never in the global broker.
            const pending = edgeFetch(url, { ...init, signal: abort.signal });
            pending.catch(() => {}); // Awaited below; avoid an unhandled early reject while the start ack is in flight.
            // An ack records the actual start before another permit is granted.
            await control(`/http-started?id=${permit.id}&at=${started}`);
            const response = await pending, body = await response.text();
            completed = Date.now(); status = response.status;
            if (completed > permit.deadline) throw new Error("DIAG_COLLECTION_DEADLINE");
            timing[`${kind}RequestedAt`] = new Date(started).toISOString(); timing[`${kind}ReceivedAt`] = new Date(completed).toISOString();
            return new Response(body, { status, headers: response.headers });
          } catch (e) { abort.abort(); failure = transportReason(e); throw new Error(failure); }
          finally { clearTimeout(timer); await control(`/http-complete?id=${permit.id}`, { completed: status >= 100 ? completed : Date.now(), status, failure }); }
        };
        let lastFailure = null;
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
            const payload = await response.json();
            if (u.searchParams.get("dropFirst") === "true" && trId === "FHKST01010100" && attempt === 0 && response.ok && payload?.rt_cd === "0") {
              // Explicit fault injection in a diagnostic only: the original KIS
              // HTTP status remains 200. Preserve its real times/hash, discard
              // no existing observation, and make one actual bounded retry.
              retryEvidence.push({ kind: "quote", reason: "TEST_RESPONSE_DROP", responseHash: hashIntradayModelTop(payload),
                requestedAt: timing.quoteRequestedAt, receivedAt: timing.quoteReceivedAt });
              if (Date.now() + 1000 >= lease.deadline) throw new Error("DIAG_COLLECTION_DEADLINE");
              await sleep(1000); continue;
            }
            const retryable = response.status === 429 || response.status >= 500 || payload?.msg_cd === "EGW00201";
            if (retryable && attempt === 0 && Date.now() + 1000 < lease.deadline) { await sleep(1000); continue; }
            if (!response.ok || payload?.rt_cd !== "0") throw new Error(response.ok ? payload?.msg_cd === "EGW00201" ? "KIS_RATE_LIMITED" : "KIS_BUSINESS_ERROR" : `KIS_HTTP_${response.status}`);
            return payload;
          }
          throw new Error("DIAG_RETRY_EXHAUSTED");
        };
        const quote = await read(`/uapi/domestic-stock/v1/quotations/inquire-price?FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD=${code}`, "FHKST01010100");
        const minute = await read(`/uapi/domestic-stock/v1/quotations/inquire-time-itemchartprice?FID_ETC_CLS_CODE=&FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD=${code}&FID_INPUT_HOUR_1=${kst(Date.now()).time.replaceAll(":", "")}&FID_PW_DATA_INCU_YN=N`, "FHKST03010200");
        result = projectDiagnosticResult({ quote, minute, code, timing, input: seed.record, seedReferenceDate: seed.seedReferenceDate });
        if (retryEvidence.length) result.retryEvidence = retryEvidence;
      } catch (e) { result = { code, reason: safeCode(e), ...(e.sourceFailure ? { sourceFailure: e.sourceFailure } : {}), rawPricesStored: false, eligibleForLive: false }; }
      if (lease && !lease.existing) await control(`/pair-complete?code=${code}`, result);
      return result;
    }));
    return Response.json({ records, rawPricesStored: false, eligibleForLive: false });
  }
}
