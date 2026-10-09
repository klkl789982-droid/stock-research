import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { kisEodPrivateStoreFromEnv } from "../lib/kis-eod-private-store.mjs";

export const APPROVED_PRIVATE_REPOSITORY = "klkl789982-droid/tight-budget-private-data";
const failure = (code) => Object.assign(new Error(code), { code });
const safeErrors = new Set(["PRIVATE_STORE_NOT_CONFIGURED", "PRIVATE_STORE_REPOSITORY_NOT_PRIVATE", "PRIVATE_STORE_AUTHORIZATION_FAILED",
  "PRIVATE_STORE_NETWORK_FAILED", "PRIVATE_STORE_RETRY_EXHAUSTED", "PRIVATE_STORE_REQUEST_FAILED", "PRIVATE_STORE_RESPONSE_INVALID",
  "PRIVATE_STORE_CREATE_FAILED", "PRIVATE_STORE_READBACK_FAILED", "PRIVATE_STORE_IMMUTABLE_CONFLICT", "FIXTURE_CONFIGURATION_INVALID",
  "FIXTURE_HASH_MISMATCH", "FIXTURE_DUPLICATE_FAILED", "FIXTURE_CONFLICT_FAILED"]);

// This entry point has no KIS imports, price fields, journal access or collection
// switches. Its only write is one price-free object in a dedicated tests path.
export async function verifyKisEodPrivateStorage({ env = process.env, fetchImpl = fetch } = {}) {
  const runId = env.GITHUB_RUN_ID, attempt = env.GITHUB_RUN_ATTEMPT;
  if (env.KIS_OBSERVATION_STORE_REPOSITORY !== APPROVED_PRIVATE_REPOSITORY
    || (env.KIS_OBSERVATION_STORE_BRANCH ?? "main") !== "main"
    || !/^[0-9]{1,24}$/u.test(runId ?? "") || !/^[0-9]{1,6}$/u.test(attempt ?? "")) throw failure("FIXTURE_CONFIGURATION_INVALID");
  let createRequests = 0;
  const store = kisEodPrivateStoreFromEnv(env, { fetchImpl: (url, init) => {
    if (init.method === "PUT") createRequests += 1;
    return fetchImpl(url, init);
  } });
  // A fresh object is essential even if this entry point is invoked twice in
  // one Actions attempt: reading an older probe cannot prove current write rights.
  const probeId = randomUUID(), key = `tests/store-connection/${runId}-${attempt}/${probeId}.json`;
  const fixture = { schemaVersion: 1, namespace: "kis-eod-private-storage-test", fixtureOnly: true, runId, attempt, probeId,
    payload: "NO_MARKET_DATA_NO_CREDENTIALS", sourcePricesIncluded: false, publicationEligible: false };
  const expectedHash = createHash("sha256").update(`${JSON.stringify(fixture, null, 2)}\n`).digest("hex");
  await store.verifyPrivateRepository();
  const written = await store.writeImmutable(key, fixture), reread = await store.read(key);
  if (written.contentHash !== expectedHash || reread?.contentHash !== expectedHash
    || JSON.stringify(reread.value) !== JSON.stringify(fixture)) throw failure("FIXTURE_HASH_MISMATCH");
  const beforeDuplicate = createRequests;
  const duplicate = await store.writeImmutable(key, fixture);
  if (duplicate.status !== "ALREADY_STORED" || duplicate.contentHash !== expectedHash || createRequests !== beforeDuplicate)
    throw failure("FIXTURE_DUPLICATE_FAILED");
  let conflictRejected = false;
  try { await store.writeImmutable(key, { ...fixture, payload: "CHANGED_TEST_PAYLOAD" }); }
  catch (error) {
    if (error.code !== "PRIVATE_STORE_IMMUTABLE_CONFLICT") throw error;
    conflictRejected = true;
  }
  if (!conflictRejected || createRequests !== beforeDuplicate || (await store.read(key))?.contentHash !== expectedHash)
    throw failure("FIXTURE_CONFLICT_FAILED");
  return { status: "VERIFIED", repository: APPROVED_PRIVATE_REPOSITORY, testPath: key, sha256: expectedHash,
    createOnly: written.status, readAndHash: "VERIFIED", duplicate: "DEDUPLICATED_WITHOUT_PUT",
    conflict: "REJECTED_ORIGINAL_PRESERVED", authentication: "ACTUAL_ACTIONS_SECRET_ACCEPTED",
    contentsReadWrite: "ACTUAL_VERIFIED", sourcePricesIncluded: false, observationActivation: "UNCHANGED_UNARMED" };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let result;
  try {
    if (process.argv.length !== 2) throw failure("FIXTURE_CONFIGURATION_INVALID");
    result = await verifyKisEodPrivateStorage();
  } catch (error) {
    result = { status: "FAILED", reason: safeErrors.has(error?.code) ? error.code : "PRIVATE_STORAGE_VERIFICATION_FAILED",
      sourcePricesIncluded: false, observationActivation: "UNCHANGED_UNARMED" };
    process.exitCode = 1;
  }
  console.log(`KIS_PRIVATE_STORAGE_VERIFICATION_JSON=${JSON.stringify(result)}`);
  if (process.env.GITHUB_STEP_SUMMARY) await fs.appendFile(process.env.GITHUB_STEP_SUMMARY,
    `Private storage fixture: ${result.status}\n\n${result.status === "VERIFIED"
      ? `Create/read/SHA256, duplicate and conflict: VERIFIED\n\nSHA256: ${result.sha256}`
      : `Reason: ${result.reason}`}\n\nNo KIS requests or source prices. Collection remains UNARMED.\n`);
}
