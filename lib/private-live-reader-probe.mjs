// Explicit, one-shot permission check. No operational path or update/delete API.
import { randomUUID } from "node:crypto";
import { createKisEodPrivateStore } from "./kis-eod-private-store.mjs";
import { deliveryFixtureBytes, deliveryFixtureHash, deliveryFixtureKey } from "./private-live-delivery-fixture.mjs";

export async function verifySiteRelayReader({ env = process.env, fetchImpl = fetch } = {}) {
  const repository = env.PRIVATE_LIVE_DELIVERY_REPOSITORY;
  if (repository !== "klkl789982-droid/tight-budget-private-data") throw new Error("READER_REPOSITORY_NOT_ALLOWED");
  const id = env.PRIVATE_LIVE_DELIVERY_FIXTURE_ID, key = deliveryFixtureKey(id);
  const token = env.PRIVATE_LIVE_DELIVERY_READ_TOKEN;
  const store = createKisEodPrivateStore({ repository, token, fetchImpl });
  const stored = await store.read(key);
  if (!stored || stored.bytes !== deliveryFixtureBytes(id) || stored.contentHash !== deliveryFixtureHash(id)) throw new Error("READER_FIXTURE_MISMATCH");
  // A GET success cannot establish a token's write restriction. Attempt ONLY a
  // fresh, non-sensitive test marker; no SHA means it cannot replace any file.
  const path = `evidence/kis-eod-private-slot-observation/tests/site-delivery/${id}/read-only-probe-${randomUUID()}.json`;
  const response = await fetchImpl(`https://api.github.com/repos/${repository}/contents/${path}`, {
    method: "PUT", redirect: "error", signal: AbortSignal.timeout(15000), cache: "no-store",
    headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "tight-budget-relay-reader-check", "Content-Type": "application/json" },
    body: JSON.stringify({ branch: "main", message: "test: detect overprivileged relay reader (synthetic only)",
      content: Buffer.from('{"observationType":"SYNTHETIC_PERMISSION_PROBE","operational":false}\n').toString("base64") }),
  });
  await response.body?.cancel();
  const denied = response.status === 403 && response.headers.get("x-ratelimit-remaining") !== "0";
  return { readVerified: true, sha256: stored.contentHash, writeDenied: denied,
    permissionStatus: denied ? "READ_OK_WRITE_DENIED" : response.status === 201 ? "READER_OVERPRIVILEGED" : "WRITE_RESTRICTION_UNVERIFIED",
    httpStatus: response.status, operationalDataTouched: false, ...(response.status === 201 ? { preservedTestMarker: path } : {}) };
}
