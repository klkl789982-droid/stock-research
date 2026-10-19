import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { verifyCloudSiteFixture } from "./site-fixture.mjs";
import { verifyPreviewRelay, VERIFIED_PREVIEW_ORIGIN } from "./verify-preview-relay.mjs";
import { createDeliveryFixture, deliveryFixtureHash } from "../../lib/private-live-delivery-fixture.mjs";
const id = "aeb04979-d2a5-449e-a588-715b86a6d19b", origin = VERIFIED_PREVIEW_ORIGIN;
const hash = v => createHash("sha256").update(`${JSON.stringify(v, null, 2)}\n`).digest("hex");

test("cloud fixture only writes isolated Preview fixture/witness, never operational heads", async () => {
  const files = new Map();
  const store = { async writeImmutable(k, v) {
    if (files.has(k) && hash(files.get(k)) !== hash(v)) throw Object.assign(new Error("CONFLICT"), { code: "PRIVATE_STORE_IMMUTABLE_CONFLICT" });
    const existed = files.has(k); files.set(k, structuredClone(v)); return { contentHash: hash(v), status: existed ? "ALREADY_STORED" : "STORED_AND_VERIFIED" };
  }, async read(k) { return files.has(k) ? { value: files.get(k), contentHash: hash(files.get(k)) } : null; } };
  const result = await verifyCloudSiteFixture(store, id, "unit-isolated");
  assert.equal(result.fixtureHash, deliveryFixtureHash(id)); assert.equal(result.duplicate, "ALREADY_STORED");
  assert.equal(result.conflictBlocked, true); assert.equal(result.operationalPointerChanged, false); assert.equal(result.kisCalls, 0);
  assert.equal(result.freshWriteVerified, true);
  const retry = await verifyCloudSiteFixture(store, id, "unit-isolated");
  assert.equal(retry.freshWriteVerified, false); assert.equal(retry.witnessHash, result.witnessHash);
  assert.equal(files.size, 2); assert.ok([...files.keys()].every(k => k.startsWith("tests/") || k.startsWith("cloud-isolated-tests/")));
});

test("Preview login/read/hash/logout preserves the app authentication boundary", async () => {
  let authorized = false; const calls = [];
  const result = await verifyPreviewRelay({ origin, username: "fixture", password: "fixture-only", fixtureId: id, protectionToken: "fixture-short-lived-oidc",
    async fetchImpl(url, init) {
      const route = new URL(url).pathname; calls.push(route); assert.equal(init.redirect, "manual");
      assert.equal(new URL(url).origin, origin); assert.equal(init.headers["x-vercel-trusted-oidc-idp-token"], "fixture-short-lived-oidc");
      if (route === "/api/auth/login") { assert.equal(init.headers.Origin, origin); authorized = true; return Response.json({}, { headers: { "Set-Cookie": "__Host-tb-session=fixture-not-real; HttpOnly; Secure" } }); }
      if (route === "/api/auth/logout") { authorized = false; return Response.json({}); }
      if (!authorized) return Response.json({ error: { code: "AUTH_REQUIRED" } }, { status: 401 });
      return Response.json({ status: "SYNTHETIC_FIXTURE_VERIFIED", deliveryHash: deliveryFixtureHash(id), delivery: createDeliveryFixture(id) });
    } });
  assert.equal(result.topRows, 20); assert.equal(result.browserRenderingVerified, false);
  assert.ok(!JSON.stringify(result).includes("fixture-short-lived-oidc"));
  assert.equal(calls.length, 5); assert.equal(authorized, false);
});

test("platform protection is not mistaken for app authentication and never bypassed", async () => {
  let calls = 0;
  await assert.rejects(verifyPreviewRelay({ origin, username: "fixture", password: "fixture-only", fixtureId: id,
    async fetchImpl() { calls++; return new Response("Vercel authentication", { status: 401 }); } }), /DEPLOYMENT_PROTECTION/u);
  assert.equal(calls, 1);
  await assert.rejects(verifyPreviewRelay({ origin: "https://stock-research-chi.vercel.app" }), /ORIGIN_REJECTED/u);
  await assert.rejects(verifyPreviewRelay({ origin: "https://stock-research-git-integrate-other-account.vercel.app" }), /ORIGIN_REJECTED/u);
});
