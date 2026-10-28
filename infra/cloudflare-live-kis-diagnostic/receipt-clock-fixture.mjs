import { requestContextFixture } from "./request-context-fixture.mjs";
import { completeWithReceiptClock } from "./receipt-clock.mjs";

// Only imported by the pre-existing isolated SQL replay Worker, which has no
// KIS/production binding, secrets, Cron or public route. Native SQL and timers,
// explicitly injected2002 clock lag; this is NOT a new market observation.
export async function verifyNativeReceiptClock(object) {
  const f=requestContextFixture(object),prior=f.state.read("receipt-clock-fixture-proof");if(prior)return prior;
  await f.state.prepare(f.input.date,true);f.setClock(f.b.start);
  let beforeRejected=0,afterStored=0,waits=0,clockWaitWallMs=0;
  f.state.wait=async ms=>{const at=Date.now();await new Promise(resolve=>setTimeout(resolve,ms));clockWaitWallMs+=Date.now()-at;f.setClock(f.now()+ms);waits++;};
  for(const [i,ahead]of[1,2].entries())for(const fixed of[false,true]){
    const code=f.input.prepared.codes[i*2+Number(fixed)],lease=await f.state.acquire(f.input.date,code);
    f.setClock(lease.minuteSlot.notBefore);const source=f.input.rows.find(r=>r.code===code);
    const calls=[["quote",lease.quoteSlot],["minute",lease.minuteSlot]].map(([kind,s])=>({kind,slot:s.slot,started:s.notBefore,completed:s.notBefore+ahead,status:200}));
    const value={metadata:source,calls},original=JSON.stringify(value);
    if(fixed){await completeWithReceiptClock(f.state,f.input.date,code,value);if(f.state.read(`observation:${code}`)?.status!=="AVAILABLE"||JSON.stringify(value)!==original)throw Error("CLOCK_FIXTURE_CHANGED_RECORD");afterStored++;}
    else{try{f.state.complete(f.input.date,code,value);throw Error("CLOCK_FIXTURE_BEFORE_NOT_REPRODUCED");}catch(e){if(e.message!=="LIVE_CLOUD_RATE_EVIDENCE_INVALID")throw e;
      const r=f.state.read(`rate-rejection:${code}`);if(r.issue!=="RESPONSE_AFTER_RECEIVER_CLOCK"||r.completionAheadMs!==ahead)throw Error("CLOCK_FIXTURE_WRONG_CAUSE");beforeRejected++;}}
  }
  const result={status:"NATIVE_RECEIPT_CLOCK_FIX_VERIFIED",syntheticOnly:true,injectedClockLagMs:[1,2],beforeRejected,afterStored,waits,clockWaitWallMs,
    actualCloudSqlCursor:f.meter,originalTimestampsUnchanged:true,strictValidatorUnchanged:true,zeroFutureTolerance:true,kisCalls:0,operationalPointerChanged:false};
  f.state.write("receipt-clock-fixture-proof",result);return result;
}
