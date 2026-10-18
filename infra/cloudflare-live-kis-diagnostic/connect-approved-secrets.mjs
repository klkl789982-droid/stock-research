// Deliberately fixed source files/names and fixed isolated destination. Never
// print child output, secret values, complete env maps or process command lines.
import fs from "node:fs/promises";
import path from "node:path";
import { parseEnv } from "node:util";
import { spawn } from "node:child_process";
const root = path.resolve(import.meta.dirname, "../..");
async function put(name, value) {
  if (typeof value !== "string" || !value.trim() || /[\r\n]/u.test(value)) throw new Error("APPROVED_SECRET_UNAVAILABLE");
  const args = ["--yes", "wrangler@4.151.1", "secret", "put", name, "--config", "infra/cloudflare-live-kis-diagnostic/wrangler.jsonc"];
  // cmd.exe is only the Windows npm launcher, not a file operation; no secrets
  // appear in its arguments, and all program output is discarded.
  await new Promise((resolve, reject) => {
    const child = process.platform === "win32"
      ? spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", "npx", ...args], { cwd: root, windowsHide: true, stdio: ["pipe", "ignore", "ignore"] })
      : spawn("npx", args, { cwd: root, stdio: ["pipe", "ignore", "ignore"] });
    child.once("error", () => reject(new Error("SECRET_REGISTRATION_FAILED")));
    child.once("exit", code => code === 0 ? resolve() : reject(new Error("SECRET_REGISTRATION_FAILED")));
    child.stdin.on("error", () => {}); child.stdin.end(`${value.trim()}\n`);
  });
  console.log(JSON.stringify({ name, registered: true, destination: "tight-budget-live-kis-diagnostic", valuePrinted: false }));
}
try {
  if (process.argv[2] !== "--connect-approved") throw new Error("EXPLICIT_CONNECT_REQUIRED");
  const kis = parseEnv(await fs.readFile(path.join(root, ".env.local"), "utf8"));
  const writerFile = path.join(process.env.LOCALAPPDATA ?? "", "TightBudget", "site-relay-writer.env");
  const writer = parseEnv(await fs.readFile(writerFile, "utf8"));
  await put("KIS_APP_KEY", kis.KIS_APP_KEY);
  await put("KIS_APP_SECRET", kis.KIS_APP_SECRET);
  await put("PRIVATE_LIVE_DELIVERY_WRITE_TOKEN", writer.PRIVATE_LIVE_DELIVERY_WRITE_TOKEN);
} catch { console.error("APPROVED_SECRET_CONNECTION_FAILED_NO_VALUES_PRINTED"); process.exitCode = 1; }
