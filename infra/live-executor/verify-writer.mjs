import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { writerEnvironment } from "./writer-environment.mjs";
import { privateSiteWriter } from "./site-delivery-agent.mjs";
import { canonicalContentHash } from "../../lib/canonical-content-hash.mjs";
export async function verifyWriter(store) {
  await store.verifyPrivateRepository();
  const key = `tests/site-delivery-writer/${randomUUID()}/fixture.json`;
  const fixture = { schemaVersion: 1, type: "SYNTHETIC_CONNECTION_TEST", text: "no market data or credentials", id: randomUUID() };
  const first = await store.writeImmutable(key, fixture), read = await store.read(key);
  if (!read || read.contentHash !== first.contentHash || canonicalContentHash(read.value) !== canonicalContentHash(fixture)) throw new Error("WRITER_READBACK_MISMATCH");
  await store.writeImmutable(key, fixture);
  let conflict = false;
  try { await store.writeImmutable(key, { ...fixture, text: "synthetic conflict" }); } catch (error) { conflict = error.code === "PRIVATE_STORE_IMMUTABLE_CONFLICT"; }
  const again = await store.read(key);
  if (!conflict || again?.contentHash !== first.contentHash) throw new Error("WRITER_CONFLICT_NOT_PRESERVED");
  return { status: "VERIFIED", path: key, contentHash: first.contentHash, sha256: canonicalContentHash(fixture), createReadDuplicateConflict: true, operationalPointerChanged: false };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const env = await writerEnvironment(); const store = privateSiteWriter(env);
    if (!store) throw new Error("SITE_RELAY_WRITER_NOT_CONFIGURED");
    console.log(JSON.stringify(await verifyWriter(store)));
  } catch (error) { console.error(JSON.stringify({ status: "BLOCKED", reason: /^[A-Z][A-Z0-9_]+$/u.test(error.message) ? error.message : "WRITER_VERIFICATION_FAILED" })); process.exitCode = 1; }
}
