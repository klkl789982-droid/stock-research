import fs from "node:fs/promises";
import path from "node:path";
import { markKisEodPublished, toPublicKisEodProjection, validatePublicKisEodProjection } from "./kis-eod-pipeline.mjs";

// No source-price file or legacy outcome is ever staged by this namespace.
export function kisEodPublicationFiles(referenceDate) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(referenceDate ?? "")) throw new Error("KIS_EOD_DATE_INVALID");
  return [`data/kis-eod-published/${referenceDate}.json`];
}

// Deliberately not connected to an active workflow until the contract and rights
// evidence can be supplied by an approved adapter. A boolean alone cannot publish.
export async function publishVerifiedKisEodCandidate({ root, candidate, now = new Date(), enabled = false }) {
  if (enabled !== true) throw new Error("KIS_EOD_PUBLICATION_DISABLED");
  const projection = toPublicKisEodProjection(markKisEodPublished(candidate, new Date(now).toISOString()));
  const relative = kisEodPublicationFiles(candidate.referenceDate)[0];
  const target = path.join(root, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  try { await fs.writeFile(target, `${JSON.stringify(projection, null, 2)}\n`, { flag: "wx" }); }
  catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const existing = JSON.parse(await fs.readFile(target, "utf8"));
    if (validatePublicKisEodProjection(existing).length || existing.contentHash !== projection.contentHash) throw new Error("KIS_EOD_IMMUTABLE_PUBLICATION_CONFLICT");
    return { status: "KIS_EOD_PUBLISHED", action: "idempotent", files: [relative] };
  }
  return { status: "KIS_EOD_PUBLISHED", action: "create", files: [relative] };
}

// The HTTP route imports the read-only module without publication filesystem operations.
export { latestOfficialKisFallbackDate, readKisEodTopStocks } from "./kis-eod-read-store.mjs";
