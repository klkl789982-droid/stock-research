import { createHash } from "node:crypto";
import { normalizeStockCode } from "./stock-code.mjs";

export const WATCHLIST_LIMIT = 50;
const addMember = `if redis.call('HEXISTS',KEYS[1],ARGV[1]) == 1 then return 0 end
if redis.call('HLEN',KEYS[1]) >= tonumber(ARGV[3]) then return -1 end
return redis.call('HSET',KEYS[1],ARGV[1],ARGV[2])`;

// The current login supports one configured principal. The caller obtains it
// only after the server verifies the signed, unexpired Redis session.
export function createWatchlistStore({ username, origin }, command) {
  if (!username || !origin) throw new Error("WATCHLIST_IDENTITY_REQUIRED");
  const owner = createHash("sha256").update(JSON.stringify([origin, username])).digest("hex");
  const key = "tb:watchlist:v1:" + owner;
  return {
    async list() {
      const raw = await command(["HGETALL", key]);
      if (!Array.isArray(raw) || raw.length % 2 || raw.length > WATCHLIST_LIMIT * 2) throw new Error("WATCHLIST_DATA_INVALID");
      const result = [];
      for (let i = 0; i < raw.length; i += 2) {
        const item = JSON.parse(raw[i + 1]);
        if (!item || normalizeStockCode(raw[i]) !== raw[i] || item.code !== raw[i] ||
            typeof item.name !== "string" || !item.name || typeof item.market !== "string") throw new Error("WATCHLIST_DATA_INVALID");
        result.push({ code: item.code, name: item.name, market: item.market });
      }
      return result.sort((a, b) => a.name.localeCompare(b.name, "ko") || a.code.localeCompare(b.code));
    },
    async add({ code, name, market }) {
      const result = await command(["EVAL", addMember, 1, key, code, JSON.stringify({ code, name, market }), WATCHLIST_LIMIT]);
      if (![-1, 0, 1].includes(result)) throw new Error("WATCHLIST_STORAGE_UNAVAILABLE");
      return result;
    },
    async remove(code) {
      const result = await command(["HDEL", key, code]);
      if (result !== 0 && result !== 1) throw new Error("WATCHLIST_STORAGE_UNAVAILABLE");
    },
  };
}
