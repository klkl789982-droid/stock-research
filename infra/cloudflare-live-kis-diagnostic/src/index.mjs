import { DurableObject, WorkflowEntrypoint } from "cloudflare:workers";
import { BASE, DIAGNOSTIC_REQUEST_CAP, quotaDay, advertisedMain, safeCode, transportReason, kst, assertDiagnostic, metadataOnly, createDiagnosticClient, edgeFetch, sealAuthentication, openAuthentication, freezeDiagnosticReport } from "../core.mjs";
import { createKisApiClient } from "../../../lib/kis-api-client-core.mjs";
import { createKisEodPrivateStore } from "../../../lib/kis-eod-private-store.mjs";
import { hashIntradayModelTop } from "../../../lib/intraday-model-top-official-signal.mjs";
import { calculateIntradayModelTopScores } from "../../../lib/intraday-model-top-official-signal.mjs";
import { mergeProvisionalCandle } from "../../../lib/intraday-model-b-official-signal.mjs";
import { parseKisQuote, attachKisMinuteObservation } from "../../../lib/kis-quote-provider-core.mjs";
import { validateIntradayMarketSeed } from "../../../lib/intraday-market-seed.mjs";
import { assertLiveSeedSession } from "../../../lib/live-seed-policy.mjs";
import { createHash } from "node:crypto";
import { FORMULA_HASHES } from "../formula-manifest.mjs";
import { parseKisHolidayResponse } from "../../../lib/kis-eod-provider.mjs";
import { assertPrivateKisEodPayload } from "../../../lib/kis-eod-private-store.mjs";
import { assertProduction, bounds, PRODUCTION_BUDGET } from "../production-core.mjs";
import { productionScheduled, assertIsolatedProductionFixture } from "./production.mjs";
import { verifyCloudSiteFixture } from "../site-fixture.mjs";
import { verifyCloudSwingFixture } from "../swing-fixture.mjs";
import { privateRequestBudget } from "../relay-budget.mjs";
export { LiveDay, LiveBatch, CloudLive } from "./production.mjs";
export { KisDiagnosticShard } from "./shard.mjs";
export { KisSlotShard } from "./slot-shard.mjs";
const sleep = ms => new Promise(r => setTimeout(r, ms));
const config = { retries: { limit: 0, delay: "1 second" }, timeout: "6 minutes" };
const runIdOk = s => /^[A-Za-z0-9_-]{1,48}$/u.test(s ?? "");
const brokerName = "single-approved-kis-credential-v1";

export class KisDiagnosticBroker extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env); this.queue = Promise.resolve(); this.active = new Set(); this.symbolActive = new Set(); this.pending = new Map(); this.failureByUrl = new Map();
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS state (id TEXT PRIMARY KEY, value INTEGER NOT NULL)");
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS calls (id INTEGER PRIMARY KEY AUTOINCREMENT, run TEXT NOT NULL, kind TEXT NOT NULL, started INTEGER NOT NULL, completed INTEGER, status INTEGER)");
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS evidence (id TEXT PRIMARY KEY, digest TEXT NOT NULL, body TEXT NOT NULL)");
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS control (id TEXT PRIMARY KEY, value TEXT NOT NULL)");
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS transport_failures (id INTEGER PRIMARY KEY, code TEXT NOT NULL)");
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS pair_leases (id TEXT PRIMARY KEY, run TEXT NOT NULL, code TEXT NOT NULL, started INTEGER NOT NULL, expires INTEGER NOT NULL, completed INTEGER NOT NULL)");
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS jobs (run TEXT NOT NULL, idx INTEGER NOT NULL, code TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL, PRIMARY KEY(run,idx))");
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS slot_pairs (id TEXT PRIMARY KEY, run TEXT NOT NULL, code TEXT NOT NULL, expires INTEGER NOT NULL, completed INTEGER NOT NULL)");
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS rate_slots (slot INTEGER PRIMARY KEY, run TEXT NOT NULL, code TEXT NOT NULL, kind TEXT NOT NULL, call_id INTEGER, skipped INTEGER NOT NULL)");
    this.pairQueue = Promise.resolve(); this.permitQueue = Promise.resolve(); this.pairNotifiers = new Set();
    this.pinnedAuth = new Map();
    const transport = (url, init) => this.transport(url, init).catch(e => { this.lastTransportFailure = transportReason(e); this.failureByUrl.set(String(url), this.lastTransportFailure); throw e; });
    const c = createDiagnosticClient({ appKey: env.KIS_APP_KEY, appSecret: env.KIS_APP_SECRET }, transport);
    this.manager = c.manager; this.currentRun = "authentication";
    this.credentials = { appKey: env.KIS_APP_KEY, appSecret: env.KIS_APP_SECRET };
    this.client = createKisApiClient({ getCredentials: () => this.credentials, fetchImpl: transport,
      tokenManager: { getToken: () => this.sharedAuth(this.currentRun), invalidateIfCurrent: r => this.invalidateAuthentication(r) } });
  }
  state(id) { return this.ctx.storage.sql.exec("SELECT value FROM state WHERE id=?", id).toArray()[0]?.value ?? 0; }
  set(id, n) { this.ctx.storage.sql.exec("INSERT OR REPLACE INTO state VALUES (?,?)", id, n); }
  async livePrepare(date) {
    assertProduction(this.env);
    if (kst(Date.now()).date !== date || Date.now() >= bounds(date).start) throw new Error("LIVE_CLOUD_INPUT_LATE");
    this.currentRun = `live-${date}`; this.deadline = null;
    const token = await this.sharedAuth(this.currentRun);
    if (token.expiresAtMs <= bounds(date).end + 60000) throw new Error("LIVE_CLOUD_AUTH_TTL");
    const response = await this.client.request(`${BASE}/uapi/domestic-stock/v1/quotations/chk-holiday?BASS_DT=${date.replaceAll("-", "")}&CTX_AREA_FK=&CTX_AREA_NK=`, { headers: { "Content-Type": "application/json", tr_id: "CTCA0903R" } });
    if (!response.ok || parseKisHolidayResponse(await response.json(), date, new Date().toISOString()).isTradingDay !== true) throw new Error("LIVE_CLOUD_NOT_TRADING_DAY");
    const value = await this.inputs();
    if (value.readiness !== "READY" || value.targetDate !== date || Date.now() >= bounds(date).start) throw new Error("LIVE_CLOUD_INPUT_NOT_READY");
    // Retain all immutable records. Reserve the measured day cap rather than assuming daily
    // quota reset releases SQL storage; stop below4GB, with no automatic delete.
    if (!this.state(`capacity:${date}`)) {
      const reserved = this.state("liveCapacityReserved") || 100000000;
      if (reserved + PRODUCTION_BUDGET.retainedBytesPerDay >= 4000000000) throw new Error("LIVE_CLOUD_ACCOUNT_STORAGE_BUDGET");
      this.set("liveCapacityReserved", reserved + PRODUCTION_BUDGET.retainedBytesPerDay); this.set(`capacity:${date}`, 1);
    }
    return { ...value, codes: this.seed.records.map(r => r.code), eligibleCodes: this.seed.records.filter(r => r.eligible).map(r => r.code) };
  }
  async liveBundle(date, prepared, code) {
    assertProduction(this.env);
    if (kst(Date.now()).date !== date || prepared?.targetDate !== date || prepared.readiness !== "READY"
      || !Number.isFinite(Date.parse(prepared.readyAt)) || Date.parse(prepared.readyAt) >= bounds(date).start || !/^[a-f0-9]{40}$/u.test(prepared.inputCommit ?? "")
      || !/^[a-f0-9]{64}$/u.test(prepared.seedHash ?? "")) throw new Error("LIVE_CLOUD_PIN_INVALID");
    if (this.seed?.contentHash !== prepared.seedHash) {
      const r = await edgeFetch(`https://raw.githubusercontent.com/klkl789982-droid/stock-research/${prepared.inputCommit}/data/analysis/market-seeds/${prepared.seedReferenceDate}.json`, { signal: AbortSignal.timeout(15000), cache: "no-store" });
      if (!r.ok) throw new Error("LIVE_CLOUD_PIN_UNAVAILABLE");
      const seed = await r.json();
      if (validateIntradayMarketSeed(seed, 553).length || seed.contentHash !== prepared.seedHash) throw new Error("LIVE_CLOUD_PIN_INVALID");
      this.seed = seed; this.seedByCode = new Map(seed.records.map(row => [row.code, row]));
    }
    const sealed = this.ctx.storage.sql.exec("SELECT value FROM control WHERE id='sealedAuth'").toArray()[0]?.value;
    if (!sealed) throw new Error("LIVE_CLOUD_AUTH_NOT_PREPARED");
    const authenticationRecord = openAuthentication(sealed, this.credentials);
    if (authenticationRecord.expiresAtMs <= bounds(date).end + 5000) throw new Error("LIVE_CLOUD_AUTH_TTL");
    const record = this.seedByCode.get(code); if (!record) throw new Error("LIVE_CLOUD_CODES_INVALID");
    return { record, authenticationRecord, seedContext: { requestedDate: this.seed.requestedDate, generatedAt: this.seed.generatedAt,
      contentHash: this.seed.contentHash, sourceManifest: this.seed.sourceManifest } };
  }
  async sharedAuth(run) {
    this.currentRun = run;
    const deadline = this.state(`run:${run}`) ? this.state(`run:${run}`) + 300000 : Date.now() + 360000;
    const pinned = this.pinnedAuth.get(run);
    if (pinned && pinned.expiresAtMs > deadline + 5000) return pinned;
    const sealed = this.ctx.storage.sql.exec("SELECT value FROM control WHERE id='sealedAuth'").toArray()[0]?.value;
    if (sealed) {
      const restored = openAuthentication(sealed, this.credentials);
      if (restored.expiresAtMs > deadline + 5000) { this.set("knownAuthExpiry", restored.expiresAtMs); this.pinnedAuth.set(run, restored); return restored; }
    }
    const record = await this.manager.getToken();
    this.set("knownAuthExpiry", record.expiresAtMs);
    if (record.expiresAtMs <= deadline + 5000) throw new Error("DIAG_AUTH_TTL_TOO_SHORT");
    this.ctx.storage.sql.exec("INSERT OR REPLACE INTO control VALUES ('sealedAuth',?)", sealAuthentication(record, this.credentials));
    this.pinnedAuth.set(run, record);
    return record;
  }
  invalidateAuthentication(record) {
    const sealed = this.ctx.storage.sql.exec("SELECT value FROM control WHERE id='sealedAuth'").toArray()[0]?.value;
    if (sealed) {
      const current = openAuthentication(sealed, this.credentials);
      if (current.accessToken !== record?.accessToken || current.generation !== record?.generation) return false;
      this.ctx.storage.sql.exec("DELETE FROM control WHERE id='sealedAuth'");
    }
    for (const [run, value] of this.pinnedAuth) if (value.accessToken === record?.accessToken && value.generation === record?.generation) this.pinnedAuth.delete(run);
    this.manager.invalidateIfCurrent(record); return true;
  }
  reserveSlot(run, code, kind, minimum, advance = true) {
    const countKey = `requests:${quotaDay(Date.now())}`;
    if (this.state(countKey) >= DIAGNOSTIC_REQUEST_CAP) throw new Error("DIAG_DAILY_REQUEST_BUDGET_EXHAUSTED");
    if (this.ctx.storage.sql.databaseSize >= 8_000_000) throw new Error("DIAG_STORAGE_BUDGET_EXHAUSTED");
    let slot = Math.max(minimum, Math.ceil((Date.now() + 750) / 220), advance ? this.state("slotHead") : 0);
    while (slot % 20 === 0 || this.ctx.storage.sql.exec("SELECT slot FROM rate_slots WHERE slot=?", slot).toArray().length) slot++;
    if (!this.state(`run:${run}`)) this.set(`run:${run}`, slot * 220);
    const deadline = this.state(`run:${run}`) + 300000;
    if (slot * 220 + 20 >= deadline) throw new Error("DIAG_COLLECTION_DEADLINE");
    this.ctx.storage.sql.exec("INSERT INTO rate_slots VALUES (?,?,?,?,NULL,0)", slot, run, code, kind);
    this.set(countKey, this.state(countKey) + 1); if (advance) this.set("slotHead", slot + 1);
    return { slot, notBefore: slot * 220 };
  }
  async launchJobs(run, limit = 1) {
    // Batch plans already created every fixed child id. Per-symbol completion
    // must not introduce 553 serial Workflow-create RPCs into the quote window.
    if (this.state(`batchPlan:${run}`)) return;
    const started = this.state(`run:${run}`);
    if (started && Date.now() >= started + 300000) return;
    const active = this.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM jobs WHERE run=? AND status IN ('STARTING','LAUNCHED')", run).one().n;
    const rows = this.ctx.storage.sql.exec("SELECT idx,code FROM jobs WHERE run=? AND status IN ('PENDING','LAUNCH_FAILED') AND attempts<3 ORDER BY idx LIMIT ?", run, Math.max(0, Math.min(limit, 64 - active))).toArray();
    const claimedRows = [];
    for (const row of rows) {
      const claimed = this.ctx.storage.sql.exec("UPDATE jobs SET status='STARTING',attempts=attempts+1 WHERE run=? AND idx=? AND status IN ('PENDING','LAUNCH_FAILED') AND attempts<3 RETURNING idx", run, row.idx).toArray();
      if (!claimed.length) continue;
      claimedRows.push(row);
    }
    const definition = row => ({ id: `${run}-${row.idx}`, params: { mode: "shard", runId: run, codes: [row.code],
      retryProbe: this.state(`retryProbe:${run}`) === 1 && row.idx % 10 === 0 } });
    if (claimedRows.length > 1) {
      try {
        await this.env.DIAGNOSTIC.createBatch(claimedRows.map(definition));
        for (const row of claimedRows) this.ctx.storage.sql.exec("UPDATE jobs SET status='LAUNCHED' WHERE run=? AND idx=? AND status='STARTING'", run, row.idx);
        return;
      } catch { /* Resolve every same ID below, with bounded attempts. */ }
    }
    for (const row of claimedRows.slice(16)) this.ctx.storage.sql.exec("UPDATE jobs SET status='LAUNCH_FAILED' WHERE run=? AND idx=? AND status='STARTING'", run, row.idx);
    for (const row of claimedRows.slice(0, 16)) {
      const id = `${run}-${row.idx}`; let created = false;
      try { await this.env.DIAGNOSTIC.create(definition(row)); created = true; }
      catch {
        // A lost create response is not license to start another observation.
        // Inspect the SAME fixed ID; never replace a previously created run.
        try { const instance = await this.env.DIAGNOSTIC.get(id), s = await instance.status(); created = ["queued", "running", "waiting", "complete", "errored", "paused", "waitingForPause", "waitingForResume", "terminated"].includes(s.status); } catch { /* bounded later repair */ }
      }
      this.ctx.storage.sql.exec("UPDATE jobs SET status=? WHERE run=? AND idx=? AND status='STARTING'", created ? "LAUNCHED" : "LAUNCH_FAILED", run, row.idx);
    }
  }
  async inputs() {
    const read = async url => { const r = await edgeFetch(url, { signal: AbortSignal.timeout(15000), cache: "no-store" }); if (!r.ok) { await r.body?.cancel(); throw new Error(`DIAG_EOD_HTTP_${r.status}`); } return r.text(); };
    const inputCommit = advertisedMain(await read("https://github.com/klkl789982-droid/stock-research.git/info/refs?service=git-upload-pack"));
    const rawBase = `https://raw.githubusercontent.com/klkl789982-droid/stock-research/${inputCommit}`;
    const production = JSON.parse(await read(`${rawBase}/data/daily-production-status/latest.json`));
    const date = production.lastOfficialEodDate;
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(date ?? "") || production.publishedReferenceDate !== date || production.snapshotIdentity?.referenceDate !== date) throw new Error("DIAG_EOD_STATUS_INCONSISTENT");
    const seed = JSON.parse(await read(`${rawBase}/data/analysis/market-seeds/${date}.json`));
    if (seed.requestedDate !== date) throw new Error("DIAG_EOD_DATE_MISMATCH");
    if (validateIntradayMarketSeed(seed, 553).length) throw new Error("DIAG_EOD_SEED_INVALID");
    for (const [file, expected] of Object.entries(FORMULA_HASHES)) {
      const text = (await read(`${rawBase}/${file}`)).replaceAll("\r\n", "\n");
      if (createHash("sha256").update(text).digest("hex") !== expected) throw new Error("DIAG_FORMULA_MISMATCH");
    }
    for (const [v, f] of Object.entries({ "A-v1": "lib/technical-strength.mjs", "B-v1": "lib/trend-strength.mjs", "C-v1": "lib/entry-strength.mjs", "D-v1": "lib/combined-technical-score.mjs" }))
      if (seed.sourceManifest?.modelFormulaHashes?.[v] !== FORMULA_HASHES[f]) throw new Error("DIAG_SEED_FORMULA_MISMATCH");
    const calendar = JSON.parse(await read(`${rawBase}/data/trading-calendar/status.json`));
    const calendarEvidence = this.ctx.storage.sql.exec("SELECT body FROM evidence WHERE id=?", `calendar:${kst(Date.now()).date}`).toArray().map(r => JSON.parse(r.body))[0];
    for (const entry of calendarEvidence?.dates ?? []) {
      const fields = entry.sourceFields;
      if (entry.source !== "KIS" || entry.operation !== "chk-holiday" || fields?.bass_dt !== entry.referenceDate.replaceAll("-", "")
        || !Number.isFinite(Date.parse(entry.receivedAt)) || Date.parse(entry.receivedAt) > Date.now()) continue;
      if (fields.opnd_yn === "Y" && fields.tr_day_yn === "Y" && entry.status === "tradingDay")
        calendar.dates[entry.referenceDate] = { status: "tradingDay", observedBasDt: entry.referenceDate };
      else if (fields.opnd_yn === "N" && fields.tr_day_yn === "N" && entry.status === "marketClosed")
        calendar.dates[entry.referenceDate] = { status: "marketClosed" };
    }
    const today = kst(Date.now()).date, next = new Date(`${today}T00:00:00Z`);
    while ([0, 6].includes(next.getUTCDay())) next.setUTCDate(next.getUTCDate() + 1);
    const target = next.toISOString().slice(0, 10);
    let readiness = "READY", reason = null;
    try { assertLiveSeedSession(seed, target, calendar); } catch (e) { readiness = "BLOCKED"; reason = /^LIVE_INPUT_[A-Z_]+$/u.test(e.message) ? e.message : "DIAG_EOD_NOT_READY"; }
    // Raw history is memory-only. Eviction requires fresh preparation, not a
    // retrospective reconstruction of a supposedly available LIVE input.
    this.seed = seed; this.seedByCode = new Map(seed.records.map(r => [r.code, r]));
    this.inputEvidence = { inputCommit, seedHash: seed.contentHash, seedReferenceDate: seed.requestedDate, headResolution: "PUBLIC_GIT_SMART_HTTP",
      remoteCheckedAt: new Date().toISOString(), targetDate: target, readiness, reason, universe: seed.records.length,
      eligible: seed.records.filter(r => r.eligible).length, formulaHashesVerified: true, rawSeedPersisted: false };
    return this.inputEvidence;
  }
  async transport(url, init) {
    const kind = String(url).includes("tokenP") ? "auth" : String(url).includes("chk-holiday?") ? "calendar" : String(url).includes("inquire-price?") ? "quote" : "minute";
    const reserved = this.permitQueue.then(async () => {
      if (this.startAck) await this.startAck.promise;
      if (this.state("pendingAck") || this.ackUnknown) throw new Error("DIAG_START_ACK_UNKNOWN");
      if (this.platformBlock) throw new Error(this.platformBlock);
      while (this.active.size >= 2) await Promise.race(this.active);
      const today = quotaDay(Date.now()), countKey = `requests:${today}`;
      if (this.state(countKey) >= DIAGNOSTIC_REQUEST_CAP) throw new Error("DIAG_DAILY_REQUEST_BUDGET_EXHAUSTED");
      // Local guard is deliberately well below platform free storage. Do not
      // erase immutable evidence or silently acquire a paid plan at the cap.
      const bytes = this.ctx.storage.sql.databaseSize;
      if (!Number.isFinite(bytes)) throw new Error("DIAG_STORAGE_USAGE_UNVERIFIED");
      if (bytes >= 8_000_000) throw new Error("DIAG_STORAGE_BUDGET_EXHAUSTED");
      while (Date.now() < this.state("lastStart") + 200) await sleep(this.state("lastStart") + 200 - Date.now());
      const started = Date.now();
      if (this.deadline && started >= this.deadline) throw new Error("DIAG_COLLECTION_DEADLINE");
      if (kind === "auth" && started - this.state("lastAuth") < 61000) throw new Error("DIAG_AUTH_REISSUE_COOLDOWN");
      if (kind === "auth") this.set("lastAuth", started);
      this.set("lastStart", started); this.set(countKey, this.state(countKey) + 1);
      const callId = this.ctx.storage.sql.exec("INSERT INTO calls(run,kind,started) VALUES (?,?,?) RETURNING id", this.currentRun, kind, started).one().id;
      const timeout = Math.min(15000, Math.max(1, (this.deadline ?? started + 15000) - started));
      let release;
      const slot = new Promise(resolve => { release = resolve; });
      this.active.add(slot);
      return { started, callId, timeout, slot, release };
    });
    this.permitQueue = reserved.then(() => {}, () => {});
    const lease = await reserved;
    // IMPORTANT: the shared queue reserves starts only. External I/O begins in
    // this caller continuation, not inside a cross-request Promise chain. This
    // preserves the actual Free subrequest boundary of each eight-symbol shard.
    try {
      if (kind === "auth" && this.state(`run:${this.currentRun}`) && Date.now() < this.state(`run:${this.currentRun}`) + 300000
        && this.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM slot_pairs WHERE run=? AND completed=0 AND expires>?", this.currentRun, Date.now()).one().n) {
        // Every twentieth grid cell is excluded from market calls for a rare
        // real 401 refresh. Keep authentication in the same five-start budget.
        let cell = Math.ceil((Date.now() + 50) / 220); while (cell % 20 !== 0) cell++;
        while (Date.now() < cell * 220) await sleep(cell * 220 - Date.now());
        if (Date.now() > cell * 220 + 20) throw new Error("DIAG_AUTH_RATE_SLOT_MISSED");
        lease.started = Date.now(); this.set("lastStart", lease.started);
        this.ctx.storage.sql.exec("UPDATE calls SET started=? WHERE id=?", lease.started, lease.callId);
      }
      const response = await edgeFetch(url, { ...init, signal: AbortSignal.timeout(lease.timeout) });
      const body = await response.text(), received = Date.now();
      this.ctx.storage.sql.exec("UPDATE calls SET completed=?,status=? WHERE id=?", received, response.status, lease.callId);
      if (this.deadline && received > this.deadline) throw new Error("DIAG_COLLECTION_DEADLINE");
      const headers = new Headers(response.headers);
      headers.set("X-TB-Requested-At", new Date(lease.started).toISOString()); headers.set("X-TB-Received-At", new Date(received).toISOString());
      return new Response(body, { status: response.status, headers });
    } catch (e) {
      this.ctx.storage.sql.exec("UPDATE calls SET completed=?,status=0 WHERE id=? AND completed IS NULL", Date.now(), lease.callId);
      const code = transportReason(e);
      this.ctx.storage.sql.exec("INSERT OR REPLACE INTO transport_failures VALUES (?,?)", lease.callId, code);
      if (code.startsWith("DIAG_PLATFORM_")) this.platformBlock = code;
      throw new Error(code);
    } finally { this.active.delete(lease.slot); lease.release(); }
  }
  store(id, value) {
    const body = JSON.stringify(value), digest = hashIntradayModelTop(value);
    const prior = this.ctx.storage.sql.exec("SELECT digest FROM evidence WHERE id=?", id).toArray()[0];
    if (prior && prior.digest !== digest) throw new Error("DIAG_IMMUTABLE_CONFLICT");
    if (!prior) this.ctx.storage.sql.exec("INSERT INTO evidence VALUES (?,?,?)", id, digest, body);
    return value;
  }
  async collect(code) {
    // Preserve the Node executor's two SYMBOL workers, not merely two HTTP
    // requests. Otherwise hundreds of quote calls can queue ahead of their
    // matching minute timestamps and falsely associate widely separated times.
    while (this.symbolActive.size >= 2) await Promise.race(this.symbolActive);
    const operation = this.collectPair(code), slot = operation.then(() => {}, () => {});
    this.symbolActive.add(slot);
    try { return await operation; } finally { this.symbolActive.delete(slot); }
  }
  async collectPair(code) {
    const timing = {};
    async function read(self, kind, suffix, trId) {
      for (let attempt = 0; attempt < 2; attempt++) {
        let response;
        try { response = await self.client.request(`${BASE}${suffix}`, { headers: { "Content-Type": "application/json", tr_id: trId } }); }
        catch (e) {
          if (attempt === 0 && e.code === "KIS_BUSINESS_NETWORK_ERROR" && !self.lastTransportFailure?.startsWith("DIAG_PLATFORM_") && self.lastTransportFailure !== "DIAG_COLLECTION_DEADLINE"
            && Date.now() + 1000 < self.deadline) { await sleep(1000); continue; }
          const reason = self.failureByUrl.get(`${BASE}${suffix}`);
          throw reason ? new Error(reason) : e;
        }
        const payload = await response.json();
        const retryable = response.status === 429 || response.status >= 500 || payload?.msg_cd === "EGW00201";
        if (retryable && attempt === 0 && Date.now() + 1000 < self.deadline) { await sleep(1000); continue; }
        if (!response.ok || payload?.rt_cd !== "0") throw new Error(response.ok ? payload?.msg_cd === "EGW00201" ? "KIS_RATE_LIMITED" : "KIS_BUSINESS_ERROR" : `KIS_HTTP_${response.status}`);
        timing[`${kind}RequestedAt`] = response.headers.get("X-TB-Requested-At");
        timing[`${kind}ReceivedAt`] = response.headers.get("X-TB-Received-At");
        return payload;
      }
      throw new Error("DIAG_RETRY_EXHAUSTED");
    }
    const quote = await read(this, "quote", `/uapi/domestic-stock/v1/quotations/inquire-price?FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD=${code}`, "FHKST01010100");
    const minute = await read(this, "minute", `/uapi/domestic-stock/v1/quotations/inquire-time-itemchartprice?FID_ETC_CLS_CODE=&FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD=${code}&FID_INPUT_HOUR_1=${kst(Date.now()).time.replaceAll(":", "")}&FID_PW_DATA_INCU_YN=N`, "FHKST03010200");
    const value = metadataOnly(quote, minute, code, timing);
    const input = this.seedByCode?.get(code);
    value.companyName = input?.name ?? null;
    value.modelStatus = input ? input.eligible ? "TIMESTAMP_OR_QUOTE_UNAVAILABLE" : "EXISTING_SEED_INELIGIBLE" : "INPUT_NOT_PREPARED";
    const receivedDay = kst(Date.parse(timing.minuteReceivedAt)).date.replaceAll("-", "");
    if (input?.eligible && value.quoteStatus === "VALID" && value.observedDate && value.observedDate <= receivedDay
      && (!value.quoteDate || value.quoteDate.replaceAll("-", "") === value.observedDate)
      && value.observedDate > this.seed.requestedDate.replaceAll("-", "")) {
      const date = value.observedDate.replace(/^(\d{4})(\d{2})(\d{2})$/u, "$1-$2-$3");
      const observed = attachKisMinuteObservation(parseKisQuote(quote, code, timing.quoteReceivedAt), minute, { requestedDate: date, requestedTime: kst(Date.parse(timing.minuteRequestedAt)).time });
      const rows = mergeProvisionalCandle(input.rows, observed);
      if (rows) { value.scores = calculateIntradayModelTopScores(rows, observed).scores; value.modelStatus = "OFF_HOURS_DIAGNOSTIC_ONLY"; }
    }
    return value;
  }
  async fetch(request) {
    try {
      assertDiagnostic(this.env);
      const u = new URL(request.url), run = u.searchParams.get("run");
      if (!runIdOk(run)) throw new Error("DIAG_RUN_ID_INVALID");
      if (u.pathname === "/slot-pair-acquire") {
        const code = u.searchParams.get("code"), key = `${run}:${code}`;
        if (!/^[0-9A-Z]{6}$/u.test(code ?? "")) throw new Error("DIAG_CODES_INVALID");
        const activeRun = this.ctx.storage.sql.exec("SELECT value FROM control WHERE id='activeRun'").toArray()[0]?.value;
        if (activeRun && activeRun !== run && this.state(`run:${activeRun}`) && Date.now() < this.state(`run:${activeRun}`) + 300000) throw new Error("DIAG_ANOTHER_RUN_ACTIVE");
        this.ctx.storage.sql.exec("INSERT OR REPLACE INTO control VALUES ('activeRun',?)", run);
        const operation = this.pairQueue.then(async () => {
          const previous = this.ctx.storage.sql.exec("SELECT body,digest FROM evidence WHERE id=?", key).toArray()[0];
          if (previous) { const value = JSON.parse(previous.body); if (hashIntradayModelTop(value) !== previous.digest) throw new Error("DIAG_HASH_MISMATCH"); this.ctx.storage.sql.exec("UPDATE jobs SET status='COMPLETE' WHERE run=? AND code=?", run, code); return { existing: value }; }
          if (this.ctx.storage.sql.exec("SELECT id FROM slot_pairs WHERE id=?", key).toArray().length) throw new Error("DIAG_INTERRUPTED_PAIR_REQUIRES_REVIEW");
          while (true) {
            const active = this.ctx.storage.sql.exec("SELECT expires FROM slot_pairs WHERE completed=0 AND expires>?", Date.now()).toArray();
            if (active.length < 8) break;
            let resolve, timer; const notification = new Promise(r => { resolve = r; timer = setTimeout(r, Math.max(1, Math.min(...active.map(row => row.expires)) - Date.now())); });
            this.pairNotifiers.add(resolve); await notification; clearTimeout(timer); this.pairNotifiers.delete(resolve);
          }
          const seedResponse = await this.fetch(new Request(`https://isolated/seed-source?run=${run}&code=${code}`));
          if (!seedResponse.ok) throw new Error((await seedResponse.json()).reason);
          const seed = await seedResponse.json(), authenticationRecord = await this.sharedAuth(run);
          const quoteSlot = this.reserveSlot(run, code, "quote", 0), minuteSlot = this.reserveSlot(run, code, "minute", quoteSlot.slot + 3, false);
          const deadline = this.state(`run:${run}`) + 300000;
          this.ctx.storage.sql.exec("INSERT INTO slot_pairs VALUES (?,?,?,?,0)", key, run, code, Math.min(deadline, Date.now() + 65000));
          return { ...seed, authenticationRecord, quoteSlot, minuteSlot, deadline };
        });
        this.pairQueue = operation.then(() => {}, () => {}); return Response.json(await operation);
      }
      if (u.pathname === "/extra-slot") {
        const code = u.searchParams.get("code"), kind = u.searchParams.get("kind");
        const lease = this.ctx.storage.sql.exec("SELECT expires FROM slot_pairs WHERE id=? AND completed=0", `${run}:${code}`).toArray()[0];
        if (!lease || lease.expires <= Date.now() || !["quote", "minute"].includes(kind)) throw new Error("DIAG_PAIR_LEASE_INVALID");
        return Response.json(this.reserveSlot(run, code, kind, 0));
      }
      if (u.pathname === "/slot-pair-complete") {
        const code = u.searchParams.get("code"), key = `${run}:${code}`, value = await request.json(), metadata = value.metadata;
        const lease = this.ctx.storage.sql.exec("SELECT id FROM slot_pairs WHERE id=?", key).toArray()[0];
        if (!lease || metadata?.code !== code || metadata.rawPricesStored !== false || metadata.eligibleForLive !== false || !Array.isArray(value.calls) || value.calls.length > 16 || !Array.isArray(value.skipped) || value.skipped.length > 16) throw new Error("DIAG_METADATA_INVALID");
        assertPrivateKisEodPayload(metadata);
        const inspect = node => { if (!node || typeof node !== "object") return; for (const [k, child] of Object.entries(node)) { if (["price", "volume", "open", "high", "low", "close", "rows", "output", "output2", "payload"].includes(k)) throw new Error("DIAG_RAW_STORAGE_REJECTED"); inspect(child); } }; inspect(metadata);
        for (const call of value.calls) {
          const reserved = this.ctx.storage.sql.exec("SELECT kind,call_id FROM rate_slots WHERE slot=? AND run=? AND code=?", call.slot, run, code).toArray()[0];
          if (!reserved || reserved.kind !== call.kind || !Number.isSafeInteger(call.started) || call.started < call.slot * 220 || call.started > call.slot * 220 + 20 || !Number.isSafeInteger(call.completed) || call.completed < call.started || !Number.isInteger(call.status) || (call.status !== 0 && (call.status < 100 || call.status > 599))) throw new Error("DIAG_RATE_SLOT_EVIDENCE_INVALID");
          if (!reserved.call_id) {
            const id = this.ctx.storage.sql.exec("INSERT INTO calls(run,kind,started,completed,status) VALUES (?,?,?,?,?) RETURNING id", run, call.kind, call.started, call.completed, call.status).one().id;
            this.ctx.storage.sql.exec("UPDATE rate_slots SET call_id=? WHERE slot=?", id, call.slot);
            if (call.failure) this.ctx.storage.sql.exec("INSERT INTO transport_failures VALUES (?,?)", id, safeCode({ code: call.failure }));
          } else {
            const prior = this.ctx.storage.sql.exec("SELECT started,completed,status FROM calls WHERE id=?", reserved.call_id).one();
            if (prior.started !== call.started || prior.completed !== call.completed || prior.status !== call.status) throw new Error("DIAG_HTTP_METADATA_CONFLICT");
          }
        }
        for (const item of value.skipped) {
          if (item.reason !== "MISSED_BEFORE_API_REQUEST") throw new Error("DIAG_METADATA_INVALID");
          this.ctx.storage.sql.exec("UPDATE rate_slots SET skipped=1 WHERE slot=? AND run=? AND code=? AND call_id IS NULL", item.slot, run, code);
        }
        // Auth hints are RAM-only, never included in the immutable evidence or
        // Workflow result. They can restore a known-valid cached bearer after
        // controller eviction without a reissue storm or a token in SQLite.
        const hint = value.authHint;
        if (!this.pinnedAuth.has(run) && typeof hint?.accessToken === "string" && hint.accessToken.length <= 2048
          && hint.expiresAtMs === this.state("knownAuthExpiry") && hint.expiresAtMs > this.state(`run:${run}`) + 305000) this.pinnedAuth.set(run, hint);
        this.store(key, metadata); this.ctx.storage.sql.exec("UPDATE slot_pairs SET completed=1 WHERE id=?", key);
        this.ctx.storage.sql.exec("UPDATE jobs SET status='COMPLETE' WHERE run=? AND code=?", run, code);
        for (const resolve of this.pairNotifiers) resolve(); await this.launchJobs(run, 1);
        return Response.json({ stored: true });
      }
      if (u.pathname === "/plan") {
        const value = await request.json(), codes = value.codes;
        if (!Array.isArray(codes) || codes.length !== 553 || new Set(codes).size !== 553 || codes.some(c => !/^[0-9A-Z]{6}$/u.test(c))) throw new Error("DIAG_FULL_UNIVERSE_REQUIRED");
        this.store(`plan:${run}`, { codes, retryProbe: value.retryProbe === true, batch8: value.batch8 === true });
        this.set(`retryProbe:${run}`, value.retryProbe === true ? 1 : 0);
        for (const [i, code] of codes.entries()) this.ctx.storage.sql.exec("INSERT OR IGNORE INTO jobs VALUES (?,?,?,'PENDING',0)", run, i, code);
        if (value.batch8 === true) {
          this.set(`batchPlan:${run}`, 1);
          const definitions = [];
          for (let i = 0; i < codes.length; i += 8) definitions.push({ id: `${run}-batch${i / 8}`, params: { mode: "batch-shard", runId: run, codes: codes.slice(i, i + 8),
            retryCodes: value.retryProbe === true ? codes.slice(i, i + 8).filter((_c, j) => (i + j) % 10 === 0) : [] } });
          try { await this.env.DIAGNOSTIC.createBatch(definitions); }
          catch { throw new Error("DIAG_BATCH_PLAN_START_UNKNOWN"); }
          return Response.json({ universe: codes.length, fixedBatchChildren: definitions.length, maximumSymbolsPerInvocation: 8, externalRequestHardCap: 40 });
        }
        await this.launchJobs(run, 64); return Response.json({ universe: codes.length, maximumActiveShards: 64 });
      }
      if (u.pathname === "/progress") {
        await this.launchJobs(run, 64);
        const completed = this.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM jobs WHERE run=? AND status='COMPLETE'", run).one().n;
        const started = this.state(`run:${run}`);
        return Response.json({ completed, expired: Boolean(started && Date.now() >= started + 300000) });
      }
      // Binding-only protocol. Workflow's public management modes cannot return
      // these bearer or seed responses; HTTP entrypoint is disabled entirely.
      if (u.pathname === "/shared-auth") return Response.json(await this.sharedAuth(run));
      if (u.pathname === "/shared-invalidate") {
        return Response.json({ invalidated: this.invalidateAuthentication(await request.json()) });
      }
      if (u.pathname === "/pair-acquire") {
        const code = u.searchParams.get("code"), key = `${run}:${code}`;
        if (!/^[0-9A-Z]{6}$/u.test(code ?? "")) throw new Error("DIAG_CODES_INVALID");
        const operation = this.pairQueue.then(async () => {
          const prior = this.ctx.storage.sql.exec("SELECT body,digest FROM evidence WHERE id=?", key).toArray()[0];
          if (prior) { const value = JSON.parse(prior.body); if (hashIntradayModelTop(value) !== prior.digest) throw new Error("DIAG_HASH_MISMATCH"); this.ctx.storage.sql.exec("UPDATE jobs SET status='COMPLETE' WHERE run=? AND code=?", run, code); return { existing: value }; }
          if (this.ctx.storage.sql.exec("SELECT id FROM pair_leases WHERE id=?", key).toArray().length) throw new Error("DIAG_INTERRUPTED_PAIR_REQUIRES_REVIEW");
          while (true) {
            const active = this.ctx.storage.sql.exec("SELECT expires FROM pair_leases WHERE completed=0 AND expires>?", Date.now()).toArray();
            if (active.length < 2) break;
            let resolve, timer;
            const notification = new Promise(r => { resolve = r; timer = setTimeout(r, Math.max(1, Math.min(...active.map(row => row.expires)) - Date.now())); });
            this.pairNotifiers.add(resolve); await notification; clearTimeout(timer); this.pairNotifiers.delete(resolve);
          }
          if (!this.state(`run:${run}`)) this.set(`run:${run}`, Date.now());
          const deadline = this.state(`run:${run}`) + 300000;
          if (Date.now() >= deadline) throw new Error("DIAG_COLLECTION_DEADLINE");
          this.ctx.storage.sql.exec("INSERT INTO pair_leases VALUES (?,?,?,?,?,0)", key, run, code, Date.now(), Math.min(deadline, Date.now() + 65000));
          return { deadline };
        });
        this.pairQueue = operation.then(() => {}, () => {});
        return Response.json(await operation);
      }
      if (u.pathname === "/pair-complete") {
        const code = u.searchParams.get("code"), key = `${run}:${code}`, value = await request.json();
        const lease = this.ctx.storage.sql.exec("SELECT id FROM pair_leases WHERE id=?", key).toArray()[0];
        if (!lease || value.code !== code || value.rawPricesStored !== false || value.eligibleForLive !== false) throw new Error("DIAG_METADATA_INVALID");
        assertPrivateKisEodPayload(value);
        const inspect = node => { if (!node || typeof node !== "object") return; for (const [k, child] of Object.entries(node)) { if (["price", "volume", "open", "high", "low", "close", "rows", "output", "output2", "payload"].includes(k)) throw new Error("DIAG_RAW_STORAGE_REJECTED"); inspect(child); } };
        inspect(value); this.store(key, value);
        this.ctx.storage.sql.exec("UPDATE pair_leases SET completed=? WHERE id=?", Date.now(), key);
        this.ctx.storage.sql.exec("UPDATE jobs SET status='COMPLETE' WHERE run=? AND code=?", run, code);
        for (const resolve of this.pairNotifiers) resolve();
        await this.launchJobs(run, 1);
        return Response.json({ stored: true });
      }
      if (u.pathname === "/seed-source") {
        const code = u.searchParams.get("code");
        const receipt = this.ctx.storage.sql.exec("SELECT body,digest FROM evidence WHERE id=?", `prep:${run}`).toArray()[0];
        if (!receipt) throw new Error("DIAG_INPUT_NOT_PREPARED");
        const original = JSON.parse(receipt.body); if (hashIntradayModelTop(original) !== receipt.digest) throw new Error("DIAG_HASH_MISMATCH");
        if (this.seed?.contentHash !== original.seedHash) {
          this.seedReload ??= (async () => {
            const r = await edgeFetch(`https://raw.githubusercontent.com/klkl789982-droid/stock-research/${original.inputCommit}/data/analysis/market-seeds/${original.seedReferenceDate}.json`, { signal: AbortSignal.timeout(15000), cache: "no-store" });
            if (!r.ok) throw new Error("DIAG_PINNED_SEED_UNAVAILABLE");
            const seed = await r.json();
            if (seed.contentHash !== original.seedHash || validateIntradayMarketSeed(seed, 553).length) throw new Error("DIAG_PINNED_SEED_MISMATCH");
            this.seed = seed; this.seedByCode = new Map(seed.records.map(row => [row.code, row]));
          })();
          await this.seedReload;
        }
        const record = this.seedByCode?.get(code); if (!record) throw new Error("DIAG_CODES_INVALID");
        return Response.json({ record, seedReferenceDate: original.seedReferenceDate });
      }
      if (u.pathname === "/http-permit") {
        const code = u.searchParams.get("code"), kind = u.searchParams.get("kind");
        const lease = this.ctx.storage.sql.exec("SELECT expires FROM pair_leases WHERE id=? AND completed=0", `${run}:${code}`).toArray()[0];
        if (!lease || !["quote", "minute"].includes(kind)) throw new Error("DIAG_PAIR_LEASE_INVALID");
        const operation = this.permitQueue.then(async () => {
          if (this.startAck) await this.startAck.promise;
          if (this.state("pendingAck") || this.ackUnknown || this.platformBlock) throw new Error(this.platformBlock ?? "DIAG_START_ACK_UNKNOWN");
          const countKey = `requests:${quotaDay(Date.now())}`;
          if (this.state(countKey) >= DIAGNOSTIC_REQUEST_CAP) throw new Error("DIAG_DAILY_REQUEST_BUDGET_EXHAUSTED");
          if (this.ctx.storage.sql.databaseSize >= 8_000_000) throw new Error("DIAG_STORAGE_BUDGET_EXHAUSTED");
          while (Date.now() < this.state("lastStart") + 200) await sleep(this.state("lastStart") + 200 - Date.now());
          const notBefore = Date.now(), deadline = this.state(`run:${run}`) + 300000;
          if (notBefore >= deadline || notBefore >= lease.expires) throw new Error("DIAG_COLLECTION_DEADLINE");
          this.set(countKey, this.state(countKey) + 1);
          const id = this.ctx.storage.sql.exec("INSERT INTO calls(run,kind,started) VALUES (?,?,?) RETURNING id", run, kind, notBefore).one().id;
          this.set("pendingAck", id);
          let resolve;
          const promise = new Promise(r => { resolve = r; });
          const timer = setTimeout(() => { this.ackUnknown = true; resolve(); }, 15000);
          this.startAck = { id, promise, resolve, timer };
          return { id, notBefore, deadline };
        });
        this.permitQueue = operation.then(() => {}, () => {});
        return Response.json(await operation);
      }
      if (u.pathname === "/http-started") {
        const id = Number(u.searchParams.get("id")), at = Number(u.searchParams.get("at"));
        const call = this.ctx.storage.sql.exec("SELECT started FROM calls WHERE id=? AND run=?", id, run).toArray()[0];
        if (this.state(`ack:${id}`)) { if (at !== call?.started) throw new Error("DIAG_START_ACK_CONFLICT"); return Response.json({ acknowledged: true }); }
        if (!call || this.state("pendingAck") !== id || !Number.isSafeInteger(at) || at < call.started || at < this.state("lastStart") + 200 || at > Date.now() + 1000) throw new Error("DIAG_START_ACK_INVALID");
        this.ctx.storage.sql.exec("UPDATE calls SET started=? WHERE id=?", at, id); this.set("lastStart", at); this.set(`ack:${id}`, 1); this.set("pendingAck", 0);
        if (this.startAck?.id === id) { clearTimeout(this.startAck.timer); this.startAck.resolve(); this.startAck = null; }
        return Response.json({ acknowledged: true });
      }
      if (u.pathname === "/http-complete") {
        const id = Number(u.searchParams.get("id")), value = await request.json();
        const call = this.ctx.storage.sql.exec("SELECT started,completed,status FROM calls WHERE id=? AND run=?", id, run).toArray()[0];
        if (!call || !Number.isSafeInteger(value.completed) || value.completed < call.started || !Number.isInteger(value.status) || (value.status !== 0 && (value.status < 100 || value.status > 599))) throw new Error("DIAG_HTTP_METADATA_INVALID");
        if (call.completed && (call.completed !== value.completed || call.status !== value.status)) throw new Error("DIAG_HTTP_METADATA_CONFLICT");
        this.ctx.storage.sql.exec("UPDATE calls SET completed=?,status=? WHERE id=?", value.completed, value.status, id);
        if (value.failure) { const code = safeCode({ code: value.failure }); this.ctx.storage.sql.exec("INSERT OR REPLACE INTO transport_failures VALUES (?,?)", id, code); if (code.startsWith("DIAG_PLATFORM_")) this.platformBlock = code; }
        return Response.json({ completed: true });
      }
      if (u.pathname === "/inputs") return Response.json(this.store(`prep:${run}`, await this.inputs()));
      if (u.pathname === "/calendar") {
        if (this.pending.size || this.symbolActive.size || this.active.size || this.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM pair_leases WHERE completed=0 AND expires>?", Date.now()).one().n) throw new Error("DIAG_ANOTHER_RUN_ACTIVE");
        this.deadline = null; this.currentRun = run;
        const today = kst(Date.now()).date, key = `calendar:${today}`;
        const existing = this.ctx.storage.sql.exec("SELECT body,digest FROM evidence WHERE id=?", key).toArray()[0];
        if (existing) { const value = JSON.parse(existing.body); if (hashIntradayModelTop(value) !== existing.digest) throw new Error("DIAG_HASH_MISMATCH"); return Response.json(value); }
        const target = new Date(`${today}T00:00:00Z`);
        while ([0, 6].includes(target.getUTCDay())) target.setUTCDate(target.getUTCDate() + 1);
        const anchor = new Date(target); do { anchor.setUTCDate(anchor.getUTCDate() - 1); } while ([0, 6].includes(anchor.getUTCDay()));
        const date = anchor.toISOString().slice(0, 10);
        const response = await this.client.request(`${BASE}/uapi/domestic-stock/v1/quotations/chk-holiday?BASS_DT=${date.replaceAll("-", "")}&CTX_AREA_FK=&CTX_AREA_NK=`, { headers: { "Content-Type": "application/json", tr_id: "CTCA0903R" } });
        if (!response.ok) throw new Error(`KIS_HTTP_${response.status}`);
        const body = await response.json(), receivedAt = response.headers.get("X-TB-Received-At");
        const dates = [date, target.toISOString().slice(0, 10)].map(d => {
          try { return parseKisHolidayResponse(body, d, receivedAt); } catch (e) { return { referenceDate: d, status: "unknown", reason: safeCode(e) }; }
        });
        return Response.json(this.store(key, { queryDate: date, receivedAt, dates, rawPricesStored: false }));
      }
      if (u.pathname === "/auth") {
        const active = this.ctx.storage.sql.exec("SELECT value FROM control WHERE id='activeRun'").toArray()[0]?.value;
        const unfinished = active ? this.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM evidence c WHERE c.id LIKE ? AND NOT EXISTS (SELECT 1 FROM evidence b WHERE b.id=substr(c.id,1,length(c.id)-6))", `${active}:%:claim`).one().n
          + this.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM pair_leases WHERE run=? AND completed=0 AND expires>?", active, Date.now()).one().n
          + this.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM slot_pairs WHERE run=? AND completed=0 AND expires>?", active, Date.now()).one().n : 0;
        if (active && active !== run && Date.now() < this.state(`run:${active}`) + 300000
          && (unfinished || this.pending.size || this.symbolActive.size || this.active.size)) throw new Error("DIAG_ANOTHER_RUN_ACTIVE");
        if (active !== run || (this.deadline && Date.now() >= this.deadline)) this.deadline = null;
        this.ctx.storage.sql.exec("INSERT OR REPLACE INTO control VALUES ('activeRun',?)", run);
        this.currentRun = run;
        const before = this.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM calls WHERE kind='auth'").one().n;
        try { await Promise.all([this.sharedAuth(run), this.sharedAuth(run), this.sharedAuth(run)]); }
        catch (e) { return Response.json({ authenticated: false, reason: safeCode(e), transportFailure: this.lastTransportFailure ?? null,
          expiresAtMs: this.state("knownAuthExpiry"), pendingStartAck: this.state("pendingAck"),
          requestsToday: this.state(`requests:${quotaDay(Date.now())}`), rawPricesStored: false }); }
        const after = this.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM calls WHERE kind='auth'").one().n;
        return Response.json({ authenticated: true, parallelConsumers: 3, authRequestsAdded: after - before, state: this.manager.getState(),
          expiresAtMs: this.state("knownAuthExpiry"), remainingLifetimeMs: this.state("knownAuthExpiry") - Date.now(),
          sharedCacheUsable: true, encryptedTokenCacheStored: true, plaintextTokenStored: false, bearerStored: false, rawPricesStored: false });
      }
      if (u.pathname === "/site-fixture") {
        const io = privateRequestBudget(edgeFetch);
        const store = createKisEodPrivateStore({ repository: "klkl789982-droid/tight-budget-private-data", token: this.env.PRIVATE_LIVE_DELIVERY_WRITE_TOKEN, fetchImpl: io.fetch });
        return Response.json(await verifyCloudSiteFixture(store, u.searchParams.get("id"), run));
      }
      if (u.pathname === "/swing-fixture") {
        const io = privateRequestBudget(edgeFetch);
        const store = createKisEodPrivateStore({ repository: "klkl789982-droid/tight-budget-private-data", token: this.env.PRIVATE_LIVE_DELIVERY_WRITE_TOKEN, fetchImpl: io.fetch });
        return Response.json(await verifyCloudSwingFixture(store, run, u.searchParams.get("phase")));
      }
      if (u.pathname === "/fixture") {
        const store = createKisEodPrivateStore({ repository: "klkl789982-droid/tight-budget-private-data", token: this.env.PRIVATE_LIVE_DELIVERY_WRITE_TOKEN, fetchImpl: edgeFetch });
        const key = `cloud-isolated-tests/${run}.json`, value = { namespace: "cloud-price-free-connectivity-test", run, payload: "NO_PRICES_NO_CREDENTIALS", publicationEligible: false };
        const first = await store.writeImmutable(key, value), duplicate = await store.writeImmutable(key, value);
        let conflictBlocked = false;
        try { await store.writeImmutable(key, { ...value, payload: "DIFFERENT_NON_SENSITIVE_FIXTURE" }); } catch (e) { if (e.code !== "PRIVATE_STORE_IMMUTABLE_CONFLICT") throw e; conflictBlocked = true; }
        const reread = await store.read(key);
        if (reread?.contentHash !== first.contentHash || !conflictBlocked) throw new Error("DIAG_FIXTURE_VERIFICATION_FAILED");
        return Response.json({ privateWriteReadHashVerified: true, duplicate: duplicate.status, conflictBlocked, hash: first.contentHash, operationalPointerChanged: false, rawPricesStored: false });
      }
      if (u.pathname === "/batch") {
        const codes = u.searchParams.get("codes")?.split(",") ?? [];
        if (codes.length < 1 || codes.length > 8 || codes.some(c => !/^[0-9A-Z]{6}$/u.test(c)) || new Set(codes).size !== codes.length) throw new Error("DIAG_CODES_INVALID");
        const key = `${run}:${codes.join("_")}`;
        const previous = this.ctx.storage.sql.exec("SELECT body,digest FROM evidence WHERE id=?", key).toArray()[0];
        if (previous) { const value = JSON.parse(previous.body); if (hashIntradayModelTop(value) !== previous.digest) throw new Error("DIAG_HASH_MISMATCH"); return Response.json(value); }
        if (this.pending.has(key)) return Response.json(await this.pending.get(key));
        if (this.ctx.storage.sql.exec("SELECT id FROM evidence WHERE id=?", `${key}:claim`).toArray().length) throw new Error("DIAG_INTERRUPTED_BATCH_REQUIRES_REVIEW");
        const active = this.ctx.storage.sql.exec("SELECT value FROM control WHERE id='activeRun'").toArray()[0]?.value;
        if (active && active !== run && Date.now() < this.state(`run:${active}`) + 300000) throw new Error("DIAG_ANOTHER_RUN_ACTIVE");
        this.ctx.storage.sql.exec("INSERT OR REPLACE INTO control VALUES ('activeRun',?)", run);
        this.store(`${key}:claim`, { claimedAt: new Date().toISOString(), rawPricesStored: false });
        const started = this.state(`run:${run}`);
        if (!started) this.set(`run:${run}`, Date.now());
        this.deadline = this.state(`run:${run}`) + 300000; this.currentRun = run;
        const operation = Promise.all(codes.map(async code => {
          try { return await this.collect(code); } catch (e) { return { code, reason: safeCode(e), eligibleForLive: false, rawPricesStored: false }; }
        })).then(records => this.store(key, { records, rawPricesStored: false, eligibleForLive: false }));
        this.pending.set(key, operation);
        try { return Response.json(await operation); } finally { this.pending.delete(key); }
      }
      if (u.pathname === "/audit") {
        const values = this.ctx.storage.sql.exec("SELECT body,digest FROM evidence WHERE id LIKE ? AND id NOT LIKE '%:claim'", `${run}:%`).toArray().flatMap(r => {
          const value = JSON.parse(r.body); if (hashIntradayModelTop(value) !== r.digest) throw new Error("DIAG_HASH_MISMATCH"); return Array.isArray(value.records) ? value.records : [value];
        }).sort((a, b) => a.code.localeCompare(b.code));
        if (new Set(values.map(r => r.code)).size !== values.length) throw new Error("DIAG_DUPLICATE_SYMBOL");
        const calls = this.ctx.storage.sql.exec("SELECT kind,started,completed,status FROM calls WHERE run=? ORDER BY started", run).toArray();
        const collectionCalls = calls.filter(r => ["quote", "minute"].includes(r.kind));
        const collectionFirstAt = collectionCalls[0]?.started ?? null;
        const collectionLastReceivedAt = collectionCalls.length ? Math.max(...collectionCalls.map(r => r.completed ?? 0)) : null;
        const latency = calls.filter(r => r.completed && r.status >= 100).map(r => r.completed - r.started).sort((a, b) => a - b);
        const transportFailures = this.ctx.storage.sql.exec("SELECT f.code,COUNT(*) AS n FROM transport_failures f JOIN calls c ON c.id=f.id WHERE c.run=? GROUP BY f.code", run).toArray();
        const pairGaps = values.filter(r => r.minuteRequestedAt && r.quoteReceivedAt).map(r => Date.parse(r.minuteRequestedAt) - Date.parse(r.quoteReceivedAt)).sort((a, b) => a - b);
        const inputEvidence = this.ctx.storage.sql.exec("SELECT body FROM evidence WHERE id=?", `prep:${run}`).toArray().map(r => JSON.parse(r.body))[0] ?? null;
        const completeModels = values.filter(r => r.scores && ["A-v1", "B-v1", "C-v1", "D-v1"].every(v => Number.isFinite(r.scores[v])));
        const calculationComplete = inputEvidence && completeModels.length === inputEvidence.eligible;
        const top5 = calculationComplete ? Object.fromEntries(["A-v1", "B-v1", "C-v1", "D-v1"].map(v => [v, [...completeModels].sort((a, b) => b.scores[v] - a.scores[v] || a.code.localeCompare(b.code)).slice(0, 5)
          .map((r, i) => ({ ticker: r.code, companyName: r.companyName, score: r.scores[v], rank: i + 1 }))])) : null;
        return Response.json({ run, symbols: values.length, validQuotes: values.filter(r => r.quoteStatus === "VALID").length,
          jobsByStatus: this.ctx.storage.sql.exec("SELECT status,COUNT(*) AS n FROM jobs WHERE run=? GROUP BY status", run).toArray(),
          uncommittedJobs: this.ctx.storage.sql.exec("SELECT idx,code,status FROM jobs WHERE run=? AND status!='COMPLETE' ORDER BY idx", run).toArray(),
          requestsToday: this.state(`requests:${quotaDay(Date.now())}`), requestCap: DIAGNOSTIC_REQUEST_CAP,
          authenticationRequests: calls.filter(r => r.kind === "auth").length,
          failures: values.filter(r => r.reason).map(r => ({ code: r.code, reason: r.reason })),
          calls: calls.length, firstAt: calls[0]?.started ?? null, lastReceivedAt: Math.max(0, ...calls.map(r => r.completed ?? 0)),
          collectionFirstAt, collectionLastReceivedAt,
          collectionSpanMs: collectionFirstAt && collectionLastReceivedAt ? collectionLastReceivedAt - collectionFirstAt : null,
          callsByKind: calls.reduce((out, r) => { out[r.kind] = (out[r.kind] ?? 0) + 1; return out; }, {}),
          httpStatuses: calls.reduce((out, r) => { out[r.status] = (out[r.status] ?? 0) + 1; return out; }, {}),
          httpResponses: calls.filter(r => r.status >= 100).length, transportFailures,
          reservedSlots: this.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM rate_slots WHERE run=?", run).one().n,
          unknownSlots: this.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM rate_slots WHERE run=? AND call_id IS NULL AND skipped=0", run).one().n,
          minimumStartSpacingMs: calls.length > 1 ? Math.min(...calls.slice(1).map((r, i) => r.started - calls[i].started)) : null,
          latencyMs: { p50: latency[Math.floor(latency.length * .5)] ?? null, p95: latency[Math.floor(latency.length * .95)] ?? null, max: latency.at(-1) ?? null },
          observedDates: [...new Set(values.map(r => r.observedDate).filter(Boolean))],
          inputEvidence, modelsCalculated: completeModels.length, calculationComplete: Boolean(calculationComplete), top5,
          injectedRetrySymbols: values.filter(r => r.retryEvidence?.length).length,
          scoresHash: hashIntradayModelTop(completeModels.map(r => ({ ticker: r.code, scores: r.scores }))),
          quoteToMinuteRequestGapMs: { p95: pairGaps[Math.floor(pairGaps.length * .95)] ?? null, max: pairGaps.at(-1) ?? null },
          evidenceHash: hashIntradayModelTop(values), rawPricesStored: false, eligibleForLive: false,
          collectionSucceeded: values.length === 553 && values.every(r => !r.reason && r.quoteStatus === "VALID" && r.minuteStatus === "SUCCESS" && r.observedDate), operationalPointerChanged: false });
      }
      if (u.pathname === "/report") {
        const store = createKisEodPrivateStore({ repository: "klkl789982-droid/tight-budget-private-data", token: this.env.PRIVATE_LIVE_DELIVERY_WRITE_TOKEN, fetchImpl: edgeFetch });
        const key = `cloud-isolated-tests/reports/${run}.json`;
        const value = await freezeDiagnosticReport({
          readLocal: () => {
            const row = this.ctx.storage.sql.exec("SELECT body,digest FROM evidence WHERE id=?", `outbox:${run}`).toArray()[0];
            if (!row) return null; const v = JSON.parse(row.body); if (hashIntradayModelTop(v) !== row.digest) throw new Error("DIAG_HASH_MISMATCH"); return v;
          }, readRemote: () => store.read(key), saveLocal: v => this.store(`outbox:${run}`, v),
          validate: v => { if (v.namespace !== "cloud-kis-off-hours-diagnostic-v1" || v.observationType !== "OFF_HOURS_DIAGNOSTIC" || v.run !== run || v.publicationEligible !== false || v.sourcePricesIncluded !== false || v.rawPricesStored !== false || v.eligibleForLive !== false) throw new Error("DIAG_REPORT_INVALID"); assertPrivateKisEodPayload(v); },
          build: async () => {
            const response = await this.fetch(new Request(`https://isolated/audit?run=${run}`));
            if (!response.ok) throw new Error("DIAG_AUDIT_FAILED");
            const report = await response.json();
            // Freeze before remote I/O. Changing account counters/retry times
            // must never alter an immutable diagnostic report on retransmission.
            return { namespace: "cloud-kis-off-hours-diagnostic-v1", observationType: "OFF_HOURS_DIAGNOSTIC",
              ...report, failures: report.failures.reduce((out, row) => { out[row.reason] = (out[row.reason] ?? 0) + 1; return out; }, {}),
              publicationEligible: false, sourcePricesIncluded: false };
          },
        });
        const written = await store.writeImmutable(key, value), reread = await store.read(key);
        if (written.contentHash !== reread?.contentHash) throw new Error("DIAG_REPORT_READBACK_FAILED");
        return Response.json({ privateWriteReadHashVerified: true, hash: written.contentHash, modelsCalculated: value.modelsCalculated,
          collectionSucceeded: value.collectionSucceeded, calculationComplete: value.calculationComplete,
          top5Records: value.top5 ? Object.values(value.top5).reduce((n, rows) => n + rows.length, 0) : 0,
          observationType: value.observationType, operationalPointerChanged: false, sourcePricesIncluded: false });
      }
      return new Response(null, { status: 404 });
    } catch (e) { return Response.json({ reason: safeCode(e),
      ...(e?.code === "KIS_TOKEN_NETWORK_ERROR" || e?.message === "KIS_TOKEN_NETWORK_ERROR" ? { transportFailure: this.lastTransportFailure ?? null,
        expiresAtMs: this.state("knownAuthExpiry"), pendingStartAck: this.state("pendingAck") } : {}), rawPricesStored: false }, { status: 503 }); }
  }
}

export class KisDiagnostic extends WorkflowEntrypoint {
  async run(event, step) {
    const p = event.payload ?? {};
    if (!runIdOk(p.runId)) throw new Error("DIAG_RUN_ID_INVALID");
    if (p.mode === "production-fixture") {
      assertIsolatedProductionFixture(this.env);
      if (p.runId.length > 24) throw new Error("DIAG_PRODUCTION_FIXTURE_INVALID");
      const isolated = this.env.LIVE_DAYS.get(this.env.LIVE_DAYS.idFromName(`isolated-fixture-${p.runId}`));
      await step.do("native SQL synthetic production lifecycle", config, () => isolated.isolatedFixture(p.runId, "create"));
      return step.do("native SQL restart readback and private normal reader", config, () => isolated.isolatedFixture(p.runId, "read"));
    }
    assertDiagnostic(this.env);
    const broker = this.env.BROKER.get(this.env.BROKER.idFromName(brokerName));
    async function call(path, body = null) {
      const r = await broker.fetch(`https://isolated${path}${path.includes("?") ? "&" : "?"}run=${p.runId}`, body ? { method: "POST", body: JSON.stringify(body) } : undefined), value = await r.json();
      if (!r.ok) throw new Error(safeCode({ code: value.reason })); return value;
    }
    if (p.mode === "site-fixture") return step.do("isolated score-only Preview fixture", config, () => call(`/site-fixture?id=${encodeURIComponent(p.fixtureId ?? "")}`));
    if (p.mode === "swing-fixture") {
      await step.do("isolated synthetic swing first issuance", config, () => call("/swing-fixture?phase=create"));
      return step.do("reopen synthetic swing with existing five-session resolver", config, () => call("/swing-fixture?phase=read"));
    }
    if (["auth", "fixture", "audit", "inputs", "report", "calendar"].includes(p.mode)) return step.do(`isolated ${p.mode}`, config, () => call(`/${p.mode}`));
    if (p.mode === "batch-shard") return step.do("actual eight-symbol bounded invocation metadata only", config, async () => {
      if (!Array.isArray(p.codes) || p.codes.length < 1 || p.codes.length > 8 || p.codes.some(c => !/^[0-9A-Z]{6}$/u.test(c))) throw new Error("DIAG_CODES_INVALID");
      const shard = this.env.SHARDS.get(this.env.SHARDS.idFromName(`${p.runId}-${p.codes[0]}-batch8`), { locationHint: "apac-ne" });
      const response = await shard.fetch(`https://isolated/collect-batch?run=${p.runId}&codes=${p.codes.join(",")}&retryCodes=${(p.retryCodes ?? []).join(",")}`);
      if (!response.ok) throw new Error("DIAG_SHARD_FAILED"); return response.json();
    });
    if (p.mode === "shard") return step.do("actual KIS responses in isolated shard metadata only", config, async () => {
      const shard = this.env.SHARDS.get(this.env.SHARDS.idFromName(`${p.runId}-${p.codes[0]}`), { locationHint: "apac-ne" });
      const response = await shard.fetch(`https://isolated/collect?run=${p.runId}&codes=${p.codes.join(",")}&dropFirst=${p.retryProbe === true}`);
      if (!response.ok) throw new Error("DIAG_SHARD_FAILED"); return response.json();
    });
    const codes = typeof p.codesText === "string" ? p.codesText.split(",") : p.codes;
    if (p.mode !== "full" || !Array.isArray(codes) || codes.length !== 553 || new Set(codes).size !== 553 || codes.some(c => !/^[0-9A-Z]{6}$/u.test(c))) throw new Error("DIAG_FULL_UNIVERSE_REQUIRED");
    const authentication = await step.do("preauthenticate shared broker", config, () => call("/auth"));
    if (authentication.authenticated !== true) throw new Error("DIAG_AUTHENTICATION_BLOCKED");
    await step.do("recheck current pinned EOD without persisting raw history", config, async () => {
      try { return await call("/inputs"); } catch (e) { return { readiness: "BLOCKED", reason: safeCode(e), modelCalculationAllowed: false }; }
    });
    await step.do("start full universe sliding window without raw Workflow state", config, () => call("/plan", { codes, retryProbe: p.retryProbe === true, batch8: p.batch8 === true }));
    for (let i = 0; i < 11; i++) {
      await step.sleep(`server-side progress interval ${i}`, "30 seconds");
      const progress = await step.do(`bounded launch recovery ${i}`, config, () => call("/progress"));
      if (progress.completed === 553 || progress.expired) break;
    }
    return step.do("actual response timing audit no publication", config, () => call("/audit"));
  }
}
const closedHttp = { fetch() { return new Response(null, { status: 404 }); }, scheduled: productionScheduled };
export default closedHttp;
