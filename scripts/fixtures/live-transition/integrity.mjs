import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { immutableSnapshotView } from "../../../lib/future-return-resolver.mjs";
import { sha256Canonical } from "../../../lib/snapshot-quality-pipeline.mjs";

// Historical files gain future outcomes after publication. Match the existing
// resolver's immutable boundary, retaining every original input/provenance field.
export const historyFixtureHash = (history) => sha256Canonical(immutableSnapshotView(history));

export function assertLiveFixtureArchive(key, bytes, archive) {
  const expectedScope = key === "history" ? "canonicalImmutableSnapshotView-v1" : "fileBytes-v1";
  assert.equal(archive.hashScope ?? "fileBytes-v1", expectedScope, `${archive.path}: unexpected fixture hash scope`);
  const actual = key === "history"
    ? historyFixtureHash(JSON.parse(bytes))
    // The fixture pins Git's LF blob bytes; Windows core.autocrlf must not
    // require rewriting a preserved historical observation.
    : createHash("sha256").update(String(bytes).replaceAll("\r\n", "\n")).digest("hex");
  assert.equal(actual, archive.sha256, `${archive.path} immutable inputs changed; review the pinned scenario before updating it`);
}
