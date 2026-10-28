import { ProductionDayState } from "./production-state.mjs";
import { syntheticProductionInputs } from "./swing-fixture.mjs";
import { bounds } from "./production-core.mjs";
import { completeWithReceiptClock } from "./receipt-clock.mjs";

// Twelve synthetic symbols, native SQL/timers only. No market API, secret,
// private store, public URL or production namespace is bound to this Worker.
export async function verifyNativeSlotPolicy(owner) {
  const raw = owner.ctx.storage.sql, native = { rowsRead: 0, rowsWritten: 0, queries: 0 };
  const sql = { get databaseSize() { return raw.databaseSize; }, exec(query, ...args) {
    if (native.rowsRead + 2048 > 10000 || native.rowsWritten + 16 > 3000) throw Error("ISOLATED_SLOT_TEST_BUDGET");
    const c = raw.exec(query, ...args), rows = c.toArray(); native.rowsRead += c.rowsRead; native.rowsWritten += c.rowsWritten; native.queries++;
    return { rowsRead: c.rowsRead, rowsWritten: c.rowsWritten, toArray: () => rows };
  } };
  const input = syntheticProductionInputs({ date: "2002-01-03", seedDate: "2001-12-28" }), b = bounds(input.date), origin = Date.now();
  let offset = -1000, peak = 0, active = 0;
  const now = () => b.start + offset + Date.now() - origin;
  const wait = ms => new Promise(resolve => setTimeout(resolve, Math.max(1, ms)));
  const options = { sql, now, wait, transaction: fn => owner.ctx.storage.transactionSync(fn),
    env: { LIVE_PRODUCTION_ENABLED: "true", LIVE_PRODUCER: "cloud", LIVE_CUTOVER_RECEIPT_HASH: "f".repeat(64) },
    prepare: async () => ({ ...input.prepared, remoteCheckedAt: new Date(now()).toISOString() }), bundle: async () => ({ syntheticOnly: true }) };
  const state = new ProductionDayState(options);
  if (state.read("native-slot-proof-started")) throw Error("ISOLATED_SLOT_PROOF_ALREADY_ATTEMPTED");
  state.write("native-slot-proof-started", { syntheticOnly: true });
  await state.prepare(input.date, true); offset = 0;
  const outcomes = await Promise.all(input.rows.slice(0, 12).map(async (row, index) => {
    const lease = await state.acquire(input.date, row.code, { deferMinute: index !== 0 }); active++; peak = Math.max(peak, active);
    const calls = [];
    async function observe(kind, initial) {
      let slot = initial ?? state.extra(input.date, row.code, kind);
      for (let tries = 0; tries < 3; tries++) {
        while (now() < slot.notBefore) await wait(slot.notBefore - now());
        const started = now();
        if (started > slot.notBefore + 20) { slot = state.extra(input.date, row.code, kind, [slot.slot]); continue; }
        await wait(250);
        const call = { kind, slot: slot.slot, started, completed: now(), status: 200 }; calls.push(call); return call;
      }
      throw Error("ISOLATED_SLOT_TIMER_LATE");
    }
    try {
      const quote = await observe("quote", lease.quoteSlot), minute = await observe("minute", lease.minuteSlot);
      const stamp = n => new Date(n).toISOString();
      const metadata = { ...row, quoteRequestedAt: stamp(quote.started), quoteReceivedAt: stamp(quote.completed), minuteRequestedAt: stamp(minute.started), minuteReceivedAt: stamp(minute.completed) };
      await completeWithReceiptClock(state, input.date, row.code, { metadata, calls });
      // Same completion after a lost ACK never recollects or changes evidence.
      await completeWithReceiptClock(state, input.date, row.code, { metadata, calls });
      return { code: row.code, calls };
    } finally { active--; }
  }));
  const reopened = new ProductionDayState(options), counter = reopened.read("allocator");
  const starts = outcomes.flatMap(r => r.calls.map(c => c.started)).sort((a, b) => a - b);
  const completed = outcomes.filter(r => reopened.read(`observation:${r.code}`)?.status === "AVAILABLE").length;
  if (completed !== 12 || counter.count - counter.retiredUnused !== 24 || state.pending.size || peak > 8 || counter.retiredUnused < 1
    || starts.some((s, i) => i && s - starts[i - 1] < 200)) throw Error("ISOLATED_SLOT_PROOF_FAILED");
  return { syntheticOnly: true, kisCalls: 0, completed, requestsSimulated: starts.length, peak, allocated: counter.count,
    retiredUnused: counter.retiredUnused, chargedReservations: counter.count - counter.retiredUnused,
    minStartSpacingMs: Math.min(...starts.slice(1).map((v, i) => v - starts[i])), elapsedMs: Date.now() - origin,
    nativeCursor: native, sqliteBytes: sql.databaseSize, duplicateCompletionUnchanged: true, restartReadback: true,
    outbox: !!reopened.read("outbox"), productionPathUsed: false, sourcePricesIncluded: false };
}
