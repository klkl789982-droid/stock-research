import test from "node:test";
import assert from "node:assert/strict";
import { privateRequestBudget } from "./relay-budget.mjs";

test("external requests including failures stop at40 without a paid fallback", async () => {
  let requests = 0;
  const io = privateRequestBudget(async () => { requests++; return new Response(null, { status: 503 }); });
  for (let i = 0; i < 40; i++) assert.equal((await io.fetch("https://api.github.com")).status, 503);
  await assert.rejects(io.fetch("https://api.github.com"), /HTTP_BUDGET/u);
  assert.equal(io.calls, 40); assert.equal(requests, 40); assert.equal(io.exhausted, true);
});

test("separate relay invocations do not reset or share another invocation counter", async () => {
  const first = privateRequestBudget(async () => new Response(null), 1);
  const second = privateRequestBudget(async () => new Response(null), 1);
  await first.fetch("https://api.github.com"); await second.fetch("https://api.github.com");
  await assert.rejects(first.fetch("https://api.github.com"), /HTTP_BUDGET/u);
  assert.equal(second.exhausted, false);
  assert.throws(() => privateRequestBudget(fetch, 41), /BUDGET_INVALID/u);
});
