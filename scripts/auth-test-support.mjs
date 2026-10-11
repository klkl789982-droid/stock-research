// Synthetic authentication test store only. Never used by app/Production.
import http from "node:http";
export function memoryAuthStore(now = Date.now) {
  const records = new Map(), attempts = new Map();
  return {
    records, attempts,
    async create(key, record) { if (records.has(key)) throw new Error("CONFLICT"); records.set(key, structuredClone(record)); },
    async read(key) { return records.get(key) ?? null; },
    async remove(key) { records.delete(key); },
    async takeAttempt(identity) { const old = attempts.get(identity); const value = !old || old.expiresAt <= now() ? { count: 1, expiresAt: now() + 900000 } : { ...old, count: old.count + 1 }; attempts.set(identity, value); return value.count <= 5; },
  };
}
export async function redisFixtureServer(token) {
  const rows = new Map();
  const get = (key) => { const row = rows.get(key); if (row && row.expiry <= Date.now()) { rows.delete(key); return null; } return row?.value ?? null; };
  const server = http.createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401); res.end('{"error":"UNAUTHORIZED"}'); return; }
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const [command, ...args] = JSON.parse(Buffer.concat(chunks).toString()); let result;
      if (command === "GET") result = get(args[0]);
      else if (command === "DEL") result = Number(rows.delete(args[0]));
      else if (command === "SET") { result = get(args[0]) !== null ? null : "OK"; if (result) rows.set(args[0], { value: args[1], expiry: Date.now() + Number(args[3]) * 1000 }); }
      else if (command === "EVAL") { result = args.slice(2, 4).map(key => { const value = Number(get(key) ?? 0) + 1; rows.set(key, { value, expiry: rows.get(key)?.expiry ?? Date.now() + Number(args[4]) * 1000 }); return value; }); }
      else throw new Error("INVALID_COMMAND");
      res.end(JSON.stringify({ result }));
    } catch { res.writeHead(400); res.end('{"error":"INVALID_FIXTURE_COMMAND"}'); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, reset: () => rows.clear(), close: () => new Promise(resolve => server.close(resolve)) };
}
