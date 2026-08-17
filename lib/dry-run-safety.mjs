import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const PROTECTED_DRY_RUN_FILES = [
  "data/history/2026-08-13.json", "data/universe.json", "data/trading-calendar/status.json",
  "data/top-stocks.json", "data/model-registry.json", "lib/technical-strength.mjs",
  "lib/technical-strength-v2.mjs", "lib/trend-strength.mjs", "lib/entry-strength.mjs",
  "lib/combined-technical-score.mjs",
];
export const PRODUCTION_DATA_DIRECTORIES = ["data/history", "data/market-prices", "data/universe-history"];

async function hashFile(filePath) {
  try { return createHash("sha256").update(await fs.readFile(filePath)).digest("hex"); }
  catch (error) { if (error?.code === "ENOENT") return null; throw error; }
}

async function listDirectory(directory) {
  try { return (await fs.readdir(directory, { recursive: true, withFileTypes: true })).filter((entry) => entry.isFile()).map((entry) => path.join(entry.parentPath ?? entry.path, entry.name)).sort(); }
  catch (error) { if (error?.code === "ENOENT") return []; throw error; }
}

export async function captureDryRunProductionState(root = process.cwd()) {
  const protectedHashes = Object.fromEntries(await Promise.all(PROTECTED_DRY_RUN_FILES.map(async (relative) => [relative, await hashFile(path.join(root, relative))])));
  const productionFiles = {};
  for (const relative of PRODUCTION_DATA_DIRECTORIES) {
    const absoluteFiles = await listDirectory(path.join(root, relative));
    productionFiles[relative] = Object.fromEntries(await Promise.all(absoluteFiles.map(async (absolute) => [path.relative(root, absolute).replaceAll("\\", "/"), await hashFile(absolute)])));
  }
  return { protectedHashes, productionFiles };
}

export function compareDryRunProductionState(before, after) {
  const unchanged = JSON.stringify(before) === JSON.stringify(after);
  return { unchanged, before, after };
}

export function sanitizeDryRunText(value) {
  return String(value)
    .replace(/([?&](?:serviceKey|crtfc_key|appkey|appsecret|access_token)=)[^&\s]+/giu, "$1[REDACTED]")
    .replace(/(Bearer\s+)[A-Za-z0-9._~-]+/giu, "$1[REDACTED]");
}
