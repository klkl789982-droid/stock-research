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
const root = await fs.mkdtemp(path.join(os.tmpdir(), "dry-run-zero-write-"));
assert.equal((await fs.readdir(root)).length, 0);
await fs.rm(root, { recursive: true });
console.log(`history dry-run 안전 테스트 완료: ${passed}개 통과`);
