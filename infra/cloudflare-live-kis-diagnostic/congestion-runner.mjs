import { ProductionDayState } from "./production-state.mjs";
import { syntheticProductionInputs } from "./swing-fixture.mjs";
import { bounds } from "./production-core.mjs";

// Deterministic 70 batches x two concurrent callers, not an eight-caller feed.
// SQLite query counts are real; row costs below are a labelled local model,
// never represented as native Cloudflare cursor or account billing telemetry.
export async function runCongestion({ sql, State = ProductionDayState, delay = 22, failCode = null, stopAt = null, budgetNear = false, transaction = fn => fn() } = {}) {
  const { date, prepared, rows } = syntheticProductionInputs({ date: "2002-01-03", seedDate: "2001-12-28" });
  const b = bounds(date); let now = b.start - 1000, sequence = 0, active = 0, peak = 0, completed = 0;
  const outcomes = new Map();
  const timers = [], errors = [];
  const wait = ms => new Promise(resolve => timers.push({ at: now + ms, sequence: sequence++, resolve }));
  const state = new State({ sql, now: () => now, wait, transaction, scheduleDeadline: (ms, resolve) => {
    const timer = { at: now + ms, sequence: sequence++, resolve }; timers.push(timer);
    return () => { const i = timers.indexOf(timer); if (i >= 0) timers.splice(i, 1); };
  },
    env: { LIVE_PRODUCTION_ENABLED: "true", LIVE_PRODUCER: "cloud", LIVE_CUTOVER_RECEIPT_HASH: "f".repeat(64) },
    prepare: async () => ({ ...prepared, remoteCheckedAt: new Date(now).toISOString() }), bundle: async () => ({ syntheticOnly: true }) });
  await state.prepare(date, true); now = b.start; if (budgetNear) state.meter.w = 33500;
  const collect = async row => {
    let entered = false, leased = false;
    try {
      const lease = await state.acquire(date, row.code);
      leased = true;
      if (lease.existing) return;
      active++; entered = true; peak = Math.max(peak, active);
      await wait(Math.max(0, lease.minuteSlot.notBefore + delay - now));
      const stamp = n => new Date(n).toISOString();
      const metadata = row.code === failCode ? { code: row.code, reason: "KIS_HTTP_500", rawPricesStored: false, eligibleForLive: false } : {
        ...row, observedTime: new Date(lease.quoteSlot.notBefore + 9 * 3600000).toISOString().slice(11, 19),
        quoteRequestedAt: stamp(lease.quoteSlot.notBefore), quoteReceivedAt: stamp(lease.quoteSlot.notBefore + delay),
        minuteRequestedAt: stamp(lease.minuteSlot.notBefore), minuteReceivedAt: stamp(lease.minuteSlot.notBefore + delay) };
      const calls = [["quote", lease.quoteSlot], ["minute", lease.minuteSlot]].map(([kind, s]) => ({ kind, slot: s.slot, started: s.notBefore, completed: s.notBefore + delay, status: row.code === failCode ? 500 : 200 }));
      state.complete(date, row.code, { metadata, calls }); completed++;
      outcomes.set(row.code, metadata.reason ? { reason: metadata.reason, failureStage: "COLLECTION" } : null);
    } catch (e) { errors.push(e.message); outcomes.set(row.code, { reason: e.message, failureStage: leased ? "COLLECTION" : "LEASE_ACQUIRE" }); }
    finally { if (entered) active--; }
  };
  let done = false;
  const batches = [];
  for (let i = 0; i < rows.length; i += 8) {
    const codes = rows.slice(i, i + 8); let next = 0;
    batches.push(Promise.all(Array.from({ length: Math.min(2, codes.length) }, async () => { while (next < codes.length) await collect(codes[next++]); })));
  }
  const all = Promise.all(batches).then(() => { done = true; });
  for (let cycles = 0; !done && cycles < 20000; cycles++) {
    for (let n = 0; n < 80; n++) await Promise.resolve();
    if (done) break;
    timers.sort((x, y) => x.at - y.at || x.sequence - y.sequence);
    if (!timers.length) throw new Error("REPLAY_DEADLOCK");
    const at = timers[0].at; now = stopAt && at >= b.start + stopAt ? Math.max(at, b.end + 1) : at;
    while (timers[0]?.at <= now) timers.shift().resolve();
  }
  if (!done) throw new Error("REPLAY_CYCLE_LIMIT");
  await all; const collectionSpanMs = now - b.start; now = Math.max(now, b.end + 1000);
  if (typeof state.reconcileBatches === "function") {
    const reconciled = [];
    for (let i = 0; i < rows.length; i += 8) {
      const codes = rows.slice(i, i + 8).map(row => row.code);
      const failures = codes.flatMap(code => outcomes.get(code) ? [{ code, ...outcomes.get(code) }] : []);
      reconciled.push({ id: `live-${date}-batch${i / 8}`, codes, workflowStatus: "complete", attempted: codes.length,
        successful: codes.length - failures.length, failures });
    }
    const firstFailure = reconciled.flatMap(batch => batch.failures.map(row => ({ ...row, batchId: batch.id })))[0] ?? null;
    state.reconcileBatches(date, { schemaVersion: 1, date, batches: reconciled, firstFailure });
  }
  let outbox = false, finishError = null;
  try { state.finish(date); outbox = true; } catch (e) { finishError = e.message; }
  const result = { syntheticOnly: true, kisCalls: 0, batches: batches.length, perBatchConcurrency: 2, peakGlobalActive: peak,
    universe: rows.length, completed, errors: Object.fromEntries([...new Set(errors)].map(k => [k, errors.filter(e => e === k).length])),
    collectionSpanMs, outbox, finishError, meter: { ...state.meter }, sqliteBytes: sql.databaseSize,
    rowMeasurement: "LOCAL_SIMPLIFIED_MODEL_NOT_CLOUDFLARE_BILLED_ROWS" };
  return result;
}
