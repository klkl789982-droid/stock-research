import { createDeliveryFixture, deliveryFixtureKey, deliveryFixtureHash } from "../../lib/private-live-delivery-fixture.mjs";

// Reuse the existing Preview fixture contract. No operational object/head,
// actual ticker, raw price, or invented14:00 observation can be written here.
export async function verifyCloudSiteFixture(store, id, run) {
  if (!/^[A-Za-z0-9_-]{1,48}$/u.test(run ?? "")) throw new Error("DIAG_RUN_ID_INVALID");
  const key = deliveryFixtureKey(id), fixture = createDeliveryFixture(id), expected = deliveryFixtureHash(id);
  const first = await store.writeImmutable(key, fixture);
  const duplicate = await store.writeImmutable(key, fixture);
  let conflictBlocked = false;
  try { await store.writeImmutable(key, { ...fixture, observationType: "DIFFERENT_FIXTURE" }); }
  catch (e) { if (e.code !== "PRIVATE_STORE_IMMUTABLE_CONFLICT") throw e; conflictBlocked = true; }
  const reread = await store.read(key);
  if (!conflictBlocked || first.contentHash !== expected || duplicate.contentHash !== expected || reread?.contentHash !== expected) throw new Error("DIAG_SITE_FIXTURE_HASH_MISMATCH");
  // A fresh create-only witness proves this invocation can write now, even if
  // the fixed Preview fixture was already stored by an earlier verification.
  const witness = { namespace: "cloud-preview-relay-witness-v1", run, fixtureId: id, fixtureHash: expected,
    sourcePricesIncluded: false, operationalPointerChanged: false, publicationEligible: false };
  const witnessKey = `cloud-isolated-tests/site-relay/${run}.json`;
  const written = await store.writeImmutable(witnessKey, witness);
  if ((await store.read(witnessKey))?.contentHash !== written.contentHash) throw new Error("DIAG_SITE_FIXTURE_HASH_MISMATCH");
  return { status: "CLOUD_PREVIEW_FIXTURE_PRESERVED", fixtureHash: expected, witnessHash: written.contentHash,
    freshWriteVerified: written.status === "STORED_AND_VERIFIED", duplicate: duplicate.status, conflictBlocked, topRows: 20, operationalPointerChanged: false, sourcePricesIncluded: false, kisCalls: 0 };
}
