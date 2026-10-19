import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

/** A fresh one-use child challenge proves the parent is still responding.
 * Cross-process Date.now() is diagnostic only: Windows can report a parent's
 * send time ahead of the child's receive time even while both are healthy.
 * A replay or a reply older than this child's monotonic deadline cannot renew.
 */
export function enforceParentLease(runtime = process, { timeoutMs = 5000, monotonicNow = () => performance.now() } = {}) {
  if (!runtime.channel) return false;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 5000) throw new Error("PARENT_LEASE_TIMEOUT_INVALID");
  const stop = () => runtime.exit(1), pending = new Map();
  let generation = 0, lastLeaseAt = monotonicNow(), receivedCount = 0, futureCount = 0, staleCount = 0, nonceRejectedCount = 0;
  const expire = () => {
    const expiredGeneration = generation;
    // An overdue timer can run before an already-arrived IPC poll callback
    // after synchronous work. Drain ONE poll/check turn, not another timeout.
    // A dead/stalled parent with no fresh lease still terminates the child.
    setImmediate(() => {
      if (expiredGeneration !== generation) return;
      // Never include process.env, commands or arbitrary error text.
      if (runtime.connected && typeof runtime.send === "function") {
        try { runtime.send({ type: "EXECUTOR_DIAGNOSTIC", event: "executorError", reason: "PARENT_LEASE_EXPIRED",
          leaseAgeMs: Math.min(86400000, Math.max(0, monotonicNow() - lastLeaseAt)),
          timerDelayMs: Math.min(86400000, Math.max(0, monotonicNow() - lastLeaseAt - timeoutMs)), timeoutMs,
          leaseReceivedCount: receivedCount, leaseFutureObservedCount: futureCount, leaseStaleRejectedCount: staleCount,
          leaseNonceRejectedCount: nonceRejectedCount }, () => stop()); }
        catch { stop(); }
        setTimeout(stop, 100).unref();
      } else stop();
    });
  };
  let timer = setTimeout(expire, timeoutMs);
  timer.unref();
  const challenge = () => {
    const at = monotonicNow();
    for (const [id, issuedAt] of pending) if (at - issuedAt > timeoutMs) pending.delete(id);
    if (pending.size >= 16) return;
    const nonce = randomUUID(); pending.set(nonce, at);
    try { runtime.send({ type: "EXECUTOR_LEASE_CHALLENGE", nonce }, () => {}); } catch { /* expiry/disconnect fail closed */ }
  };
  runtime.on("message", (message) => {
    if (message?.type !== "HOST_LEASE") return;
    receivedCount += 1;
    const at = monotonicNow(), issuedAt = pending.get(message.nonce);
    const roundTripMs = issuedAt === undefined ? null : at - issuedAt;
    pending.delete(message.nonce);
    const invalidNonce = issuedAt === undefined;
    const stale = roundTripMs !== null && (roundTripMs < 0 || roundTripMs > timeoutMs);
    const wireAgeMs = Number.isFinite(message.sentAtMs) ? Date.now() - message.sentAtMs : null;
    if (wireAgeMs !== null && wireAgeMs < 0) futureCount += 1;
    if (invalidNonce) nonceRejectedCount += 1;
    if (stale) staleCount += 1;
    if (runtime.connected && typeof runtime.send === "function") {
      try { runtime.send({ type: "EXECUTOR_LEASE_RECEIPT", accepted: !invalidNonce && !stale,
        wireAgeMs: Number.isFinite(wireAgeMs) ? Math.max(-86400000, Math.min(86400000, wireAgeMs)) : null,
        roundTripMs, receivedCount, futureCount, staleCount, nonceRejectedCount }, () => {}); } catch { /* expiry/disconnect still fails closed */ }
    }
    if (invalidNonce || stale) return;
    generation += 1; lastLeaseAt = at;
    clearTimeout(timer); timer = setTimeout(expire, timeoutMs); timer.unref();
  });
  runtime.once("disconnect", stop);
  if (!runtime.connected) { stop(); return true; }
  challenge();
  setInterval(challenge, Math.min(1000, Math.floor(timeoutMs / 3))).unref();
  return true;
}
