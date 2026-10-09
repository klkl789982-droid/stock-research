import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { verifyKisEodPrivateStorage, APPROVED_PRIVATE_REPOSITORY } from "./verify-kis-eod-private-storage.mjs";

const yaml = createRequire(import.meta.url)("js-yaml");
const env = { KIS_OBSERVATION_STORE_REPOSITORY: APPROVED_PRIVATE_REPOSITORY, KIS_OBSERVATION_STORE_BRANCH: "main",
  KIS_OBSERVATION_STORE_TOKEN: "FIXTURE_ONLY_CREDENTIAL", GITHUB_RUN_ID: "123456", GITHUB_RUN_ATTEMPT: "1" };
function backend(options = {}) {
  const { status = null, corrupt = false } = options;
  const files = new Map(), requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, method: init.method, body: init.body });
    assert.equal(init.headers.Authorization, "Bearer FIXTURE_ONLY_CREDENTIAL");
    assert.equal(new URL(url).origin, "https://api.github.com");
    if (status) return new Response("PRIVATE_RESPONSE_NEVER_PRINTED", { status });
    const key = new URL(url).pathname.split("/contents/")[1];
    if (!key) return Response.json({ private: true, full_name: APPROVED_PRIVATE_REPOSITORY });
    assert.match(key, /^evidence\/kis-eod-private-slot-observation\/tests\/store-connection\/[0-9]+-[0-9]+\/[a-f0-9-]{36}[.]json$/u);
    if (init.method === "GET") {
      if (!files.has(key)) return new Response(null, { status: 404 });
      const bytes = `${files.get(key)}${corrupt ? " " : ""}`;
      return Response.json({ type: "file", encoding: "base64", size: Buffer.byteLength(bytes), content: Buffer.from(bytes).toString("base64") });
    }
    assert.equal(init.method, "PUT");
    if (options.readOnly) return new Response(null, { status: 403 });
    const payload = JSON.parse(init.body);
    assert.equal(payload.sha, undefined); assert.equal(payload.branch, "main");
    if (files.has(key)) return new Response(null, { status: 422 });
    files.set(key, Buffer.from(payload.content, "base64").toString("utf8"));
    return Response.json({}, { status: 201 });
  };
  return { fetchImpl, files, requests };
}

test("connection verification writes only a price-free test fixture and independently verifies its byte hash", async () => {
  const b = backend(), result = await verifyKisEodPrivateStorage({ env, fetchImpl: b.fetchImpl });
  assert.equal(result.status, "VERIFIED"); assert.equal(result.createOnly, "STORED_AND_VERIFIED");
  assert.match(result.sha256, /^[a-f0-9]{64}$/u); assert.equal(result.sourcePricesIncluded, false);
  assert.equal(result.duplicate, "DEDUPLICATED_WITHOUT_PUT"); assert.equal(result.conflict, "REJECTED_ORIGINAL_PRESERVED");
  assert.equal(b.files.size, 1); assert.equal(b.requests.filter((r) => r.method === "PUT").length, 1);
  const value = JSON.parse([...b.files.values()][0]);
  assert.deepEqual(Object.keys(value), ["schemaVersion", "namespace", "fixtureOnly", "runId", "attempt", "probeId", "payload", "sourcePricesIncluded", "publicationEligible"]);
  assert.doesNotMatch(JSON.stringify(result), /FIXTURE_ONLY_CREDENTIAL/u);
});

test("each invocation proves fresh write permission, while duplicate writes within it remain idempotent", async () => {
  const b = backend(), first = await verifyKisEodPrivateStorage({ env, fetchImpl: b.fetchImpl });
  const next = await verifyKisEodPrivateStorage({ env, fetchImpl: b.fetchImpl });
  assert.notEqual(next.testPath, first.testPath); assert.equal(next.createOnly, "STORED_AND_VERIFIED");
  await verifyKisEodPrivateStorage({ env: { ...env, GITHUB_RUN_ATTEMPT: "2" }, fetchImpl: b.fetchImpl });
  assert.equal(b.files.size, 3); assert.equal(b.requests.filter((r) => r.method === "PUT").length, 3);
});

test("previous successful fixture cannot conceal a token changed to read-only", async () => {
  const options = {}, b = backend(options);
  await verifyKisEodPrivateStorage({ env, fetchImpl: b.fetchImpl });
  options.readOnly = true;
  await assert.rejects(verifyKisEodPrivateStorage({ env, fetchImpl: b.fetchImpl }), { code: "PRIVATE_STORE_AUTHORIZATION_FAILED" });
  assert.equal(b.files.size, 1);
});

test("simulated authentication 401 and authorization 403 fail closed without price collection", async () => {
  for (const status of [401, 403]) {
    const b = backend({ status });
    await assert.rejects(verifyKisEodPrivateStorage({ env, fetchImpl: b.fetchImpl }), { code: "PRIVATE_STORE_AUTHORIZATION_FAILED" });
    assert.equal(b.files.size, 0); assert.equal(b.requests.length, 1);
  }
});

test("corrupt readback cannot claim verification", async () => {
  const b = backend({ corrupt: true });
  await assert.rejects(verifyKisEodPrivateStorage({ env, fetchImpl: b.fetchImpl }), { code: "PRIVATE_STORE_IMMUTABLE_CONFLICT" });
  assert.equal(b.files.size, 1);
});

test("wrong destination, missing secret, branch and path-like run identifiers fail before network", async () => {
  for (const changes of [{ KIS_OBSERVATION_STORE_REPOSITORY: "klkl789982-droid/stock-research" },
    { KIS_OBSERVATION_STORE_REPOSITORY: undefined }, { KIS_OBSERVATION_STORE_TOKEN: undefined },
    { KIS_OBSERVATION_STORE_BRANCH: "other" }, { GITHUB_RUN_ID: "../escape" }, { GITHUB_RUN_ATTEMPT: "" }]) {
    let called = false;
    await assert.rejects(verifyKisEodPrivateStorage({ env: { ...env, ...changes }, fetchImpl: () => { called = true; } }));
    assert.equal(called, false);
  }
});

test("CLI does not expose invalid arguments or credentials", () => {
  const result = spawnSync(process.execPath, ["scripts/verify-kis-eod-private-storage.mjs", "PRIVATE_ARGUMENT_MUST_NOT_LEAK"],
    { cwd: new URL("../", import.meta.url), env: { ...process.env, ...env }, encoding: "utf8" });
  assert.equal(result.status, 1); assert.match(result.stdout, /FIXTURE_CONFIGURATION_INVALID/u);
  assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE_ARGUMENT_MUST_NOT_LEAK|FIXTURE_ONLY_CREDENTIAL/u);
});

test("missing Actions secret is classified explicitly without requests or sensitive output", async () => {
  let requested = false;
  await assert.rejects(verifyKisEodPrivateStorage({ env: { ...env, KIS_OBSERVATION_STORE_TOKEN: "" },
    fetchImpl: () => { requested = true; } }), { code: "PRIVATE_STORE_TOKEN_UNAVAILABLE" });
  assert.equal(requested, false);
  const result = spawnSync(process.execPath, ["scripts/verify-kis-eod-private-storage.mjs"],
    { cwd: new URL("../", import.meta.url), env: { ...process.env, ...env, KIS_OBSERVATION_STORE_TOKEN: "" }, encoding: "utf8" });
  assert.equal(result.status, 1); assert.match(result.stdout, /PRIVATE_STORE_TOKEN_UNAVAILABLE/u);
  assert.doesNotMatch(result.stdout + result.stderr, /FIXTURE_ONLY_CREDENTIAL/u);
});

test("test workflow injects only storage secret and never enables source collection or public uploads", async () => {
  const text = await fs.readFile(new URL("../.github/workflows/kis-eod-private-storage-verification.yml", import.meta.url), "utf8");
  const workflow = yaml.load(text), job = workflow.jobs["verify-fixture"];
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.deepEqual(workflow.on.push.branches, ["main"]); assert.ok(Object.hasOwn(workflow.on, "workflow_dispatch"));
  assert.equal(workflow.on.schedule, undefined); assert.equal(workflow.on.pull_request, undefined);
  assert.equal(workflow.on.push.paths.length, 3);
  assert.equal(job.env.KIS_OBSERVATION_STORE_REPOSITORY, APPROVED_PRIVATE_REPOSITORY);
  assert.equal(job.env.KIS_OBSERVATION_STORE_TOKEN, "${{ secrets.KIS_OBSERVATION_STORE_TOKEN }}");
  assert.equal(Object.keys(job.env).length, 3); assert.match(job.if, /refs\/heads\/main/u);
  assert.equal(job.steps[0].with["persist-credentials"], false); assert.equal(job.steps[0].with.ref, "${{ github.sha }}");
  assert.doesNotMatch(text, /KIS_APP_|--collect|observe-kis-eod[.]mjs|actions\/(?:upload-artifact|cache)|git (?:add|commit|push)/u);
  const script = await fs.readFile(new URL("./verify-kis-eod-private-storage.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(script, /import.*(?:provider|observe-kis|token-manager)/u);
  const observation = await fs.readFile(new URL("../.github/workflows/kis-eod-observation.yml", import.meta.url), "utf8");
  assert.match(observation, /vars[.]KIS_EOD_OBSERVATION_ENABLED != 'false'/u);
  const full = await fs.readFile(new URL("../.github/workflows/kis-eod-private-models.yml", import.meta.url), "utf8");
  assert.match(full, /false && vars[.]KIS_EOD_COLLECTION_ENABLED/u);
  assert.match(observation, /vars[.]KIS_OBSERVATION_STORE_REPOSITORY \|\| 'klkl789982-droid\/tight-budget-private-data'/u);
});
