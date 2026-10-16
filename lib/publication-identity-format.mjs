// Crypto-free publication identity contract shared by Node and edge runtimes.
// These checks compare already-computed identities; they never create a hash.
export const isReferenceDate = (value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
export const isSnapshotHash = (value) => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
export const isCommitSha = (value) => typeof value === "string" && /^[a-f0-9]{40}$/u.test(value);
export function safeDataIdentity(identity) {
  return isReferenceDate(identity?.referenceDate) && isSnapshotHash(identity?.snapshotHash)
    ? { referenceDate: identity.referenceDate, snapshotHash: identity.snapshotHash, commitSha: isCommitSha(identity.commitSha) ? identity.commitSha : null } : null;
}
export function sameSnapshot(left, right) {
  return Boolean(left && right && isReferenceDate(left.referenceDate) && isSnapshotHash(left.snapshotHash) && left.referenceDate === right.referenceDate && left.snapshotHash === right.snapshotHash);
}
