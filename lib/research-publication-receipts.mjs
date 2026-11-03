import { createKisEodPrivateStore } from "./kis-eod-private-store.mjs";
import { isCommitSha, isReferenceDate, isSnapshotHash } from "./publication-identity.mjs";
import { PUBLICATION_REPOSITORY } from "./daily-publication-status.mjs";

const prefix = "research-site-receipts-v1";
const fileKey = (date, hash) => `${prefix}/${date.slice(0, 4)}/${date}-${hash}.json`;
const valid = (r, date, hash, now) => r?.schema === prefix && r.status === "VERIFIED" && r.referenceDate === date && r.snapshotHash === hash &&
  isReferenceDate(date) && isSnapshotHash(hash) && isCommitSha(r.commitSha) && Number.isSafeInteger(r.runId) && r.runId > 0 &&
  Number.isInteger(r.runAttempt) && r.runAttempt > 0 && Date.parse(r.verifiedAt) >= Date.parse(date + "T15:30:00+09:00") && Date.parse(r.verifiedAt) <= now;

/** The verifier must have seen all four authenticated site identities. Preserve the first confirmed-by time. */
export async function archiveResearchPublication(receipt, store, { runId, runAttempt, now = Date.now() }) {
  const date = receipt.expectedReferenceDate, hash = receipt.expectedSnapshotHash;
  const value = { schema: prefix, status: receipt.status, referenceDate: date, snapshotHash: hash, commitSha: receipt.expectedCommitSha, verifiedAt: receipt.verifiedAt, runId, runAttempt };
  if (!valid(value, date, hash, now) || receipt.reason != null ||
    ["top", "performance", "home", "operations"].some((key) => {
      const id = receipt.actual?.identities?.[key];
      return receipt.actual?.ready?.[key] !== true || receipt.actual?.[key + "ReferenceDate"] !== date || id?.referenceDate !== date || id.snapshotHash !== hash || id.commitSha !== value.commitSha;
    })) throw new Error("RESEARCH_SITE_RECEIPT_UNVERIFIED");
  const key = fileKey(date, hash), previous = (await store.read(key))?.value;
  if (previous) {
    if (!valid(previous, date, hash, now)) throw new Error("RESEARCH_SITE_RECEIPT_CONFLICT");
    return "ALREADY_CONFIRMED";
  }
  return (await store.writeImmutable(key, value)).status;
}

export async function readResearchPublicationReceipts(references, { env = process.env, store, now = Date.now() } = {}) {
  const evidence = [];
  try {
    const reader = store ?? createKisEodPrivateStore({ repository: env.PRIVATE_LIVE_DELIVERY_REPOSITORY, token: env.PRIVATE_LIVE_DELIVERY_READ_TOKEN });
    const validRefs = references.filter((r) => isReferenceDate(r.date) && isSnapshotHash(r.hash));
    for (const year of new Set(validRefs.map((r) => r.date.slice(0, 4)))) {
      const folder = prefix + "/" + year, keys = new Set((await reader.listKeys(folder)).filter((x) => x.type === "file").map((x) => folder + "/" + x.name));
      for (const { date, hash } of validRefs.filter((r) => r.date.startsWith(year))) {
        const key = fileKey(date, hash);
        if (!keys.has(key)) continue;
        const value = (await reader.read(key))?.value;
        if (valid(value, date, hash, now)) evidence.push({ ...value, reason: null, runUrl: `https://github.com/${PUBLICATION_REPOSITORY}/actions/runs/${value.runId}/attempts/${value.runAttempt}` });
      }
    }
  } catch { /* Missing credentials or a partial read cannot certify more dates. */ }
  return evidence;
}
