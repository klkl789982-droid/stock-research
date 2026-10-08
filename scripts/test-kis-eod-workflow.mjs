import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import test from "node:test";

// Reuse the YAML parser already installed by the repository's ESLint toolchain.
const require = createRequire(import.meta.url);
const yaml = require("js-yaml");
const workflowText = fs.readFileSync(new URL("../.github/workflows/kis-provisional-eod.yml", import.meta.url), "utf8");
const workflow = yaml.load(workflowText);
const job = workflow.jobs.collect;
const steps = job.steps;
const approval = steps.find((step) => step.name === "Check private collection approval");
const runner = steps.find((step) => step.name === "Run isolated provisional pipeline");
const summary = steps.find((step) => step.name === "Publish safe operations summary");
const expression = (value) => value.replace(/\s+/gu, " ").trim();

function cronValues(field) {
  return field.split(",").flatMap((part) => {
    if (!part.includes("-")) return [Number(part)];
    const [first, last] = part.split("-").map(Number);
    return Array.from({ length: last - first + 1 }, (_, index) => first + index);
  });
}

test("workflow YAML declares only isolated schedules and an explicit dry-run default", () => {
  assert.deepEqual(Object.keys(workflow.on).sort(), ["schedule", "workflow_dispatch"]);
  const mode = workflow.on.workflow_dispatch.inputs.mode;
  assert.equal(mode.type, "choice");
  assert.equal(mode.required, true);
  assert.equal(mode.default, "dry-run");
  assert.deepEqual(mode.options, ["dry-run", "private-collect"]);
  assert.deepEqual(Object.keys(workflow.jobs), ["collect"]);
});

test("weekday UTC cron expands to 15:40–20:40 KST in exact 30-minute slots", () => {
  const minutes = workflow.on.schedule.flatMap(({ cron }) => {
    const [minute, hour, day, month, weekday] = cron.split(" ");
    assert.equal(day, "*");
    assert.equal(month, "*");
    assert.equal(weekday, "1-5");
    return cronValues(hour).flatMap((utcHour) => cronValues(minute).map((utcMinute) => utcHour * 60 + utcMinute + 9 * 60));
  }).sort((left, right) => left - right);
  assert.deepEqual(minutes, Array.from({ length: 11 }, (_, index) => 15 * 60 + 40 + index * 30));
  assert.equal(new Set(minutes).size, minutes.length, "no duplicate cron slot");
  assert.ok(minutes.every((minute) => minute < 24 * 60), "no UTC/KST weekday rollover");
});

test("scheduled collection is statically unarmed even if repository approval already exists", () => {
  assert.equal(expression(job.if), "github.ref == 'refs/heads/main' && (github.event_name == 'workflow_dispatch' || (false && vars.KIS_EOD_COLLECTION_ENABLED == 'true'))");
  assert.equal(job.env.KIS_EOD_COLLECTION_ENABLED, "${{ vars.KIS_EOD_COLLECTION_ENABLED }}");
  assert.equal(job.env.KIS_EOD_RUN_MODE, "${{ github.event_name == 'schedule' && 'private-collect' || inputs.mode }}");
  assert.doesNotMatch(workflowText, /KIS_EOD_COLLECTION_ENABLED:\s*(?:true|"true"|'true')/u);
});

test("manual private collection rechecks approval before installing or invoking code", () => {
  assert.equal(steps[0], approval);
  assert.match(approval.run, /case "\$KIS_EOD_RUN_MODE" in/u);
  assert.match(approval.run, /dry-run\)\s*;;/u);
  assert.match(approval.run, /private-collect\)/u);
  assert.match(approval.run, /\[ "\$KIS_EOD_COLLECTION_ENABLED" != "true" \]/u);
  assert.match(approval.run, /collectionApprovalRequired[\s\S]*exit 1/u);
  assert.match(approval.run, /\*\)[\s\S]*unsupportedMode[\s\S]*exit 1/u);
  assert.equal(approval.id, "approval");
  assert.match(approval.run, /reason=COLLECTION_NOT_ENABLED/u);
  assert.ok(steps.indexOf(approval) < steps.indexOf(runner));
});

test("secrets use existing KIS binding names without values or shell interpolation", () => {
  assert.equal(job.env.KIS_APP_KEY, "${{ secrets.KIS_APP_KEY }}");
  assert.equal(job.env.KIS_APP_SECRET, "${{ secrets.KIS_APP_SECRET }}");
  assert.deepEqual(Object.keys(job.env).sort(), ["KIS_APP_KEY", "KIS_APP_SECRET", "KIS_EOD_COLLECTION_ENABLED", "KIS_EOD_RUN_MODE"]);
  for (const step of steps.filter((step) => step.run)) {
    assert.doesNotMatch(step.run, /secrets\.|\$(?:KIS_APP_KEY|KIS_APP_SECRET)\b|^\s*(?:printenv|env|set -x)\b/mu);
  }
});

test("read-only GitHub permission and checkout cannot publish private prices", () => {
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.equal(job.permissions, undefined);
  const checkout = steps.find((step) => step.uses === "actions/checkout@v4");
  assert.equal(checkout.with.ref, "main");
  assert.equal(checkout.with["persist-credentials"], false);
});

test("concurrency namespace is isolated from Daily and LIVE jobs", () => {
  assert.deepEqual(workflow.concurrency, { group: "kis-provisional-eod-main", "cancel-in-progress": false });
  for (const file of ["daily-production.yml", "intraday-model-top-official-signal.yml"]) {
    const other = yaml.load(fs.readFileSync(new URL(`../.github/workflows/${file}`, import.meta.url), "utf8"));
    assert.notEqual(workflow.concurrency.group, other.concurrency.group);
  }
});

test("Node 22 and lockfile install reuse the current repository runtime", () => {
  const setup = steps.find((step) => step.uses === "actions/setup-node@v4");
  assert.equal(setup.with["node-version"], 22);
  assert.equal(setup.with.cache, "npm");
  assert.ok(steps.some((step) => step.run === "npm ci"));
  assert.equal(job["timeout-minutes"], 30);
});

test("calendar cache uses the current KST date and never falls back to another date", () => {
  const dateStep = steps.find((step) => step.id === "kst-date");
  assert.match(dateStep.run, /TZ=Asia\/Seoul date \+%Y-%m-%d/u);
  assert.match(dateStep.run, /\$GITHUB_OUTPUT/u);
  const restore = steps.find((step) => step.uses === "actions/cache/restore@v4");
  assert.equal(restore.id, "calendar-cache");
  assert.equal(restore.if, "env.KIS_EOD_RUN_MODE == 'private-collect'");
  assert.deepEqual(restore.with, {
    path: ".runtime/kis-eod/calendar",
    key: "kis-eod-calendar-main-${{ steps.kst-date.outputs.date }}",
  });
  assert.equal(restore.with["restore-keys"], undefined);
  assert.ok(steps.indexOf(restore) < steps.indexOf(runner));
});

test("calendar evidence is saved on partial collection failure without caching raw prices", () => {
  const cacheSteps = steps.filter((step) => step.uses?.startsWith("actions/cache/"));
  assert.equal(cacheSteps.length, 2);
  assert.ok(cacheSteps.every((step) => step.with.path === ".runtime/kis-eod/calendar"));
  const save = steps.find((step) => step.uses === "actions/cache/save@v4");
  assert.equal(expression(save.if), "always() && env.KIS_EOD_RUN_MODE == 'private-collect' && env.KIS_EOD_COLLECTION_ENABLED == 'true' && steps.calendar-cache.outputs.cache-hit != 'true' && steps.kst-date.outputs.date != '' && hashFiles('.runtime/kis-eod/calendar/**') != ''");
  assert.equal(save.with.key, "kis-eod-calendar-main-${{ steps.kst-date.outputs.date }}");
  assert.ok(steps.indexOf(save) > steps.indexOf(runner));
  assert.doesNotMatch(JSON.stringify(cacheSteps), /raw|candidates|latest\.json|\.env|secrets\./u);
});

test("runner receives only explicit dry-run or private collection arguments", () => {
  assert.equal(runner.shell, "bash");
  assert.match(runner.run, /if \[ "\$KIS_EOD_RUN_MODE" = "dry-run" \]/u);
  assert.deepEqual(runner.run.match(/node scripts\/run-kis-eod\.mjs --(?:dry-run|collect-private)\b/gu), [
    "node scripts/run-kis-eod.mjs --dry-run",
    "node scripts/run-kis-eod.mjs --collect-private",
  ]);
  assert.doesNotMatch(runner.run, /--(?:publish|force|date|reference-date|mark-promoted|wait-for-window)\b/u);
});

test("there is no stage/commit/push/upload path or public price allowlist", () => {
  assert.doesNotMatch(workflowText, /actions\/upload-artifact|git\s+(?:add|commit|push)|\b(?:curl|wget)\b/u);
  assert.doesNotMatch(workflowText, /data\/(?:history|model-history|intraday|kis-eod)|promotion_files|signal_path|latest_path/u);
  assert.doesNotMatch(workflowText, /tee\s|cat\s|JSON\.stringify/u);
  assert.doesNotMatch(runner.run, /echo\s+["']?\$result|console\.log\(result\)/u);
});

test("operation outputs preserve failures and expose only runner-whitelisted enums", () => {
  assert.equal(runner.id, "kis-eod");
  assert.match(runner.run, /KIS_EOD_RUNNER_STATUSES, KIS_EOD_RUNNER_REASONS/u);
  assert.match(runner.run, /KIS_EOD_RUNNER_STATUSES\.includes\(result\?\.status\)/u);
  assert.match(runner.run, /KIS_EOD_RUNNER_REASONS\.includes\(result\?\.reason\)/u);
  assert.match(runner.run, /exit_code=\$\?/u);
  assert.match(runner.run, /exit "\$exit_code"/u);
  assert.match(summary.env.KIS_EOD_SAFE_STATUS, /steps\.kis-eod\.outputs\.status/u);
  assert.match(summary.env.KIS_EOD_SAFE_REASON, /steps\.approval\.outputs\.reason/u);
  assert.match(summary.run, /pipeline status: \$KIS_EOD_SAFE_STATUS/u);
  assert.match(summary.run, /reason: \$KIS_EOD_SAFE_REASON/u);
});

test("real summary parser redacts extra fields and fails closed on missing/invalid result", () => {
  const parser = runner.run.match(/<<'NODE'\n([\s\S]+?)\nNODE/u)?.[1];
  assert.ok(parser);
  const repository = new URL("../", import.meta.url);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "kis-eod-workflow-test-"));
  const sentinel = "secret-value-must-not-appear";
  try {
    const cases = [
      { input: `KIS_EOD_RESULT_JSON=${JSON.stringify({ status: "VALIDATED", reason: "PRIVATE_CANDIDATE_READY", unauthorizedExtra: sentinel })}`, status: "VALIDATED", reason: "PRIVATE_CANDIDATE_READY", exit: 0 },
      { input: `KIS_EOD_RESULT_JSON=${JSON.stringify({ status: sentinel, reason: sentinel })}`, status: "FAILED", reason: "UNEXPECTED_FAILURE", exit: 1 },
      { input: `not-a-result ${sentinel}`, status: "FAILED", reason: "UNEXPECTED_FAILURE", exit: 1 },
      { input: 'KIS_EOD_RESULT_JSON={"status":"FAILED","reason":"CALENDAR_REQUEST_FAILED"}', status: "FAILED", reason: "CALENDAR_REQUEST_FAILED", exit: 1 },
    ];
    for (const [index, fixture] of cases.entries()) {
      const target = path.join(directory, `${index}.txt`);
      const observed = spawnSync(process.execPath, ["--input-type=module", "-e", parser], { cwd: repository, encoding: "utf8", env: { ...process.env, GITHUB_OUTPUT: target, KIS_EOD_CAPTURED_OUTPUT: fixture.input } });
      assert.equal(observed.status, fixture.exit, observed.stderr);
      const output = fs.readFileSync(target, "utf8");
      assert.equal(output, `status=${fixture.status}\nreason=${fixture.reason}\n`);
      assert.ok(!`${observed.stdout}${observed.stderr}${output}`.includes(sentinel));
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("safe summary states private ephemeral storage and blocked publication truthfully", () => {
  assert.equal(summary.if, "always()");
  assert.match(summary.run, /private runner-local \.runtime only/u);
  assert.match(summary.run, /no price artifacts uploaded or committed/u);
  assert.match(summary.run, /publication: BLOCKED pending source-finality and redistribution approval/u);
  assert.match(summary.run, /best-effort trigger/u);
  assert.match(summary.run, /schedule: UNARMED/u);
  assert.match(summary.run, /\$GITHUB_STEP_SUMMARY/u);
  assert.doesNotMatch(summary.run, /source-finality: (?:VERIFIED|SUCCESS)|published: true/u);
});
