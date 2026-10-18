import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, rename } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createLocalExecutionStore } from "./store.mjs";

test("the actual daemon preserves liveness while three failed clock checks gate all observation", { timeout: 20000 }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tb-heartbeat-"));
  const clockFile = path.join(directory, "synthetic-clock"), base = Date.parse("2026-10-19T13:59:00+09:00");
  // The daemon reads this concurrently. Never expose a truncated clock value
  // (Number("") is zero) and accidentally send the fixture into a 10s idle wait.
  const setClock = async value => {
    const temporary = `${clockFile}.next`;
    await writeFile(temporary, String(value), { flag: "wx" });
    await rename(temporary, clockFile);
  };
  await setClock(base);
  const port = await new Promise(resolve => { const server = net.createServer(); server.listen(0, "127.0.0.1", () => { const p = server.address().port; server.close(() => resolve(p)); }); });
  const child = spawn(process.execPath, ["--import", new URL("./test-fixtures/clock-failure-loader.mjs", import.meta.url).href,
    fileURLToPath(new URL("./run.mjs", import.meta.url)), "--mode=daemon", `--state-dir=${directory}`, `--api-port=${port}`], {
    windowsHide: true, stdio: "ignore", env: { ...process.env, KIS_APP_KEY: "synthetic", KIS_APP_SECRET: "synthetic", PRIVATE_LIVE_DELIVERY_SEND_ENABLED: "false", LOCALAPPDATA: directory, TB_TEST_CLOCK_FILE: clockFile },
  });
  let exited = false; child.once("exit", () => { exited = true; });
  t.after(async () => {
    if (!exited) { child.kill("SIGKILL"); await new Promise(resolve => child.once("exit", resolve)); }
    await rm(directory, { recursive: true, force: true });
  });
  const store = createLocalExecutionStore(directory);
  const until = async check => {
    for (let n = 0; n < 100; n++) {
      assert.equal(exited, false, "isolated daemon must remain running");
      if (await check()) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.fail("daemon did not produce expected isolated evidence");
  };
  await until(async () => (await store.read("live/clock-status.json"))?.attempts === 1);
  for (const [offset, attempts] of [[15000, 2], [30000, 3]]) {
    await setClock(base + offset);
    await until(async () => (await store.read("live/clock-status.json"))?.attempts === attempts);
  }
  await setClock(base + 150000);
  await until(async () => Date.parse((await store.read("live/daemon-status.json"))?.heartbeatAt) === base + 150000);
  assert.equal((await store.read("live/clock-status.json")).status, "FAILED");
  assert.equal(await store.read("live/latest.json"), null);
  assert.equal(await store.read("live/2026-10-19/2026-10-19/result.json"), null);
});
