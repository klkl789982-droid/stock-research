import {pinnedSeed,projectCurrentLiveUniverse} from "./current-live-universe.mjs";
import {transitionReplayKey} from "./live-transition-replay.mjs";

// Only after close: independently read the immutable private evidence. Never
// call a quote endpoint or claim this server comparison proves a browser render.
export async function auditStoredPublication({store,delivery,now,fetchImpl,readSeed=p=>pinnedSeed(p,fetchImpl)}) {
  const {signalDate,sourceHash,deliveryHash}=delivery;
  const evidence=(await store.read(`cloud-live-score-evidence-v1/${signalDate}/${sourceHash}.json`))?.value;
  if(!evidence)throw Error("LIVE_SOURCE_MISSING");
  const replay=evidence.transitionReplayHash;
  const bundle=replay?(await store.read(transitionReplayKey(signalDate,replay)))?.value:undefined;
  if(replay&&!bundle)throw Error("LIVE_TRANSITION_REPLAY_UNAVAILABLE");
  const v=projectCurrentLiveUniverse({delivery},evidence,await readSeed(evidence.prepared),now,bundle);
  const count=v.records.filter(r=>r.transitionV1&&r.eligible).length;
  return {status:v.transitionReplayed?"VERIFIED":"INPUTS_NOT_RETAINED",signalDate,revision:v.revision,deliveryHash,
    coverage:v.coverage.status,target:v.coverage.targetCount,valid:v.coverage.validCount,missing:v.coverage.missing.length,
    replayed:v.transitionReplayed?count:0,topRows:delivery.models.reduce((n,m)=>n+m.records.length,0),authenticatedUi:"NOT_CHECKED"};
}
