import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import { createKisEodPrivateStore } from "../lib/kis-eod-private-store.mjs";
import { createDeliveryFixture, deliveryFixtureBytes, deliveryFixtureHash, deliveryFixtureKey, deliveryFixtureEnvironmentAllowed } from "../lib/private-live-delivery-fixture.mjs";
import { privateLiveDeliveryResponse } from "../lib/private-live-delivery.mjs";
import { verifySiteRelayReader } from "../lib/private-live-reader-probe.mjs";

const id = "aeb04979-d2a5-449e-a588-715b86a6d19b";
const env = { VERCEL_ENV: "preview", PRIVATE_LIVE_DELIVERY_READ_ENABLED: "true", PRIVATE_LIVE_DELIVERY_REPOSITORY: "fixture/private",
  PRIVATE_LIVE_DELIVERY_READ_TOKEN: "SYNTHETIC_READER", PRIVATE_LIVE_DELIVERY_FIXTURE_ID: id, PRIVATE_LIVE_DELIVERY_FIXTURE_SHA256: deliveryFixtureHash(id) };
const request = () => new Request("https://preview.example/api/private-live-delivery");
function backend() {
  let bytes = null; const requests = [];
  const state = { deny: false, public: false, tamper: false };
  const fetchImpl = async (url, init) => {
    requests.push({ method: init.method, url });
    if (state.deny) return new Response(null, { status: 401 });
    if (!url.includes("/contents/")) return Response.json({ private: !state.public, full_name: "fixture/private" });
    assert.ok(url.includes(`/tests/site-delivery/${id}/fixture.json`));
    if (init.method === "PUT") {
      if (init.headers.Authorization === "Bearer SYNTHETIC_READER") return new Response(null, { status: 403 });
      if (bytes) return new Response(null, { status: 422 });
      const body = JSON.parse(init.body); assert.equal(body.sha, undefined);
      bytes = Buffer.from(body.content, "base64").toString(); return Response.json({}, { status: 201 });
    }
    if (!bytes) return new Response(null, { status: 404 });
    const output = state.tamper ? bytes.replace('"score": 50', '"score": 51') : bytes;
    return Response.json({ type: "file", size: Buffer.byteLength(output), encoding: "base64", content: Buffer.from(output).toString("base64") });
  };
  return { state, requests, fetchImpl, writer: createKisEodPrivateStore({ repository: "fixture/private", token: "SYNTHETIC_WRITER", fetchImpl }) };
}
test("isolated synthetic relay: create, duplicate, conflict, read-only API, pinned hash", async () => {
  const b = backend(), value = createDeliveryFixture(id), key = deliveryFixtureKey(id);
  assert.equal((await b.writer.writeImmutable(key, value)).status, "STORED_AND_VERIFIED");
  assert.equal((await b.writer.writeImmutable(key, value)).status, "ALREADY_STORED");
  const changed = structuredClone(value); changed.models[0].records[0].score++;
  await assert.rejects(b.writer.writeImmutable(key, changed), /IMMUTABLE_CONFLICT/);
  assert.equal((await b.writer.read(key)).bytes, deliveryFixtureBytes(id));
  b.requests.length = 0;
  const response = await privateLiveDeliveryResponse(request(), { env, fetchImpl: b.fetchImpl });
  assert.equal(response.status, 200); assert.match(response.headers.get("cache-control"), /private, no-store/);
  const body = await response.json(); assert.equal(body.deliveryHash, deliveryFixtureHash(id));
  assert.equal(body.status, "SYNTHETIC_FIXTURE_VERIFIED"); assert.equal(body.delivery.observationType, "SYNTHETIC_FIXTURE");
  assert.ok(b.requests.every(x => x.method === "GET"));
  assert.ok(b.requests.every(x => !/heads|latest|objects/.test(x.url)));
  assert.doesNotMatch(JSON.stringify(body), /SYNTHETIC_READER|SYNTHETIC_WRITER|LIVE_OBSERVATION|signalDate/);
});
test("Production, development and disabled fixture are blocked before network", async () => {
  const fetchImpl = () => { throw new Error("NO_NETWORK_ALLOWED"); };
  for (const VERCEL_ENV of ["production", "development", undefined]) {
    assert.equal((await privateLiveDeliveryResponse(request(), { env: { ...env, VERCEL_ENV }, fetchImpl })).status, 404);
  }
  assert.equal((await privateLiveDeliveryResponse(request(), { env: { ...env, PRIVATE_LIVE_DELIVERY_READ_ENABLED: "false" }, fetchImpl })).status, 404);
});
test("fixture accepts Preview only, including when obsolete local flags are supplied", () => {
  const localEnv = { PRIVATE_LIVE_DELIVERY_FIXTURE_LOCAL_ENABLED: "true", TB_AUTH_ORIGIN: "http://127.0.0.1:14066" };
  const local = new Request("http://127.0.0.1:14066/api/private-live-delivery", { headers: { host: "127.0.0.1:14066" } });
  assert.equal(deliveryFixtureEnvironmentAllowed(local, localEnv), false);
  for (const change of [{ VERCEL: "1" }, { VERCEL_ENV: "production" }, { PRIVATE_LIVE_DELIVERY_FIXTURE_LOCAL_ENABLED: "false" }, { TB_AUTH_ORIGIN: "https://public.example" }]) assert.equal(deliveryFixtureEnvironmentAllowed(local, { ...localEnv, ...change }), false);
  assert.equal(deliveryFixtureEnvironmentAllowed(request(), localEnv), false);
  assert.equal(deliveryFixtureEnvironmentAllowed(new Request(local.url, { headers: { host: "public.example" } }), localEnv), false);
});
test("tamper, unpinned hash, unknown path, missing fixture, public repo and auth failure fail closed", async () => {
  const b = backend();
  assert.equal((await privateLiveDeliveryResponse(request(), { env, fetchImpl: b.fetchImpl })).status, 503);
  await b.writer.writeImmutable(deliveryFixtureKey(id), createDeliveryFixture(id));
  for (const state of ["tamper", "public", "deny"]) {
    b.state[state] = true;
    assert.equal((await privateLiveDeliveryResponse(request(), { env, fetchImpl: b.fetchImpl })).status, 503);
    b.state[state] = false;
  }
  for (const change of [{ PRIVATE_LIVE_DELIVERY_FIXTURE_SHA256: "a".repeat(64) }, { PRIVATE_LIVE_DELIVERY_FIXTURE_ID: "../../latest" }]) {
    assert.equal((await privateLiveDeliveryResponse(request(), { env: { ...env, ...change }, fetchImpl: b.fetchImpl })).status, 503);
  }
});
test("read-only proof requires successful private read then single isolated create-only denial", async () => {
  for (const status of [403, 201, 401, 429, 500]) {
    let puts = 0;
    const fetchImpl = async (url, init) => {
      if (init.method === "PUT") {
        puts++;
        assert.match(url, new RegExp(`/tests/site-delivery/${id}/read-only-probe-[a-f0-9-]+[.]json$`));
        assert.equal(JSON.parse(init.body).sha, undefined);
        assert.equal(init.redirect, "error");
        return new Response(null, { status });
      }
      if (!url.includes("/contents/")) return Response.json({ private: true, full_name: "klkl789982-droid/tight-budget-private-data" });
      const bytes = deliveryFixtureBytes(id);
      return Response.json({ type: "file", size: Buffer.byteLength(bytes), encoding: "base64", content: Buffer.from(bytes).toString("base64") });
    };
    const result = await verifySiteRelayReader({ env: { ...env, PRIVATE_LIVE_DELIVERY_REPOSITORY: "klkl789982-droid/tight-budget-private-data" }, fetchImpl });
    assert.equal(puts, 1); assert.equal(result.writeDenied, status === 403);
    if (status === 201) assert.equal(result.permissionStatus, "READER_OVERPRIVILEGED");
  }
});
test("Preview probe POST requires session wrapper, origin, exact action and no query", async () => {
  const names = ["VERCEL_ENV", "PRIVATE_LIVE_DELIVERY_READ_ENABLED", "PRIVATE_LIVE_DELIVERY_FIXTURE_ID"];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  let calls = 0, signedIn = true;
  const exports = {}, source = await readFile(new URL("../app/api/private-live-delivery/route.ts", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  new Function("require", "exports", compiled)(name => {
    if (name === "@/lib/admin-access") return { withAdminAccess: handler => request => signedIn ? handler(request) : Response.json({}, { status: 401 }) };
    if (name === "@/lib/private-live-delivery.mjs") return { privateLiveDeliveryResponse };
    if (name === "@/lib/admin-auth.mjs") return { authConfig: () => ({}), sameOriginMutation: request => request.headers.get("origin") === "https://preview.example", authError: status => Response.json({}, { status }) };
    if (name === "@/lib/private-live-reader-probe.mjs") return { verifySiteRelayReader: async () => { calls++; return { writeDenied: true }; } };
    throw new Error(name);
  }, exports);
  const post = (body = '{"action":"verify-read-only"}', origin = "https://preview.example", query = "") => new Request(`https://preview.example/api/private-live-delivery${query}`, { method: "POST", headers: { origin, "content-type": "application/json" }, body });
  try {
    Object.assign(process.env, { VERCEL_ENV: "production", PRIVATE_LIVE_DELIVERY_READ_ENABLED: "true", PRIVATE_LIVE_DELIVERY_FIXTURE_ID: id });
    assert.equal((await exports.POST(post())).status, 404);
    process.env.VERCEL_ENV = "preview";
    signedIn = false; assert.equal((await exports.POST(post())).status, 401); signedIn = true;
    assert.equal((await exports.POST(post(undefined, "https://other.example"))).status, 403);
    assert.equal((await exports.POST(post('{}'))).status, 400);
    assert.equal((await exports.POST(post(undefined, undefined, "?path=latest"))).status, 400);
    assert.equal(calls, 0); assert.equal((await exports.POST(post())).status, 200); assert.equal(calls, 1);
  } finally { for (const name of names) { if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name]; } }
});
