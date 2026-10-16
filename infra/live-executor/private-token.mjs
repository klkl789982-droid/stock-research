import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { createLocalExecutionStore } from "./store.mjs";

// Local service credential only: never a browser token or remote KIS credential.
export async function privateApiToken(stateDir) {
  createLocalExecutionStore(stateDir);
  const directory = path.join(stateDir, "auth"), filename = path.join(directory, "read-token");
  let current = path.parse(directory).root;
  for (const part of directory.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try { if ((await fs.lstat(current)).isSymbolicLink()) throw new Error("LOCAL_TOKEN_PATH_REJECTED"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    const handle = await fs.open(filename, "wx", 0o600);
    try { await handle.writeFile(randomBytes(32).toString("hex")); await handle.sync(); }
    finally { await handle.close(); }
  } catch (error) { if (error.code !== "EEXIST") throw error; }
  const stat = await fs.lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== 64) throw new Error("LOCAL_TOKEN_FILE_INVALID");
  const token = await fs.readFile(filename, "utf8");
  if (!/^[a-f0-9]{64}$/u.test(token)) throw new Error("LOCAL_TOKEN_FILE_INVALID");
  return token;
}
