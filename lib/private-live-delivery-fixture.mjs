import { createHash } from "node:crypto";

// No production head/latest pointer; deterministic contents exclude real prices.
const validId = id => /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(id ?? "");
export function deliveryFixtureKey(id) {
  if (!validId(id)) throw new Error("DELIVERY_FIXTURE_ID_INVALID");
  return `tests/site-delivery/${id}/fixture.json`;
}
export function createDeliveryFixture(id) {
  deliveryFixtureKey(id);
  return { schemaVersion: 1, namespace: "private-live-delivery-fixture-v1", observationType: "SYNTHETIC_FIXTURE", testRunId: id,
    models: ["A", "B", "C", "D"].map(model => ({ model, modelVersion: "SYNTHETIC-NOT-A-MODEL",
      records: Array.from({ length: 5 }, (_, i) => ({ ticker: `TEST-${model}-${i + 1}`, companyName: `합성 연결검증 ${model}-${i + 1}`, rank: i + 1, score: 50 - i })) })) };
}
export const deliveryFixtureBytes = id => `${JSON.stringify(createDeliveryFixture(id), null, 2)}\n`;
export const deliveryFixtureHash = id => createHash("sha256").update(deliveryFixtureBytes(id)).digest("hex");

export function deliveryFixtureEnvironmentAllowed(_request, env) {
  return env.VERCEL_ENV === "preview";
}
export async function readDeliveryFixture(store, env, request) {
  // Preview only; never the operational website.
  if (!deliveryFixtureEnvironmentAllowed(request, env)) throw new Error("DELIVERY_FIXTURE_TEST_ENV_ONLY");
  const id = env.PRIVATE_LIVE_DELIVERY_FIXTURE_ID;
  const expectedHash = deliveryFixtureHash(id);
  if (env.PRIVATE_LIVE_DELIVERY_FIXTURE_SHA256 !== expectedHash) throw new Error("DELIVERY_FIXTURE_HASH_NOT_PINNED");
  await store.verifyPrivateRepository();
  const stored = await store.read(deliveryFixtureKey(id));
  if (!stored || stored.contentHash !== expectedHash || stored.bytes !== deliveryFixtureBytes(id)) throw new Error("DELIVERY_FIXTURE_MISMATCH");
  return { status: "SYNTHETIC_FIXTURE_VERIFIED", source: "privateRelayFixture", freshnessStatus: "NOT_APPLICABLE",
    deliveryHash: expectedHash, delivery: createDeliveryFixture(id) };
}
