import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { assertPrivateKisEodPayload } from "./kis-eod-private-store.mjs";

// Local/private-only verification backend. This is not a GitHub-hosted runner's
// retention substitute: remote operations must use the existing private adapter.
export function createLocalPrivateModelStore(root = process.cwd()) {
  const base = path.resolve(root, ".runtime", "kis-eod", "private-model-store");
  const failure = () => Object.assign(new Error("PRIVATE_LOCAL_STORE_INVALID"), { code: "PRIVATE_LOCAL_STORE_INVALID" });
  const bytesOf = (value) => { assertPrivateKisEodPayload(value); return `${JSON.stringify(value, null, 2)}\n`; };
  const digest = (value) => createHash("sha256").update(value).digest("hex");
  async function target(key, directory = false) {
    if (!/^[A-Za-z0-9_./-]+$/u.test(key) || key.includes("..") || key.startsWith("/") || (!directory && !key.endsWith(".json"))) throw failure();
    const result = path.resolve(base, key);
    if (!result.startsWith(`${base}${path.sep}`)) throw failure();
    let cursor = path.resolve(root);
    for (const segment of path.relative(cursor, result).split(path.sep)) {
      cursor = path.join(cursor, segment);
      try { if ((await fs.lstat(cursor)).isSymbolicLink()) throw failure(); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    return result;
  }
  async function read(key) {
    try {
      const bytes = await fs.readFile(await target(key), "utf8");
      if (Buffer.byteLength(bytes) > 900000) throw failure();
      const value = JSON.parse(bytes); assertPrivateKisEodPayload(value);
      return { value, bytes, contentHash: digest(bytes) };
    } catch (error) { if (error.code === "ENOENT") return null; throw error; }
  }
  async function writeImmutable(key, value) {
    const bytes = bytesOf(value); if (Buffer.byteLength(bytes) > 900000) throw failure();
    const file = await target(key); await fs.mkdir(path.dirname(file), { recursive: true });
    let status = "STORED_AND_VERIFIED";
    try { await fs.writeFile(file, bytes, { flag: "wx", mode: 0o600 }); }
    catch (error) { if (error.code !== "EEXIST") throw error; status = "ALREADY_STORED"; }
    const stored = await read(key);
    if (stored?.contentHash !== digest(bytes)) throw Object.assign(new Error("PRIVATE_STORE_IMMUTABLE_CONFLICT"), { code: "PRIVATE_STORE_IMMUTABLE_CONFLICT" });
    return { status, contentHash: stored.contentHash };
  }
  async function listKeys(folder) {
    let entries;
    try { entries = await fs.readdir(await target(folder, true), { withFileTypes: true }); }
    catch (error) { if (error.code === "ENOENT") return []; throw error; }
    if (entries.length >= 1000 || entries.some((entry) => entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory()))) throw failure();
    return entries.map((entry) => ({ name: entry.name, type: entry.isDirectory() ? "dir" : "file" }));
  }
  return { read, writeImmutable, listKeys, verifyPrivateRepository: async () => { await target("check.json"); },
    preflight: async () => writeImmutable(`preflight/${randomUUID()}.json`, { namespace: "kis-private-local-preflight", sourcePricesIncluded: false }) };
}
