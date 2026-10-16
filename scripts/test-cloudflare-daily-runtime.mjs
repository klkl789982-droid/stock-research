// Execute the actual Worker graph with Web APIs, no process/Buffer/Node imports.
// This is a local portability regression, not a deployed Cloudflare assertion.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

if (!process.argv.includes("--edge-fixture")) {
  const result = spawnSync(process.execPath, ["--experimental-vm-modules", fileURLToPath(import.meta.url), "--edge-fixture"],
    { cwd: process.cwd(), env: { PATH: process.env.PATH }, encoding: "utf8", timeout: 30_000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  process.stdout.write(result.stdout);
} else {
  const root = process.cwd();
  const context = vm.createContext({ URL, Request, Response, Headers, AbortController, AbortSignal,
    setTimeout, clearTimeout, console: { log: () => {} }, fetch: () => { throw new Error("UNEXPECTED_REAL_NETWORK"); } });
  const modules = new Map();
  function load(file) {
    assert.ok(file.startsWith(`${root}${path.sep}`));
    if (!modules.has(file)) modules.set(file, new vm.SourceTextModule(fs.readFileSync(file, "utf8"), { context, identifier: file }));
    return modules.get(file);
  }
  const main = load(path.join(root, "infra/cloudflare-daily-production/src/index.mjs"));
  await main.link((specifier, parent) => {
    assert.ok(specifier.startsWith("."), `Non-Web runtime dependency: ${specifier}`);
    return load(path.resolve(path.dirname(parent.identifier), specifier));
  });
  await main.evaluate();
  assert.equal(vm.runInContext("typeof process", context), "undefined");
  assert.equal(vm.runInContext("typeof Buffer", context), "undefined");
  const { createWorker, CRONS, TARGET, PUBLICATION_SITE } = main.namespace;
  const now = Date.parse("2026-10-08T06:40:00Z"), sourceSha = "a".repeat(40), deployedSha = "b".repeat(40), snapshotHash = "c".repeat(64);
  const run = { id: 1, run_attempt: 1, head_sha: sourceSha, repository: { full_name: TARGET.repository }, head_repository: { full_name: TARGET.repository },
    path: `.github/workflows/${TARGET.workflow}`, head_branch: "main", event: "schedule", actor: { login: "github-actions[bot]" },
    status: "completed", conclusion: "success", run_started_at: "2026-10-08T06:00:00Z" };
  const jobs = { jobs: [{ name: "publish", run_id: 1, head_sha: sourceSha, run_attempt: 1, steps: [
    { name: "Verify Vercel deployment and production APIs", status: "completed", conclusion: "success", completed_at: "2026-10-08T06:20:00Z" },
    { name: `Publication evidence v1 | VERIFIED | 2026-10-08 | ${snapshotHash} | ${deployedSha} | NONE`, status: "completed", conclusion: "success", completed_at: "2026-10-08T06:21:00Z" },
  ] }] };
  const githubToken = "synthetic-actions-only", siteToken = "s".repeat(48);
  async function exercise(withSiteAuth) {
    const calls = [], logs = [];
    const worker = createWorker({ now: () => now, logger: entry => logs.push(entry), fetchImpl: async (url, init) => {
      calls.push({ url, init });
      assert.equal(init.redirect, "manual", "Workers requests must reject redirects without unsupported redirect:error");
      if (url.startsWith(`${PUBLICATION_SITE}/`)) {
        assert.equal(init.headers.Authorization, `Bearer ${siteToken}`);
        const dates = url.includes("top-stocks") ? { rankingAsOfDate: "2026-10-08" }
          : url.includes("model-performance") ? { latestEodReferenceDate: "2026-10-08" }
            : url.includes("home-dashboard") ? { referenceDate: "2026-10-08" } : { siteApiReferenceDate: "2026-10-08" };
        return Response.json({ ...dates, publicationReady: true, dataIdentity: { referenceDate: "2026-10-08", snapshotHash, commitSha: deployedSha } });
      }
      assert.ok(url.startsWith("https://api.github.com/repos/klkl789982-droid/stock-research/"));
      assert.equal(init.headers.Authorization, `Bearer ${githubToken}`);
      if (url.includes("/jobs?")) return Response.json(jobs);
      if (url.includes("/runs?")) return Response.json({ workflow_runs: [run] });
      if (init.method === "POST") return new Response(null, { status: 204 });
      return Response.json({ state: "active", path: `.github/workflows/${TARGET.workflow}` });
    } });
    const result = await worker.scheduled({ cron: CRONS[0], scheduledTime: now }, { DISPATCH_ENABLED: "true", GITHUB_TOKEN: githubToken,
      ...(withSiteAuth ? { TB_AUTOMATION_READ_TOKEN: siteToken } : {}) });
    assert.equal(result.reason, withSiteAuth ? "SESSION_ALREADY_PUBLISHED" : "REQUEST_ACCEPTED_NOT_WORKFLOW_SUCCESS");
    assert.equal(calls.filter(call => call.url.startsWith(PUBLICATION_SITE)).length, withSiteAuth ? 4 : 0);
    assert.equal(calls.filter(call => call.init.method === "POST").length, withSiteAuth ? 0 : 1);
    assert.ok(!JSON.stringify(logs).includes(githubToken) && !JSON.stringify(logs).includes(siteToken));
  }
  await exercise(false);
  await exercise(true);
  console.log(`Cloudflare Daily Web-runtime graph: ${modules.size} crypto-free modules, no Node globals, safe no-auth dispatch and exact authenticated four-API proof passed`);
}
