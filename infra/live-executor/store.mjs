import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";

const defaultRepositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const MAX_BYTES = 64 * 1024 * 1024;
const fail = (code) => { throw Object.assign(new Error(code), { code }); };
const inside = (candidate, directory) => {
  const a = process.platform === "win32" ? candidate.toLowerCase() : candidate;
  const b = process.platform === "win32" ? directory.toLowerCase() : directory;
  return a === b || a.startsWith(`${b}${path.sep}`);
};
const canonical = (value, seen = new Set()) => {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (!value || typeof value !== "object" || seen.has(value)
    || (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value)))) fail("LIVE_STORE_JSON_INVALID");
  seen.add(value);
  const result = Array.isArray(value) ? value.map((child) => canonical(child, seen))
    : Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key], seen)]));
  seen.delete(value);
  return result;
};
const digest = (value) => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");

async function rejectLinks(target) {
  let current = path.parse(target).root;
  for (const segment of target.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try { if ((await fs.lstat(current)).isSymbolicLink()) fail("LIVE_STORE_SYMLINK_REJECTED"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}

// Local durable storage is deliberately outside the source checkout and Vercel
// trace. Credentials, remote upload and public publication are not store duties.
export function createLocalExecutionStore(stateDir, { repositoryRoot = defaultRepositoryRoot } = {}) {
  if (typeof stateDir !== "string" || !path.isAbsolute(stateDir)) fail("LIVE_STORE_ABSOLUTE_DIRECTORY_REQUIRED");
  const base = path.resolve(stateDir), repository = path.resolve(repositoryRoot);
  if (base === path.parse(base).root || inside(base, repository)
    || base.split(path.sep).some((part) => ["public", ".git"].includes(part.toLowerCase()))) fail("LIVE_STORE_DIRECTORY_NOT_PRIVATE");
  const target = async (key) => {
    if (typeof key !== "string" || !/^(?:live|shadow)\/[A-Za-z0-9_./-]+[.]json$/u.test(key)
      || key.includes("..") || key.includes("//")) fail("LIVE_STORE_KEY_INVALID");
    const filename = path.resolve(base, ...key.split("/"));
    if (!inside(filename, base) || filename === base) fail("LIVE_STORE_KEY_INVALID");
    await rejectLinks(filename);
    return filename;
  };
  const encode = (kind, value) => {
    const normalized = canonical(value), hash = digest({ schemaVersion: 1, kind, value: normalized });
    const bytes = `${JSON.stringify({ schemaVersion: 1, kind, hash, value: normalized })}\n`;
    if (Buffer.byteLength(bytes) > MAX_BYTES) fail("LIVE_STORE_PAYLOAD_TOO_LARGE");
    return { bytes, hash };
  };
  async function readEnvelope(key) {
    const filename = await target(key);
    let bytes;
    try {
      const stat = await fs.lstat(filename);
      if (!stat.isFile() || stat.size > MAX_BYTES) fail("LIVE_STORE_FILE_INVALID");
      bytes = await fs.readFile(filename, "utf8");
    } catch (error) { if (error.code === "ENOENT") return null; throw error; }
    let envelope;
    try { envelope = JSON.parse(bytes); } catch { fail("LIVE_STORE_HASH_MISMATCH"); }
    if (envelope?.schemaVersion !== 1 || !["immutable", "mutable"].includes(envelope.kind)
      || !/^[a-f0-9]{64}$/u.test(envelope.hash ?? "")
      || digest({ schemaVersion: envelope.schemaVersion, kind: envelope.kind, value: envelope.value }) !== envelope.hash) fail("LIVE_STORE_HASH_MISMATCH");
    return envelope;
  }
  async function temporary(filename, bytes) {
    await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
    await rejectLinks(filename);
    const filenameTemp = `${filename}.${randomUUID()}.tmp`;
    const handle = await fs.open(filenameTemp, "wx", 0o600);
    try { await handle.writeFile(bytes, "utf8"); await handle.sync(); }
    finally { await handle.close(); }
    return filenameTemp;
  }
  async function writeImmutable(key, value) {
    const filename = await target(key), { bytes, hash } = encode("immutable", value);
    const existing = await readEnvelope(key);
    if (existing) {
      if (existing.kind !== "immutable" || existing.hash !== hash) fail("LIVE_STORE_IMMUTABLE_CONFLICT");
      return { hash, disposition: "existing" };
    }
    const filenameTemp = await temporary(filename, bytes);
    let disposition = "created";
    try {
      // Hard-link installation is create-only and cannot expose a partial JSON
      // object if the process stops while writing the temporary file.
      try { await fs.link(filenameTemp, filename); }
      catch (error) { if (error.code !== "EEXIST") throw error; disposition = "existing"; }
      const stored = await readEnvelope(key);
      if (stored?.kind !== "immutable" || stored.hash !== hash) fail("LIVE_STORE_IMMUTABLE_CONFLICT");
      return { hash, disposition };
    } finally { await fs.unlink(filenameTemp).catch((error) => { if (error.code !== "ENOENT") throw error; }); }
  }
  async function withLock(name, fn) {
    if (typeof name !== "string" || !/^[A-Za-z0-9_.-]{1,120}$/u.test(name) || name.includes("..") || typeof fn !== "function") fail("LIVE_STORE_LOCK_INVALID");
    const locks = path.join(base, ".locks"), filename = path.join(locks, `${name}.json`);
    await rejectLinks(filename);
    await fs.mkdir(locks, { recursive: true, mode: 0o700 });
    const owner = { pid: process.pid, nonce: randomUUID(), createdAt: new Date().toISOString() };
    const readOwner = async () => {
      await rejectLinks(filename);
      let value;
      try { value = JSON.parse(await fs.readFile(filename, "utf8")); }
      catch (error) { if (error.code === "ENOENT") return null; fail("LIVE_STORE_LOCK_REQUIRES_REVIEW"); }
      if (!Number.isSafeInteger(value?.pid) || value.pid < 1 || !/^[a-f0-9-]{36}$/u.test(value.nonce ?? "")) fail("LIVE_STORE_LOCK_REQUIRES_REVIEW");
      return value;
    };
    const acquire = async () => {
      try { await fs.writeFile(filename, JSON.stringify(owner), { flag: "wx", mode: 0o600 }); return true; }
      catch (error) { if (error.code === "EEXIST") return false; throw error; }
    };
    if (!await acquire()) {
      // Serialize dead-owner recovery. Never reclaim on elapsed time alone:
      // slow requests and PID reuse must not permit concurrent collectors.
      const recovery = path.join(locks, `${name}.recovery`);
      try { await fs.mkdir(recovery, { mode: 0o700 }); }
      catch (error) { if (error.code === "EEXIST") fail("LIVE_STORE_LOCKED"); throw error; }
      try {
        const prior = await readOwner();
        if (prior) {
          try { process.kill(prior.pid, 0); fail("LIVE_STORE_LOCKED"); }
          catch (error) { if (error.code !== "ESRCH") throw Object.assign(new Error("LIVE_STORE_LOCKED"), { code: "LIVE_STORE_LOCKED" }); }
          await fs.unlink(filename);
        }
        if (!await acquire()) fail("LIVE_STORE_LOCKED");
      } finally { await fs.rmdir(recovery); }
    }
    try { return await fn(); }
    finally {
      const current = await readOwner();
      if (current?.nonce !== owner.nonce || current.pid !== owner.pid) fail("LIVE_STORE_LOCK_OWNERSHIP_LOST");
      await fs.unlink(filename);
    }
  }
  async function writeMutable(key, value) {
    const filename = await target(key), { bytes, hash } = encode("mutable", value);
    return withLock(`mutable-${createHash("sha256").update(key).digest("hex")}`, async () => {
      const previous = await readEnvelope(key);
      if (previous?.kind === "immutable") fail("LIVE_STORE_IMMUTABLE_CONFLICT");
      if (previous?.hash === hash) return { hash, disposition: "existing" };
      const filenameTemp = await temporary(filename, bytes);
      try {
        if (previous) await fs.rename(filenameTemp, filename);
        else {
          // An immutable writer may create this previously absent key while we
          // prepare bytes. Never rename over that winner.
          try { await fs.link(filenameTemp, filename); }
          catch (error) { if (error.code !== "EEXIST") throw error; fail("LIVE_STORE_IMMUTABLE_CONFLICT"); }
        }
      }
      finally { await fs.unlink(filenameTemp).catch((error) => { if (error.code !== "ENOENT") throw error; }); }
      if ((await readEnvelope(key))?.hash !== hash) fail("LIVE_STORE_HASH_MISMATCH");
      return { hash, disposition: previous ? "updated" : "created" };
    });
  }
  return { read: async (key) => (await readEnvelope(key))?.value ?? null, writeImmutable, writeMutable, withLock };
}
