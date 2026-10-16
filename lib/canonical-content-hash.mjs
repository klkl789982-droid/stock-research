import { createHash } from "node:crypto";

export function plainCopy(value, seen = new Set(), depth = 0) {
  if (depth > 30) throw new TypeError("JSON_DEPTH_EXCEEDED");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "object" || seen.has(value)) throw new TypeError("NON_JSON_VALUE");
  if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError("NON_PLAIN_OBJECT");
  seen.add(value);
  const copy = Array.isArray(value) ? [] : {};
  for (const key of Object.keys(value).sort()) {
    if (["__proto__", "constructor", "prototype"].includes(key)) throw new TypeError("UNSAFE_OBJECT_KEY");
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) throw new TypeError("ACCESSOR_NOT_ALLOWED");
    copy[key] = plainCopy(descriptor.value, seen, depth + 1);
  }
  if (Array.isArray(value) && Object.keys(copy).length !== value.length) throw new TypeError("SPARSE_ARRAY");
  if (Object.getOwnPropertySymbols(value).length) throw new TypeError("SYMBOL_KEY_NOT_ALLOWED");
  seen.delete(value);
  return copy;
}

export function canonicalContentHash(value) {
  return createHash("sha256").update(JSON.stringify(plainCopy(value))).digest("hex");
}
