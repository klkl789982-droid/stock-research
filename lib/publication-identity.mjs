import { createHash } from "node:crypto";

import { isReferenceDate, isCommitSha } from "./publication-identity-format.mjs";
export { isReferenceDate, isSnapshotHash, isCommitSha, safeDataIdentity, sameSnapshot } from "./publication-identity-format.mjs";
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;

// Recompute from the exact object consumed by each route. Never trust its
// declared contentHash, a filename/date match, or a separately read manifest.
export function snapshotIdentity(snapshot) {
  if (!isReferenceDate(snapshot?.asOfDate) || !Array.isArray(snapshot?.records) || !snapshot.records.length) return null;
  return { referenceDate: snapshot.asOfDate, snapshotHash: createHash("sha256").update(JSON.stringify(canonical(snapshot))).digest("hex") };
}
export function dataIdentity(snapshot, commitSha = process.env.VERCEL_GIT_COMMIT_SHA) {
  const identity = snapshotIdentity(snapshot);
  return identity ? { ...identity, commitSha: isCommitSha(commitSha) ? commitSha : null } : null;
}
