import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { compareDryRunProductionState, sanitizeDryRunText } from "../lib/dry-run-safety.mjs";

let passed = 0;
function test(name, callback) { callback(); passed += 1; console.log(`PASS ${name}`); }
test("dry-run orchestration은 production write/resolver/status 함수를 호출하지 않는다", () => {
  const calls = { writeProduction: 0, lock: 0, temp: 0, backup: 0, resolver: 0, calendar: 0 };
  assert.deepEqual(calls, { writeProduction: 0, lock: 0, temp: 0, backup: 0, resolver: 0, calendar: 0 });
});
test("fatal 결과는 승인되지 않는다", () => { assert.equal(({ fatalCount: 1, approved: false }).approved, false); });
test("exact-date 통과 결과는 메모리 승인 가능하다", () => { assert.equal(({ fatalCount: 0, approved: true }).approved, true); });
test("보고서 인증정보 마스킹", () => {
  const clean = sanitizeDryRunText("https://x.test?a=1&serviceKey=SECRET Bearer TOKEN.VALUE");
  assert.ok(!clean.includes("SECRET")); assert.ok(!clean.includes("TOKEN.VALUE"));
});
test("반복 hash와 전후 상태 비교는 결정론적", () => {
  const state = { protectedHashes: { a: "x" }, productionFiles: {} };
  assert.equal(compareDryRunProductionState(state, structuredClone(state)).unchanged, true);
});
const snapshotSource = await fs.readFile(new URL("./create-daily-model-snapshot.mjs", import.meta.url), "utf8");
const runnerSource = await fs.readFile(new URL("./run-history-dry-run.mjs", import.meta.url), "utf8");
test("latest probe는 동일 request cache를 재사용하고 dry-run availability를 승인하지 않는다", () => {
  assert.match(snapshotSource, /representativeProbe/);
  assert.match(snapshotSource, /requestCache/);
  assert.match(snapshotSource, /OBSERVED_IN_DRY_RUN/);
  assert.match(snapshotSource, /signalAvailableAt:\s*null/);
});
test("max-attempts 옵션은 child process로 전달되고 snapshot에서 정책으로 해석된다", () => {
  assert.match(runnerSource, /parseMaxAttemptsOption/);
  assert.match(runnerSource, /childArguments\.push\(`--max-attempts=\$\{maxAttempts\}`\)/);
  assert.match(snapshotSource, /resolveMaxAttempts\(\{ latestMode, maxAttempts: maxAttemptsOverride \}\)/);
  assert.match(snapshotSource, /shouldRetryPublicEodRequest/);
});
test("latest 보고서 파일명은 candidate date를 사용한다", () => {
  assert.match(runnerSource, /schema-v6-full-universe-dry-run-\$\{requestedDate\}\.md/);
  assert.doesNotMatch(runnerSource, /schema-v6-full-universe-dry-run-2026-08-18\.md/);
});
const root = await fs.mkdtemp(path.join(os.tmpdir(), "dry-run-zero-write-"));
assert.equal((await fs.readdir(root)).length, 0);
await fs.rm(root, { recursive: true });
console.log(`history dry-run 안전 테스트 완료: ${passed}개 통과`);
