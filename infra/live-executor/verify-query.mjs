export async function verifyPrivateQuery({ api, token, mode, store }) {
  const unauthorized = await fetch(`${api.url}/top`, { signal: AbortSignal.timeout(5000) });
  if (unauthorized.status !== 401) throw new Error("EXECUTOR_API_AUTH_REGRESSION");
  const counts = {}, hashes = new Set();
  let observationType;
  for (const model of ["A", "B", "C", "D"]) {
    const response = await fetch(`${api.url}/top?model=${model}&limit=5`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error("EXECUTOR_API_READBACK_FAILED");
    const body = await response.json();
    if (body.mode !== mode || body.observationType !== (mode === "live" ? "LIVE_OBSERVATION" : "CURRENT_TIME_SHADOW") || !body.records?.length) throw new Error("EXECUTOR_API_PROJECTION_INVALID");
    if (body.records.some((row) => Object.keys(row).some((key) => !["ticker", "companyName", "score", "rank"].includes(key)))) throw new Error("EXECUTOR_API_RAW_FIELD_REJECTED");
    counts[model] = body.records.length; observationType = body.observationType; hashes.add(body.contentHash);
  }
  if (hashes.size !== 1) throw new Error("EXECUTOR_API_SNAPSHOT_MISMATCH");
  const contentHash = [...hashes][0];
  const result = { verifiedAt: new Date().toISOString(), mode, observationType, contentHash, topCounts: counts, unauthorizedStatus: unauthorized.status, sourcePricesReturned: false };
  await store.writeMutable(`${mode}/query-verification.json`, result);
  return result;
}
