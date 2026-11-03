import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, randomUUID } from "node:crypto";
import { createKisTokenManager, KisTokenManagerError } from "./kis-token-manager-core.mjs";

const refreshMs = 5 * 60_000, cooldownMs = 61_000;
const failure = (code) => new KisTokenManagerError(code);
// Both keys share a Redis cluster slot. No key in the admin session or rate limit namespace is touched.
const acquire = `local v=redis.call('GET',KEYS[1]); if v and v==ARGV[1] then redis.call('DEL',KEYS[1]); v=false end
if v then return {'token',v} end
local lock=redis.call('GET',KEYS[2]); if lock then return {lock=='cooldown' and 'cooldown' or 'wait',''} end
redis.call('SET',KEYS[2],ARGV[2],'PX',ARGV[3]); return {'owner',''}`;
const finish = `if redis.call('GET',KEYS[2])~=ARGV[1] then return 0 end
if ARGV[2]~='' then redis.call('SET',KEYS[1],ARGV[2],'PX',ARGV[3]) end
redis.call('SET',KEYS[2],'cooldown','PX',ARGV[4]); return 1`;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export function createKisReadTransport(fetchImpl = fetch) {
  return (input, init) => {
    const url = new URL(input);
    if (url.origin !== "https://openapi.koreainvestment.com:9443" || url.username || url.password)
      throw failure("KIS_DESTINATION_REJECTED");
    return fetchImpl(url, { ...init, redirect:"error" });
  };
}

function context({ appKey, appSecret }) {
  if (!appKey || !appSecret) throw failure("KIS_CREDENTIALS_MISSING");
  const scope = createHmac("sha256", appSecret).update("tb/kis/read/scope/v1\0"+appKey).digest("hex");
  const key = hkdfSync("sha256", appSecret, appKey, "tb/kis/read/encryption/v1",32);
  const prefix = "tb:kis:read:v1:{"+scope+"}";
  return { prefix, key };
}
function seal(record, ctx) {
  const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm",ctx.key,iv);
  cipher.setAAD(Buffer.from(ctx.prefix));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify([record.accessToken,record.expiresAtMs]),"utf8"),cipher.final()]);
  return [iv,cipher.getAuthTag(),ciphertext].map((v) => v.toString("base64url")).join(".");
}
function open(packed, ctx) {
  try {
    const pieces = packed.split(".");
    if (pieces.length !== 3 || packed.length > 32_768) throw new Error();
    const [iv,tag,data] = pieces.map((s) => Buffer.from(s,"base64url"));
    if (iv.length !== 12 || tag.length !== 16) throw new Error();
    const cipher = createDecipheriv("aes-256-gcm",ctx.key,iv);
    cipher.setAAD(Buffer.from(ctx.prefix)); cipher.setAuthTag(tag);
    const [accessToken,expiresAtMs] = JSON.parse(Buffer.concat([cipher.update(data),cipher.final()]).toString("utf8"));
    if (typeof accessToken !== "string" || !accessToken.length || !Number.isSafeInteger(expiresAtMs)) throw new Error();
    return { accessToken, expiresAtMs };
  } catch { throw failure("KIS_SHARED_TOKEN_INVALID"); }
}

/** Server-side read API only. Scheduled Cloud collectors keep their existing token manager. */
export function createSharedKisReadTokenManager({ getCredentials, command, fetchImpl = fetch, now = Date.now, sleep = wait }) {
  let current = null, flight = null, rejected = null, generation = 0;
  async function remote(args) {
    try { return await command(args); } catch { throw failure("KIS_SHARED_TOKEN_STORE_UNAVAILABLE"); }
  }
  async function resolve(ctx, credentials) {
    const keys = [ctx.prefix+":token",ctx.prefix+":guard"];
    const owner = randomUUID();
    let obsolete = rejected?.prefix === ctx.prefix ? rejected.packed : "";
    // The final check covers the owner's 8s token request plus a 5s Redis commit.
    for (const delay of [0,450,1800,6000,5200]) {
      if (delay) await sleep(delay);
      const response = await remote(["EVAL",acquire,2,...keys,obsolete,owner,cooldownMs]);
      if (!Array.isArray(response) || response.length !== 2) throw failure("KIS_SHARED_TOKEN_STORE_UNAVAILABLE");
      const [status,packed] = response;
      if (status === "wait") continue;
      if (status === "cooldown") throw failure("KIS_TOKEN_COOLDOWN");
      if (status === "token") {
        const record = open(packed,ctx);
        if (record.expiresAtMs - now() <= refreshMs) { obsolete = packed; continue; }
        return { prefix:ctx.prefix, packed, record:Object.freeze({...record,generation:++generation}) };
      }
      if (status !== "owner") throw failure("KIS_SHARED_TOKEN_STORE_UNAVAILABLE");
      // A crashed owner leaves a bounded guard. Never bypass Redis and issue in parallel.
      let issued;
      try {
        issued = await createKisTokenManager({ getCredentials:() => credentials, now,
          fetchImpl:(url,init) => fetchImpl(url,{ ...init,redirect:"error",signal:AbortSignal.timeout(8000) }) }).getToken();
      } catch (err) {
        await remote(["EVAL",finish,2,...keys,owner,"",0,cooldownMs]);
        throw err;
      }
      const ttl = Math.floor(issued.expiresAtMs - now() - refreshMs);
      if (ttl < 1) throw failure("KIS_TOKEN_EXPIRY_TOO_SOON");
      const encrypted = seal(issued,ctx);
      if (await remote(["EVAL",finish,2,...keys,owner,encrypted,ttl,cooldownMs]) !== 1) throw failure("KIS_TOKEN_LEASE_EXPIRED");
      return { prefix:ctx.prefix, packed:encrypted, record:Object.freeze({...issued,generation:++generation}) };
    }
    throw failure("KIS_TOKEN_ISSUANCE_IN_PROGRESS");
  }
  return {
    async getToken() {
      const credentials = getCredentials(), ctx = context(credentials);
      if (current?.prefix === ctx.prefix && current.record.expiresAtMs - now() > refreshMs) return current.record;
      if (flight?.prefix === ctx.prefix) return flight.task;
      const task = resolve(ctx,credentials).then((ready) => {
        if (flight?.task === task) { current=ready; rejected=null; }
        return ready.record;
      });
      flight={prefix:ctx.prefix,task};
      try { return await task; } finally { if (flight?.task === task) flight=null; }
    },
    invalidateIfCurrent(record) {
      if (!current || current.record !== record) return false;
      // The client's next getToken atomically compares the encrypted generation before eviction.
      rejected=current; current=null; return true;
    },
    clear() { current=null; rejected=null; flight=null; },
    getState:() => ({ hasUsableToken:!!current && current.record.expiresAtMs-now()>refreshMs, generation:current?.record.generation??0, issuing:!!flight }),
  };
}
