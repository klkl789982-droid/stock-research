import { createLiveDelivery, validateLiveDelivery, deliverPrivateLive } from "../../lib/private-live-delivery.mjs";

// Opt-in building block, not registered in the host scheduler. Caller supplies
// the existing external-directory local store and the private GitHub adapter.
export async function queueSiteDelivery(localStore, rawModels, clock = () => new Date().toISOString()) {
  const now = clock(), candidate = createLiveDelivery(rawModels, { exportedAt: now, now });
  const key = `live/site-outbox/${candidate.signalDate}/${candidate.sourceHash}.json`;
  return localStore.withLock(`site-export-${candidate.sourceHash}`, async () => {
    const existing = await localStore.read(key);
    if (existing) {
      validateLiveDelivery(existing, now);
      const same = createLiveDelivery(rawModels, { exportedAt: existing.exportedAt, now });
      if (same.deliveryHash !== existing.deliveryHash) throw new Error("PRIVATE_LIVE_OUTBOX_SOURCE_CONFLICT");
      return { key, deliveryHash: existing.deliveryHash };
    }
    await localStore.writeImmutable(key, candidate);
    return { key, deliveryHash: candidate.deliveryHash };
  });
}

export async function flushSiteDelivery(localStore, remoteStore, key, clock = () => new Date().toISOString()) {
  if (!/^live\/site-outbox\/\d{4}-\d{2}-\d{2}\/[a-f0-9]{64}\.json$/u.test(key)) throw new Error("PRIVATE_LIVE_OUTBOX_KEY_INVALID");
  const value = await localStore.read(key);
  validateLiveDelivery(value, clock());
  if (key !== `live/site-outbox/${value.signalDate}/${value.sourceHash}.json`) throw new Error("PRIVATE_LIVE_OUTBOX_KEY_MISMATCH");
  return localStore.withLock(`site-upload-${value.deliveryHash}`, async () => {
    const result = await deliverPrivateLive(remoteStore, value, { now: clock() });
    const receiptKey = `live/site-receipts/${value.deliveryHash}.json`;
    const existing = await localStore.read(receiptKey);
    if (existing) {
      if (existing.deliveryHash !== value.deliveryHash || existing.status !== result.status || existing.websiteVerified !== false) throw new Error("PRIVATE_LIVE_RECEIPT_INVALID");
      return existing;
    }
    const receipt = { ...result, relayVerifiedAt: clock() };
    await localStore.writeImmutable(receiptKey, receipt);
    return receipt;
  });
}
