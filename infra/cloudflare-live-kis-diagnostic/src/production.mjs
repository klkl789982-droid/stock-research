import { DurableObject, WorkflowEntrypoint } from "cloudflare:workers";
import { KisSlotShard } from "./slot-shard.mjs";
import { ProductionDayState } from "../production-state.mjs";
import { assertProduction, assertWindow, bounds, kst, productionObservation } from "../production-core.mjs";
import { safeCode, edgeFetch } from "../core.mjs";
import { createKisEodPrivateStore } from "../../../lib/kis-eod-private-store.mjs";
import { privateRequestBudget } from "../relay-budget.mjs";
import { assertDiagnostic } from "../core.mjs";
import { verifyNativeProductionFixture } from "../production-fixture.mjs";
const options = { retries: { limit: 0, delay: "1 second" }, timeout: "6 minutes" };
const dateOf = run => { const m = /^live-(\d{4}-\d{2}-\d{2})$/u.exec(run ?? ""); if (!m) throw new Error("LIVE_CLOUD_DATE_INVALID"); return m[1]; };
const vault = env => env.BROKER.get(env.BROKER.idFromName("single-approved-kis-credential-v1"));
const day = (env, date) => env.LIVE_DAYS.get(env.LIVE_DAYS.idFromName(date), { locationHint: "apac-ne" });

export class LiveDay extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.state = new ProductionDayState({ sql: ctx.storage.sql, env,
      prepare: date => vault(env).livePrepare(date), bundle: (date, prepared, code) => vault(env).liveBundle(date, prepared, code),
      remote: createKisEodPrivateStore({ repository: "klkl789982-droid/tight-budget-private-data", token: env.PRIVATE_LIVE_DELIVERY_WRITE_TOKEN, fetchImpl: edgeFetch }) });
  }
  prepare(date, final) { return this.state.prepare(date, final); }
  finish(date) { this.state.finish(date); return { status: "OUTBOX_FROZEN" }; }
  async relay(date) {
    const io = privateRequestBudget(edgeFetch);
    const remote = createKisEodPrivateStore({ repository: "klkl789982-droid/tight-budget-private-data", token: this.env.PRIVATE_LIVE_DELIVERY_WRITE_TOKEN, fetchImpl: io.fetch });
    try { return await this.state.relay(date, remote); }
    catch (e) { if (io.exhausted) throw new Error("LIVE_CLOUD_RELAY_HTTP_BUDGET"); throw e; }
  }
  status() { return { ...this.state.status(), productionEnabled: this.env.LIVE_PRODUCTION_ENABLED === "true", producer: this.env.LIVE_PRODUCER }; }
  failure(code) { return this.state.write("last-failure", { code: safeCode({ code }), at: new Date().toISOString() }, true); }
  async isolatedFixture(run, phase) {
    assertDiagnostic(this.env);
    if (!/^[A-Za-z0-9_-]{1,24}$/u.test(run ?? "") || this.ctx.id.toString() !== this.env.LIVE_DAYS.idFromName(`isolated-fixture-${run}`).toString()) throw new Error("DIAG_PRODUCTION_FIXTURE_IDENTITY");
    const io = privateRequestBudget(edgeFetch);
    const remote = createKisEodPrivateStore({ repository: "klkl789982-droid/tight-budget-private-data", token: this.env.PRIVATE_LIVE_DELIVERY_WRITE_TOKEN, fetchImpl: io.fetch });
    return verifyNativeProductionFixture({ sql: this.ctx.storage.sql, remote, run, phase });
  }
  async fetch(request) {
    try {
      const u = new URL(request.url), date = dateOf(u.searchParams.get("run")), code = u.searchParams.get("code");
      if (u.pathname === "/slot-pair-acquire") return Response.json(await this.state.acquire(date, code));
      if (u.pathname === "/extra-slot") return Response.json(this.state.extra(date, code, u.searchParams.get("kind")));
      if (u.pathname === "/slot-pair-complete") return Response.json(this.state.complete(date, code, await request.json()));
      // Tokens may NOT be refreshed inside the market window. The already
      // pinned credential must cover it; an actual401 fails the observation.
      if (["/shared-auth", "/shared-invalidate"].includes(u.pathname)) throw new Error("LIVE_CLOUD_AUTH_INVALIDATED");
      return new Response(null, { status: 404 });
    } catch (e) { return Response.json({ reason: safeCode(e) }, { status: 503 }); }
  }
}

export class LiveBatch extends KisSlotShard {
  assertInvocation() { assertProduction(this.env); }
  brokerFor(run) { return day(this.env, dateOf(run)); }
  minuteQueryTime(timing) { return kst(Date.parse(timing.quoteRequestedAt)).time; }
  projectResult(args) { return productionObservation(args); }
}

export class CloudLive extends WorkflowEntrypoint {
  async run(event, step) {
    const p = event.payload ?? {}, date = p.date;
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(date ?? "")) throw new Error("LIVE_CLOUD_DATE_INVALID");
    const target = day(this.env, date);
    if (p.mode === "status") return step.do("read only production readiness", options, () => target.status());
    assertProduction(this.env);
    try {
      if (p.mode === "relay") return step.do("retry frozen score-only outbox", options, async () => { await target.finish(date); return target.relay(date); });
      if (p.mode === "batch") {
        await step.sleepUntil("wait for absolute1400", new Date(bounds(date).start));
        return step.do("bounded eight-symbol LIVE invocation", options, async () => {
          assertWindow(date, Date.now());
          if (!Array.isArray(p.codes) || !p.codes.length || p.codes.length > 8) throw new Error("LIVE_CLOUD_CODES_INVALID");
          const shard = this.env.LIVE_BATCHES.get(this.env.LIVE_BATCHES.idFromName(`${date}-${p.codes[0]}`), { locationHint: "apac-ne" });
          const r = await shard.fetch(`https://internal/collect-batch?run=live-${date}&codes=${p.codes.join(",")}`);
          if (!r.ok) throw new Error("LIVE_CLOUD_BATCH_FAILED");
          const value = await r.json(); return { completed: value.records.length, sourcePricesIncluded: false };
        });
      }
      if (p.mode !== "day") throw new Error("LIVE_CLOUD_MODE_INVALID");
      await step.do("1340 preparation no market prices", options, async () => {
        try { return { prepared: await target.prepare(date, false) }; } catch (e) { return { reason: safeCode(e) }; }
      });
      await step.sleepUntil("1359 fresh EOD recheck", new Date(bounds(date).start - 60000));
      let prepared = null;
      for (let i = 0; i < 6 && !prepared; i++) {
        const attempt = await step.do(`fresh input attempt${i}`, options, async () => {
          try { return { prepared: await target.prepare(date, true) }; } catch (e) { return { reason: safeCode(e) }; }
        });
        prepared = attempt.prepared;
        if (!prepared && i < 5) await step.sleep(`bounded input backoff${i}`, "10 seconds");
      }
      if (!prepared) throw new Error("LIVE_CLOUD_INPUT_NOT_READY");
      // Fixed child IDs are created BEFORE the quote window. The scheduled
      // parent may start at13:40:58; it never waits for a14:00 cron invocation.
      await step.do("precreate fixed batch ids", options, async () => {
        const definitions = [];
        for (let i = 0; i < prepared.codes.length; i += 8) definitions.push({ id: `live-${date}-batch${i / 8}`,
          params: { mode: "batch", date, codes: prepared.codes.slice(i, i + 8) } });
        try { await this.env.LIVE.createBatch(definitions); }
        catch {
          // Never create replacement IDs after an unknown create response.
          // Recovery uses the same immutable IDs, not another observation.
          for (const d of definitions) { const prior = await this.env.LIVE.get(d.id); await prior.status(); }
        }
        return { batches: definitions.length, symbols: prepared.codes.length };
      });
      await step.sleepUntil("finalize after absolute collection cutoff", new Date(bounds(date).end + 1000));
      await step.do("validate all required inputs and freeze outbox", options, () => target.finish(date));
      return step.do("publish private score-only delivery", options, () => target.relay(date));
    } catch (e) {
      await step.do("record fixed failure code", options, () => target.failure(safeCode(e)));
      throw new Error(safeCode(e));
    }
  }
}

export async function productionScheduled(event, env) {
  if (env.LIVE_PRODUCTION_ENABLED !== "true") return { status: "DISABLED" };
  assertProduction(env);
  const t = kst(event.scheduledTime), weekday = new Date(`${t.date}T00:00:00Z`).getUTCDay();
  if ([0, 6].includes(weekday)) return { status: "WEEKEND" };
  const mode = t.time < "14:00:00" ? "day" : "relay", id = mode === "day" ? `live-${t.date}` : `live-${t.date}-relay${t.time.slice(3, 5)}`;
  try { await env.LIVE.create({ id, params: { mode, date: t.date } }); }
  catch { const existing = await env.LIVE.get(id); await existing.status(); }
  return { id, mode };
}
