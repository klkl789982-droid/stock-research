import { createHash } from "node:crypto";

export const isReferenceDate = (value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
export const isSnapshotHash = (value) => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
export const isCommitSha = (value) => typeof value === "string" && /^[a-f0-9]{40}$/u.test(value);
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
export function safeDataIdentity(identity) {
  return isReferenceDate(identity?.referenceDate) && isSnapshotHash(identity?.snapshotHash)
    ? { referenceDate: identity.referenceDate, snapshotHash: identity.snapshotHash, commitSha: isCommitSha(identity.commitSha) ? identity.commitSha : null } : null;
}
export function sameSnapshot(left, right) {
  return Boolean(left && right && isReferenceDate(left.referenceDate) && isSnapshotHash(left.snapshotHash) && left.referenceDate === right.referenceDate && left.snapshotHash === right.snapshotHash);
}
