import { DurableObject, WorkflowEntrypoint } from "cloudflare:workers";
import { runCongestion } from "./congestion-runner.mjs";
import { ProductionDayState as Before } from "./incident-baseline.mjs";
import { ProductionDayState as After } from "./production-state.mjs";

// Dedicated binding-only fixture: no secrets, KIS binding, Cron, public route
// or operational object namespace. All dates/data are explicitly synthetic.
export class SqlReplayDay extends DurableObject {
  readback() {
    const state = new After({ sql: this.ctx.storage.sql, now: () => Date.parse("2002-01-03T05:05:01.000Z"),
      env: { LIVE_PRODUCTION_ENABLED: "true", LIVE_PRODUCER: "cloud", LIVE_CUTOVER_RECEIPT_HASH: "f".repeat(64) },
      transaction: fn => this.ctx.storage.transactionSync(fn) });
    const first = state.read("outbox"), before = { ...state.credit };
    let failedSqlCharged = false;
    try { state.q("SELECT synthetic_missing_column FROM docs"); } catch { failedSqlCharged = state.credit.r <= before.r - 32 && state.credit.w <= before.w - 16; }
    const reopenedDelivery = state.finish("2002-01-03");
    const again = state.read("outbox");
    return { syntheticOnly: true, kisCalls: 0, failedSqlCharged, frozenHashUnchanged: first.delivery.deliveryHash === reopenedDelivery.deliveryHash,
      firstIssuanceUnchanged: first.swing.createdAt === again.swing.createdAt, topRows: again.swing.selections.length,
      predictionsNull: again.swing.records.every(r => r.predictions.expectedReturn === null), nativeStatus: state.status(), sourcePricesIncluded: false };
  }
  async replay(mode) {
    if (!["before", "after"].includes(mode)) throw new Error("TEST_MODE_INVALID");
    const native = { queries: 0, usageUpdates: 0, rowsRead: 0, rowsWritten: 0 };
    const raw = this.ctx.storage.sql;
    const sql = { get databaseSize() { return raw.databaseSize; }, exec(query, ...args) {
      // Separate hard fixture cap; abort rather than pay/raise production caps.
      if (native.rowsWritten + 16 > 22000 || native.rowsRead + 2048 > 150000) throw new Error("ISOLATED_SQL_TEST_BUDGET");
      const c = raw.exec(query, ...args), rows = c.toArray();
      native.queries++; if (query.startsWith("UPDATE usage")) native.usageUpdates++;
      native.rowsRead += c.rowsRead; native.rowsWritten += c.rowsWritten;
      return { rowsRead: c.rowsRead, rowsWritten: c.rowsWritten, toArray: () => rows };
    } };
    const result = await runCongestion({ sql, State: mode === "before" ? Before : After, transaction: fn => this.ctx.storage.transactionSync(fn) });
    return { ...result, rowMeasurement: "ACTUAL_CLOUDFLARE_SQL_CURSOR", native, productionPathUsed: false, sourcePricesIncluded: false };
  }
}
export class SqlReplay extends WorkflowEntrypoint {
  async run(event, step) {
    const mode = event.payload?.mode;
    if (!["before", "after", "fault"].includes(mode) || !/^sql-(?:before|after|fault)-[a-z0-9-]{1,32}$/u.test(event.instanceId)) throw new Error("TEST_INSTANCE_INVALID");
    if (mode === "fault") return await step.do("isolated restart readback and failedSQL charge", { retries: { limit: 0, delay: "1 second" }, timeout: "30 seconds" }, () =>
      this.env.SQL_REPLAY_DAYS.get(this.env.SQL_REPLAY_DAYS.idFromName("sql-after-20261020-final")).readback());
    return await step.do("isolated70batch553nativecursor", { retries: { limit: 0, delay: "1 second" }, timeout: "2 minutes" }, () =>
      this.env.SQL_REPLAY_DAYS.get(this.env.SQL_REPLAY_DAYS.idFromName(event.instanceId)).replay(mode));
  }
}
const closedHttp = { fetch() { return new Response(null, { status: 404 }); } };
export default closedHttp;
