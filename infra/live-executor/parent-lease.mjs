/** Managed Node children must not keep collecting after their supervisor dies.
 * IPC heartbeats are a process-lifetime lease, not a collection signal.
 * The timeout also covers Windows handle inheritance delaying disconnect.
 * A standalone CLI has no IPC channel and keeps its existing lifecycle.
 */
export function enforceParentLease(runtime = process, { timeoutMs = 5000 } = {}) {
  if (!runtime.channel) return false;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 5000) throw new Error("PARENT_LEASE_TIMEOUT_INVALID");
  const stop = () => runtime.exit(1);
  let generation = 0, lastLeaseAt = Date.now(), receivedCount = 0, futureCount = 0, staleCount = 0;
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
          leaseAgeMs: Math.min(86400000, Math.max(0, Date.now() - lastLeaseAt)),
          timerDelayMs: Math.min(86400000, Math.max(0, Date.now() - lastLeaseAt - timeoutMs)), timeoutMs,
          leaseReceivedCount: receivedCount, leaseFutureRejectedCount: futureCount, leaseStaleRejectedCount: staleCount }, () => stop()); }
        catch { stop(); }
        setTimeout(stop, 100).unref();
      } else stop();
    });
  };
  let timer = setTimeout(expire, timeoutMs);
  timer.unref();
  runtime.on("message", (message) => {
    if (message?.type !== "HOST_LEASE") return;
    receivedCount += 1;
    // New managed hosts timestamp leases. An old queued message must not
    // extend a dead parent's lifetime; legacy fixtures remain supported.
    const wireAgeMs = message.sentAtMs === undefined ? null : Date.now() - message.sentAtMs;
    const future = message.sentAtMs !== undefined && (!Number.isFinite(message.sentAtMs) || wireAgeMs < 0);
    const stale = Number.isFinite(wireAgeMs) && wireAgeMs > timeoutMs;
    if (future) futureCount += 1;
    if (stale) staleCount += 1;
    if (runtime.connected && typeof runtime.send === "function") {
      try { runtime.send({ type: "EXECUTOR_LEASE_RECEIPT", accepted: !future && !stale,
        wireAgeMs: Number.isFinite(wireAgeMs) ? Math.max(-86400000, Math.min(86400000, wireAgeMs)) : null,
        receivedCount, futureCount, staleCount }, () => {}); } catch { /* expiry/disconnect still fails closed */ }
    }
    if (future || stale) return;
    generation += 1; lastLeaseAt = Date.now();
    clearTimeout(timer); timer = setTimeout(expire, timeoutMs); timer.unref();
  });
  runtime.once("disconnect", stop);
  if (!runtime.connected) stop();
  return true;
}
