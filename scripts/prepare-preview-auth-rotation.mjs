import { randomBytes } from "node:crypto";
import { lstat, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { authConfig, hashAdminPassword } from "../lib/admin-auth.mjs";

export const rotationKeys = ["TB_ADMIN_PASSWORD_HASH", "TB_SESSION_SECRET"];
const repository = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

// Called only by the user's hidden-input launcher. No password in argv, env,
// stdout, metadata, network requests or plaintext files. Directory ACLs are set
// by the Windows launcher BEFORE any values are created. Never overwrite.
export async function preparePreviewRotation(directory, password, confirmation) {
  if (typeof directory !== "string" || !path.isAbsolute(directory)) throw new Error("DIRECTORY_REQUIRED");
  const target = path.resolve(directory);
  if (target === repository || target.startsWith(repository + path.sep) || path.dirname(target) === target) throw new Error("PRIVATE_DIRECTORY_REQUIRED");
  const info = await lstat(target);
  if (!info.isDirectory() || info.isSymbolicLink() || (await readdir(target)).length) throw new Error("EMPTY_PRIVATE_DIRECTORY_REQUIRED");
  if (typeof password !== "string" || password !== confirmation) throw new Error("PASSWORD_CONFIRMATION_REQUIRED");
  const values = { TB_ADMIN_PASSWORD_HASH: await hashAdminPassword(password), TB_SESSION_SECRET: randomBytes(32).toString("base64url") };
  // Validate with the actual server contract, not a second hashing policy.
  authConfig({ ...values, TB_ADMIN_USERNAME: "preview-format-check", TB_AUTH_ORIGIN: "https://preview.invalid",
    TB_AUTH_REDIS_URL: "https://redis.invalid", TB_AUTH_REDIS_TOKEN: "not-an-upstream-credential" });
  for (const key of rotationKeys) await writeFile(path.join(target, key + ".secret"), values[key], { encoding: "utf8", flag: "wx", mode: 0o600 });
  await writeFile(path.join(target, "rotation-metadata.json"), JSON.stringify({ schemaVersion: 1, createdAt: new Date().toISOString(),
    target: "Preview only", branches: ["codex/home-summary-20261019", "integrate/1400-swing-r2-20261017"],
    keys: rotationKeys, productionChanged: false, remoteCredentialsChanged: false, valuesPrinted: false }, null, 2), { flag: "wx", mode: 0o600 });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 4 || process.argv[2] !== "--directory") throw new Error();
    const chunks = []; let size = 0;
    for await (const part of process.stdin) { size += part.length; if (size > 12000) throw new Error(); chunks.push(part); }
    const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    await preparePreviewRotation(process.argv[3], input.password, input.confirmation);
    process.stdout.write("PREVIEW_ROTATION_READY\n");
  } catch {
    // Do not log upstream error objects, input or newly generated values.
    process.stderr.write("PREVIEW_ROTATION_FAILED: check password policy, confirmation and empty private directory. Existing files were not overwritten.\n");
    process.exitCode = 1;
  }
}
