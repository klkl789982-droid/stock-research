import { ProductionDayState } from "./production-state.mjs";
import { syntheticProductionInputs } from "./swing-fixture.mjs";
import { bounds } from "./production-core.mjs";
import { readLatestPrivateLive } from "../../lib/private-live-delivery.mjs";
import { resolveSwingOutcome } from "../../lib/forecast-swing-contract.mjs";
import { runCloudWatchdog } from "./watchdog.mjs";

/** Native Cloudflare SQL + the unchanged production state machine, but only
 * synthetic metadata, a private test-key mapper and an injected local clock.
 * No market API, actual price, normal head, system clock or production flag is
 * changed. Caller must verify its DO identity before exposing this harness.
 */
export async function verifyNativeProductionFixture({ sql, remote, run, phase,probeFetch=fetch }) {
  if (!/^[A-Za-z0-9_-]{1,24}$/u.test(run ?? "") || !["create", "read","watch"].includes(phase)) throw new Error("DIAG_PRODUCTION_FIXTURE_INVALID");
  // The existing head reader uses13-digit epoch milliseconds (post-Sep2001).
  // Keep the already preserved2000 swing-only fixture byte-for-byte unchanged.
  const { date, prepared, rows } = syntheticProductionInputs({ date: "2002-01-03", seedDate: "2001-12-28" }), b = bounds(date);
  const prefix = `cloud-isolated-tests/pf/${run}`;
  const keyOf = key => {
    if (!/^(?:cloud-live-score-evidence-v1|cloud-live-swing-intent-v1|live-site-delivery-v1|cloud-live-watchdog-v1)\//u.test(key) || key.includes("..")) throw new Error("DIAG_PRODUCTION_TEST_PATH_ONLY");
    return `${prefix}/${key}`;
  };
  const isolated = {
    verifyPrivateRepository: () => remote.verifyPrivateRepository(),
    writeImmutable: (key, artifact) => remote.writeImmutable(keyOf(key), { syntheticOnly: true, publicationEligible: false, artifact }),
    async read(key) { const r = await remote.read(keyOf(key)); return r ? { value: r.value?.artifact } : null; },
    listKeys: key => remote.listKeys(keyOf(key)),
  };
  let now = b.start - 1000;
  const state = new ProductionDayState({ sql, remote: isolated, now: () => now,
    env: { LIVE_PRODUCTION_ENABLED: "true", LIVE_PRODUCER: "cloud", LIVE_CUTOVER_RECEIPT_HASH: "f".repeat(64) },
    prepare: async () => ({ ...prepared, remoteCheckedAt: new Date(now).toISOString(), readyAt: new Date(now).toISOString() }),
    bundle: async () => ({ syntheticOnly: true }),
  });
  if (phase === "create" && !state.read("fixture-complete")) {
    if (state.read("fixture-started")) throw new Error("DIAG_PRODUCTION_FIXTURE_INTERRUPTED");
    state.write("fixture-started", { syntheticOnly: true });
    await state.prepare(date, false); await state.prepare(date, true); now = b.start;
    // A bounded virtual clock simulates the exact553-symbol allocator without
    // waiting on wall time or issuing a single quote request.
    const active = []; let next = 0;
    const enqueue = async () => { const row = rows[next++]; active.push({ row, lease: await state.acquire(date, row.code) }); };
    for (let i = 0; i < 8; i++) await enqueue();
    while (active.length) {
      active.sort((a, z) => a.lease.minuteSlot.notBefore - z.lease.minuteSlot.notBefore);
      const { row, lease } = active.shift();
      now = lease.minuteSlot.notBefore + 2;
      const stamp = n => new Date(n).toISOString();
      const metadata = { ...row, observedTime: new Date(lease.quoteSlot.notBefore + 9 * 3600000).toISOString().slice(11, 19),
        quoteRequestedAt: stamp(lease.quoteSlot.notBefore), quoteReceivedAt: stamp(lease.quoteSlot.notBefore + 1),
        minuteRequestedAt: stamp(lease.minuteSlot.notBefore), minuteReceivedAt: stamp(now) };
      const calls = [["quote", lease.quoteSlot], ["minute", lease.minuteSlot]].map(([kind, s]) => ({ kind, slot: s.slot, started: s.notBefore, completed: s.notBefore + 1, status: 200 }));
      state.complete(date, row.code, { metadata, calls });
      if (next < rows.length) await enqueue();
    }
    const size=state.read("final").batchSize??8;
    for(let i=0;i<rows.length;i+=size){const codes=rows.slice(i,i+size).map(row=>row.code);
      state.recordBatchResult(date,`live-${date}`,codes,{status:"complete",output:{attempted:codes.length,successful:codes.length,failed:[]}});}
    const journal=state.reconcileJournal(date,`live-${date}`,true);
    if(!journal.ready||journal.firstFailure)throw new Error("DIAG_PRODUCTION_FIXTURE_INCOMPLETE");
    now = b.end + 1000; state.finish(date); await state.relay(date);
    state.write("fixture-complete", { syntheticOnly: true });
  }
  if (!state.read("fixture-complete")) throw new Error("DIAG_PRODUCTION_FIXTURE_NOT_READY");
  if(phase==="watch"){
    now=b.end+300000;
    return runCloudWatchdog({state,remote:isolated,fetchImpl:probeFetch,date,slot:"1535",scheduledAt:now,now,
      workflow:{get:async()=>({status:async()=>({status:"complete"})})},publishExecution:async()=>({isolatedOnly:true})});
  }
  now = b.end + 1000;
  const frozen = state.read("outbox"), receipt = await state.relay(date);
  const latest = await readLatestPrivateLive(isolated, { now: new Date(now).toISOString() });
  const swingKey = `cloud-live-swing-intent-v1/${date}/${frozen.swing.intentHash}.json`;
  const swing = (await isolated.read(swingKey))?.value;
  if (receipt.deliveryHash !== frozen.delivery.deliveryHash || latest?.deliveryHash !== receipt.deliveryHash || swing?.intentHash !== frozen.swing.intentHash
    || swing.createdAt !== frozen.delivery.exportedAt || swing.selections.length !== 20) throw new Error("DIAG_PRODUCTION_FIXTURE_READBACK_FAILED");
  if (swing.records.some(forecast => resolveSwingOutcome({ forecast, resolvedAt: "2002-01-04T05:05:01.000Z" }).status !== "BLOCKED")) throw new Error("DIAG_PRODUCTION_FIXTURE_OUTCOME_CHANGED");
  return { status: "NATIVE_PRODUCTION_FIXTURE_VERIFIED", phase, syntheticOnly: true, kisCalls: 0,
    universe: 553, eligible: 508, topRows: 20, batchSize:state.read("final").batchSize??8,
    batches:Math.ceil(553/(state.read("final").batchSize??8)),deliveryHash: receipt.deliveryHash, swingHash: swing.intentHash,
    firstCreatedAt: swing.createdAt, existingResolver: "BLOCKED_MISSING_REFERENCE_PRICE", nativeSqlMeter: { ...state.meter },
    sqliteBytes: sql.databaseSize, remoteNormalReaderVerified: true, operationalPointerChanged: false, sourcePricesIncluded: false };
}
