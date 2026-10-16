import test from "node:test";
import assert from "node:assert/strict";
import { writerEnvironment } from "./writer-environment.mjs";
const env = { PRIVATE_LIVE_DELIVERY_WRITER_ENV_FILE: process.platform === "win32" ? "C:/private/site-relay-writer.env" : "/private/site-relay-writer.env" };
test("missing dedicated writer keeps collection available and remote sending disabled", async () => {
  const value = await writerEnvironment(env, { readFile: async () => { throw Object.assign(new Error(), { code: "ENOENT" }); } });
  assert.equal(value.PRIVATE_LIVE_DELIVERY_SEND_ENABLED, "false");
  assert.equal(value.PRIVATE_LIVE_DELIVERY_WRITE_TOKEN, undefined);
});
test("only a single named writer entry is accepted; credentials are never repurposed", async () => {
  const fake = "synthetic_test_only";
  const value = await writerEnvironment(env, { readFile: async () => `# private\nPRIVATE_LIVE_DELIVERY_WRITE_TOKEN=${fake}\n` });
  assert.equal(value.PRIVATE_LIVE_DELIVERY_SEND_ENABLED, "true"); assert.equal(value.PRIVATE_LIVE_DELIVERY_WRITE_TOKEN, fake);
  for (const text of ["GITHUB_TOKEN=synthetic", "PRIVATE_LIVE_DELIVERY_WRITE_TOKEN=x\nANOTHER=y", "PRIVATE_LIVE_DELIVERY_WRITE_TOKEN=x y"])
    await assert.rejects(writerEnvironment(env, { readFile: async () => text }), /ENV_INVALID/);
  await assert.rejects(writerEnvironment(env, { readFile: async () => { throw Object.assign(new Error("private"), { code: "EACCES" }); } }), /^Error: SITE_RELAY_ENV_UNREADABLE$/);
});
