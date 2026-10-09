import path from "node:path";
import { pathToFileURL } from "node:url";
import { randomBytes } from "node:crypto";
import { kisEodPrivateStoreFromEnv } from "../lib/kis-eod-private-store.mjs";
import { queryLatestPrivateModelTop, readPrivateModelHead, readPrivateModelBlob } from "../lib/kis-eod-private-models.mjs";
import { KIS_EOD_MODEL_VERSIONS } from "../lib/kis-eod-pipeline.mjs";
import { createPrivateTopServer } from "./serve-kis-eod-private-top.mjs";

export async function verifyRemotePrivateTop(store = kisEodPrivateStoreFromEnv(), expectedReferenceDate = process.env.KIS_PRIVATE_EXPECTED_REFERENCE_DATE) {
  await store.verifyPrivateRepository();
  const latest = await queryLatestPrivateModelTop(store);
  if (latest.status !== "PRIVATE_VALIDATED_PROVISIONAL") throw new Error("PRIVATE_TOP_NOT_AVAILABLE");
  if (expectedReferenceDate && latest.referenceDate !== expectedReferenceDate) throw new Error("PRIVATE_TOP_EXPECTED_DATE_MISMATCH");
  const mode = latest.dataMode === "kisPrivate-live" ? "live" : "research";
  const head = await readPrivateModelHead(store, mode);
  await readPrivateModelBlob(store, `model-top/${mode}`, head.source);
  const accessToken = randomBytes(32).toString("hex");
  const server = createPrivateTopServer({ store, accessToken });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/kis-eod-private-top-stocks`;
  const rankingCounts = {};
  try {
    if ((await fetch(base)).status !== 401) throw new Error("PRIVATE_TOP_AUTHENTICATION_FAILED");
    for (const version of KIS_EOD_MODEL_VERSIONS) for (const limit of [5, 10, 20]) {
      const response = await fetch(`${base}?version=${version}&limit=${limit}`, { headers: { Authorization: `Bearer ${accessToken}` } });
      const value = await response.json();
      if (!response.ok || value.referenceDate !== latest.referenceDate || value.promotionHash !== latest.promotionHash
        || value.stocks.length !== Math.min(limit, value.eligibleCount)
        || value.stocks.some((stock, index) => stock.rank !== index + 1 || !stock.code || !stock.name || !Number.isFinite(stock.score))
        || /"(?:clpr|mkp|trqu|trPrc|histories|token|authorization)"/iu.test(JSON.stringify(value))) throw new Error("PRIVATE_TOP_QUERY_FAILED");
      rankingCounts[version] = { eligibleCount: value.eligibleCount, excludedCount: value.excludedCount };
    }
    return { status: "REMOTE_TOP_VERIFIED", referenceDate: latest.referenceDate, observationType: latest.observationType,
      storageMode: mode, promotionHash: latest.promotionHash, sourceAndModelsReadHash: "VERIFIED", httpQueryCount: 15,
      unauthenticatedStatus: 401, rankingCounts, sourceFinality: "NOT_CONFIRMED", publicationEligible: false };
  } finally { await new Promise((resolve) => server.close(resolve)); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { console.log(`KIS_PRIVATE_REMOTE_TOP_JSON=${JSON.stringify(await verifyRemotePrivateTop())}`); }
  catch { console.log('KIS_PRIVATE_REMOTE_TOP_JSON={"status":"FAILED","reason":"PRIVATE_REMOTE_READBACK_FAILED"}'); process.exitCode = 1; }
}
