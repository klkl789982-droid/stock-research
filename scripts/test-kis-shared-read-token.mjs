import assert from "node:assert/strict";
import { createKisReadTransport, createSharedKisReadTokenManager } from "../lib/kis-shared-read-token.mjs";
import { createKisApiClient } from "../lib/kis-api-client-core.mjs";

// Atomic Redis fixture with a controllable clock. Token issuer + business request are isolated.
const makeFixture = () => {
  let time = Date.parse("2026-11-03T05:00:00Z"), issues = 0, reject = false, offline = false;
  const keys = new Map(), calls = [];
  function get(k) {
    const row = keys.get(k); return row && row.until>time ? row.value : null;
  }
  const set = (k,value,ms) => keys.set(k,{value,until:time+ms});
  const command = async (args) => {
    if (offline) throw Error("synthetic-sensitive-upstream");
    calls.push(args);
    const [,lua,n,key,guard,...p]=args;
    assert.equal(n,2);
    assert.equal(/tb:kis:read:v1:\{[a-f\d]{64}\}:token/.test(key),true);
    if (lua.includes("'owner'")) {
      const [old,id,ttl] = p;
      if (get(key) && old === get(key)) keys.delete(key);
      if (get(key)) return ["token",get(key)];
      if (get(guard)) return [get(guard)==="cooldown"?"cooldown":"wait",""];
      set(guard,id,ttl);return ["owner",""];
    }
    const [id,packed,ttl,guardTtl]=p;
    if (get(guard)!==id) return 0;
    if (packed) set(key,packed,ttl);
    set(guard,"cooldown",guardTtl); return 1;
  };
  const manager = (secret="fixture-secret-A",overrides={}) => createSharedKisReadTokenManager({
    command,getCredentials:() => ({appKey:"fixture-key-A",appSecret:secret}),now:() => time,
    sleep:() => new Promise((finish) => setTimeout(finish,5)),
    fetchImpl:async (_url,init) => {
      assert.equal(init.redirect,"error");
      issues++; await new Promise((finish) => setTimeout(finish,2));
      if (reject) return Response.json({error_code:"EGW00133"},{status:403});
      return Response.json({access_token:"synthetic-access-"+issues,expires_in:3600});
    }, ...overrides,
  });
  return { manager,keys,calls,issues:()=>issues, tick:(ms) => {time+=ms;},rateLimit:(v)=>{reject=v;}, offline:(v)=>{offline=v;} };
};
const f=makeFixture(), a=f.manager(), b=f.manager();
const [first,second] = await Promise.all([a.getToken(),b.getToken()]);
assert.equal(first.accessToken,second.accessToken);assert.equal(f.issues(),1);
const redisBytes=JSON.stringify(f.calls);
for(const sensitive of ["fixture-secret-A","fixture-key-A",first.accessToken]) assert.ok(!redisBytes.includes(sensitive));
const size=f.calls.length;await a.getToken();assert.equal(f.calls.length,size,"warm reads cost zero Redis operations");
const oldToken=await f.manager().getToken();assert.equal(oldToken.accessToken,first.accessToken);
f.tick(62_000);
assert.equal(a.invalidateIfCurrent(first),true);
assert.notEqual((await a.getToken()).accessToken,first.accessToken);
assert.equal(b.invalidateIfCurrent(second),true);
assert.equal((await b.getToken()).accessToken,(await a.getToken()).accessToken);
assert.equal(f.issues(),2,"delayed old 401 did not evict fresh generation");
await f.manager("different-credential").getToken();assert.equal(f.issues(),3,"credentials have separate encrypted records");
f.tick(55*60_000+1);assert.equal((await a.getToken()).accessToken,"synthetic-access-4");
const limited=makeFixture();limited.rateLimit(true);
await assert.rejects(limited.manager().getToken(),/KIS_TOKEN_HTTP_403_EGW00133/);
await assert.rejects(limited.manager().getToken(),/KIS_TOKEN_COOLDOWN/);
assert.equal(limited.issues(),1);
limited.tick(61_001);limited.rateLimit(false);await limited.manager().getToken();
const tampered=[...limited.keys].find(([k])=>k.endsWith(":token"))[1];tampered.value="invalid.wire.ciphertext";
await assert.rejects(limited.manager().getToken(),/KIS_SHARED_TOKEN_INVALID/);
assert.equal(limited.issues(),2,"corruption cannot authorize unchecked parallel reissuance");
limited.offline(true);
await assert.rejects(limited.manager().getToken(),/KIS_SHARED_TOKEN_STORE_UNAVAILABLE/);
const i=makeFixture(), manager=i.manager(), old=(await manager.getToken()).accessToken;
i.tick(62_000);
const client=createKisApiClient({tokenManager:manager,getCredentials:() => ({appKey:"fixture-key-A",appSecret:"fixture-secret-A"}),
  fetchImpl:async (_url,init) => new Response(null,{status:init.headers.authorization==="Bearer "+old?401:200})});
assert.equal((await client.request("https://synthetic.invalid")).status,200);
assert.equal(i.issues(),2);
const redirects=[];
const transport=createKisReadTransport(async (_url,init) => { redirects.push(init.redirect);return Response.json({}); });
for (const endpoint of ["/oauth2/tokenP","/uapi/domestic-stock/v1/quotations/inquire-price"])
  await transport("https://openapi.koreainvestment.com:9443"+endpoint,{redirect:"follow"});
assert.deepEqual(redirects,["error","error"]);
assert.throws(() => transport("https://untrusted.invalid/oauth2/tokenP",{}),/KIS_DESTINATION_REJECTED/);
const slow=makeFixture();
let completeIssue,elapsed=0;
const slowOwner=slow.manager(undefined,{fetchImpl:()=>new Promise((resolve)=>{completeIssue=resolve;})});
const owner=slowOwner.getToken();while(!completeIssue) await Promise.resolve();
const follower=slow.manager(undefined,{sleep:async (ms)=>{
  elapsed+=ms;
  if(elapsed>=7900&&completeIssue){completeIssue(Response.json({access_token:"slow-token",expires_in:3600}));completeIssue=null;await owner;}
}});
assert.equal((await follower.getToken()).accessToken,(await owner).accessToken);
assert.ok(elapsed>=7900&&elapsed<=14_000);
console.log("PASS: cross-instance single-flight, encrypted credential scopes, warm local reads, refresh and cooldown, stale 401 compare/delete, store fail-closed, auth client retry");
