// Workers clocks advance at I/O boundaries. A different isolate's response
// stamp can be a few milliseconds ahead of this receiver's last I/O clock.
// Wait OUTSIDE SQL/locks, then run the SAME zero-future-tolerance validator.
// Never rewrite a call timestamp or enlarge its slot/observation window.
async function refreshClock(state, latest) {
  const receivedClock = state.now();
  let remaining = 25, waits = 0;
  // This bounds waiting, NOT accepted clock skew: complete() still rejects any
  // timestamp ahead of its actual refreshed receiver clock. Large future data
  // or a non-advancing clock goes straight to the existing fail-closed path.
  if (latest > receivedClock && latest - receivedClock <= remaining) {
    while (latest > state.now() && remaining > 0 && waits < 3) {
      const delay = Math.min(remaining, Math.max(1, latest - state.now()));
      // A failed timer must not bypass complete() and strand a durable lease.
      // Fall through to its strict validator and terminal-release handling.
      try { await state.wait(delay); } catch { break; }
      remaining -= delay; waits++;
    }
  }
}

export async function completeWithReceiptClock(state, date, code, value) {
  const calls = value?.calls;
  const latest = Array.isArray(calls) && calls.length <= 16 && calls.every(c => Number.isSafeInteger(c?.completed))
    ? Math.max(...calls.map(c => c.completed)) : -Infinity;
  await refreshClock(state, latest);
  return state.complete(date, code, value);
}

export async function extraWithReceiptClock(state, date, code, kind, skipped = []) {
  // A caller declaring a slot missed at+21ms can also arrive while the
  // receiver's last-I/O clock still reads+19ms. Refresh, then require the SAME
  // strict expiration/identity checks. Never cancel a not-yet-expired slot.
  const latest = Array.isArray(skipped) && skipped.length <= 3 && skipped.every(Number.isSafeInteger)
    ? Math.max(...skipped.map(slot => slot * 220 + 21)) : -Infinity;
  await refreshClock(state, latest);
  return state.extra(date, code, kind, skipped);
}
