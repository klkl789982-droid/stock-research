import fs from "node:fs/promises";
import path from "node:path";

// Only this project's named writer file may supply the delivery credential.
// No credential discovery, reader-token reuse or public publication is allowed.
export async function writerEnvironment(env = process.env, { readFile = fs.readFile } = {}) {
  const filename = env.PRIVATE_LIVE_DELIVERY_WRITER_ENV_FILE ?? (env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, "TightBudget", "site-relay-writer.env") : null);
  let token = null;
  if (filename) {
    if (!path.isAbsolute(filename)) throw new Error("SITE_RELAY_ENV_PATH_INVALID");
    let source;
    try { source = await readFile(filename, "utf8"); } catch (error) { if (error.code !== "ENOENT") throw new Error("SITE_RELAY_ENV_UNREADABLE"); }
    if (source !== undefined) {
      const lines = source.replace(/^\uFEFF/u, "").split(/\r?\n/u).map(line => line.trim()).filter(line => line && !line.startsWith("#"));
      if (lines.length > 1 || (lines.length && !/^PRIVATE_LIVE_DELIVERY_WRITE_TOKEN=[A-Za-z0-9_]+$/u.test(lines[0]))) throw new Error("SITE_RELAY_ENV_INVALID");
      token = lines[0]?.slice("PRIVATE_LIVE_DELIVERY_WRITE_TOKEN=".length) ?? null;
    }
  }
  return { PRIVATE_LIVE_DELIVERY_SEND_ENABLED: token ? "true" : "false", PRIVATE_LIVE_DELIVERY_REPOSITORY: "klkl789982-droid/tight-budget-private-data", ...(token ? { PRIVATE_LIVE_DELIVERY_WRITE_TOKEN: token } : {}) };
}
