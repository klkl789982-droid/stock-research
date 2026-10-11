// Exercise the built Production server with absent auth configuration: fail closed.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const listener = http.createServer();
await new Promise(resolve => listener.listen(0, "127.0.0.1", resolve));
const port = listener.address().port;
await new Promise(resolve => listener.close(resolve));
const env = { ...process.env, NODE_ENV: "production" };
for (const name of Object.keys(env)) if (/^TB_(ADMIN_|AUTH_|SESSION_|AUTOMATION_)/u.test(name)) delete env[name];
const child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(port), "-H", "127.0.0.1"], { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
let exited = false;
child.on("exit", () => { exited = true; });
child.stdout.on("data", () => {});
child.stderr.on("data", () => {});
const origin = `http://127.0.0.1:${port}`;
const request = (path, init = {}) => fetch(`${origin}${path}`, { ...init, redirect: "manual" });
try {
  let ready = false;
  for (let i = 0; i < 60 && !exited; i++) { try { ready = (await request("/login")).ok; if (ready) break; } catch {} await wait(500); }
  assert.ok(ready, "Production server must start without auth env");
  for (const path of ["/", "/?stock=005930", "/data/history/2026-10-07.json", "/_next/image?url=%2Fapi%2Fprice&w=64&q=75"]) assert.equal((await request(path)).status, 307, path);
  for (const path of ["/api/top-stocks", "/api/home-dashboard", "/api/model-performance", "/api/screener", "/api/auth/session"]) {
    const response = await request(path, { headers: { Cookie: "__Host-tb-session=v1.forged", Authorization: "Bearer invalid" } });
    assert.equal(response.status, 503, path);
    assert.equal((await response.json()).error.code, "AUTH_UNAVAILABLE");
    assert.ok(response.headers.get("cache-control").includes("no-store"));
  }
  const login = await request("/api/auth/login", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ username: "fixture", password: "fixture-not-real" }) });
  assert.equal(login.status, 503);
  assert.equal(login.headers.get("set-cookie"), null);
  console.log("Production fail-closed passed: absent environment, protected pages/static/API, forged cookie/token, no session issued");
} finally {
  child.kill();
  for (let i = 0; i < 50 && !exited; i++) await wait(100);
}
