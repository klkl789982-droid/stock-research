// Local/private query only. Rights evidence is supplied by the operator, never granted by this CLI.
import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createLocalPrivateModelStore } from "../lib/kis-eod-private-local-store.mjs";
import { readResearchResult, queryResearchTop } from "../lib/market-source-research.mjs";
export async function queryStoredResearch({ root = process.cwd(), key, grants, version, limit }) {
  const result = await readResearchResult({ store: createLocalPrivateModelStore(root), key, grants });
  return { namespace: "market-source-research-v1", publication: "DISABLED", ...queryResearchTop(result, version, limit) };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2), opts = Object.fromEntries(args.map((v) => {
      const match = v.match(/^--(manifest|rights|model|top)=(.+)$/u); if (!match) throw new Error("QUERY_ARGS_INVALID"); return [match[1], match[2]];
    }));
    if (args.length !== 4 || Object.keys(opts).length !== 4) throw new Error("QUERY_ARGS_INVALID");
    const bytes = await fs.readFile(opts.rights, "utf8"); if (Buffer.byteLength(bytes) > 20000) throw new Error("QUERY_RIGHTS_INVALID");
    console.log(JSON.stringify(await queryStoredResearch({ key: opts.manifest, grants: JSON.parse(bytes), version: opts.model, limit: Number(opts.top) })));
  } catch { console.error("PRIVATE_RESEARCH_QUERY_FAILED"); process.exitCode = 1; }
}
