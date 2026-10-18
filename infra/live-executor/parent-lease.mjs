/** Managed Node children must not keep collecting after their supervisor dies.
 * IPC heartbeats are a process-lifetime lease, not a collection signal.
 * The timeout also covers Windows handle inheritance delaying disconnect.
 * A standalone CLI has no IPC channel and keeps its existing lifecycle.
 */
export function enforceParentLease(runtime = process, { timeoutMs = 5000 } = {}) {
  if (!runtime.channel) return false;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 5000) throw new Error("PARENT_LEASE_TIMEOUT_INVALID");
  const stop = () => runtime.exit(1);
  const expire = () => {
    // Report a fixed code before stopping; the original timeout/kill policy is
    // unchanged. Never include process.env, commands or arbitrary error text.
    if (runtime.connected && typeof runtime.send === "function") {
      try { runtime.send({ type: "EXECUTOR_DIAGNOSTIC", event: "executorError", reason: "PARENT_LEASE_EXPIRED" }, () => stop()); }
      catch { stop(); }
      setTimeout(stop, 100).unref();
    } else stop();
  };
  let timer = setTimeout(expire, timeoutMs);
  timer.unref();
  runtime.on("message", (message) => {
    if (message?.type !== "HOST_LEASE") return;
    clearTimeout(timer); timer = setTimeout(expire, timeoutMs); timer.unref();
  });
  runtime.once("disconnect", stop);
  if (!runtime.connected) stop();
  return true;
}
