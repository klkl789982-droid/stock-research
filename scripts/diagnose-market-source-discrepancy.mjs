// Bounded, read-only forensic queries. Raw responses exist only in memory.
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createKisTokenManager } from "../lib/kis-token-manager-core.mjs";
import { createKisApiClient } from "../lib/kis-api-client-core.mjs";
import { createKisEodProvider } from "../lib/kis-eod-provider.mjs";
import { createPublicEodQuery, createPublicEodRequestShape, normalizePublicEodRows } from "../lib/public-eod-request.mjs";
import { sha256Canonical } from "../lib/snapshot-quality-pipeline.mjs";
import { validResearchDate } from "../lib/market-source-contract.mjs";
import { decodeOfficialSeedRow, forensicComparison, diagnoseObservationRevision } from "../lib/market-source-forensics.mjs";
export async function diagnoseSourceDiscrepancy({ date, root = process.cwd(), codes, fetchImpl = fetch, env = process.env }) {
  if (!validResearchDate(date) || !Array.isArray(codes) || !codes.length || codes.length > 10 || new Set(codes).size !== codes.length || codes.some((c) => !/^\d{6}$/u.test(c))) throw new Error("FORENSIC_ARGUMENT_INVALID");
  const seed = JSON.parse(await fs.readFile(path.join(root, "data/analysis/market-seeds", `${date}.json`), "utf8"));
  const base = path.join(root, ".runtime/kis-eod/audits", date), dirs = (await fs.readdir(base)).filter((v) => /^[a-f0-9]{64}$/u.test(v));
  if (dirs.length !== 1) throw new Error("FORENSIC_AUDIT_AMBIGUOUS");
  const raw = []; let attempts = 0;
  const boundedFetch = async (url, init = {}) => {
    if (++attempts > 45) throw new Error("FORENSIC_REQUEST_LIMIT");
    const r = await fetchImpl(url, { ...init, redirect: "error", cache: "no-store", signal: init.signal ?? AbortSignal.timeout(15000) });
    if (new URL(url).pathname.endsWith("/inquire-daily-itemchartprice") && r.ok) raw.push({ flag: new URL(url).searchParams.get("FID_ORG_ADJ_PRC"), payload: await r.clone().json() });
    return r;
  };
  const credentials = () => ({ appKey: env.KIS_APP_KEY, appSecret: env.KIS_APP_SECRET });
  const tokenManager = createKisTokenManager({ fetchImpl: boundedFetch, getCredentials: credentials });
  const client = createKisApiClient({ fetchImpl: boundedFetch, tokenManager, getCredentials: credentials });
  const provider = createKisEodProvider({ client, delayMs: 350, maxAttempts: 2, timeoutMs: 15000 });
  const startedAt = new Date().toISOString(), results = [];
  for (const code of codes) {
    try {
      const a = JSON.parse(await fs.readFile(path.join(base, dirs[0], "success", `${code}.json`), "utf8")), { artifactHash, ...body } = a;
      if (sha256Canonical(body) !== artifactHash || a.code !== code || a.manifestHash !== dirs[0]) throw new Error("FORENSIC_CACHED_HASH_INVALID");
      raw.length = 0;
      const history = await provider.getHistory(code, date, { requiredRows: 5, maxPages: 1 });
      const payload = raw.find((v) => v.flag === "1")?.payload;
      const native = payload?.output2?.find((r) => r.stck_bsop_date === date.replaceAll("-", ""));
      if (!native) throw new Error("FORENSIC_RAW_ROW_UNAVAILABLE");
      const mapped = { basDt: native.stck_bsop_date, srtnCd: payload.output1.stck_shrn_iscd, ...Object.fromEntries([['mkp','stck_oprc'],['hipr','stck_hgpr'],['lopr','stck_lwpr'],['clpr','stck_clpr'],['trqu','acml_vol'],['trPrc','acml_tr_pbmn']].map(([a,b]) => [a, native[b] === '' || native[b] == null ? null : Number(native[b])])) };
      const adjusted = await provider.getHistory(code, date, { adjustment: "adjusted", requiredRows: 5, maxPages: 1 });
      if (!env.DATA_GO_KR_SERVICE_KEY) throw new Error("FORENSIC_PUBLIC_CREDENTIAL_UNAVAILABLE");
      const query = createPublicEodQuery(createPublicEodRequestShape({ code, numOfRows: 5 }));
      query.set("basDt", date.replaceAll("-", "")); query.set("serviceKey", decodeURIComponent(env.DATA_GO_KR_SERVICE_KEY));
      const requestedAt = new Date().toISOString();
      const response = await boundedFetch(`https://apis.data.go.kr/1160100/service/GetStockSecuritiesInfoService/getStockPriceInfo?${query}`);
      if (!response.ok) throw new Error("FORENSIC_PUBLIC_HTTP_FAILED");
      const p = await response.json(); if (p?.response?.header?.resultCode !== "00") throw new Error("FORENSIC_PUBLIC_BUSINESS_FAILED");
      const rows = normalizePublicEodRows(p.response.body?.items?.item, { code, requestedDate: date.replaceAll("-", "") }).rows;
      if (rows.length !== 1 || rows[0].basDt !== date.replaceAll("-", "")) throw new Error("FORENSIC_PUBLIC_EXACT_DATE_MISSING");
      const official = { basDt: rows[0].basDt, srtnCd: code, ...Object.fromEntries(["mkp","hipr","lopr","clpr","trqu","trPrc"].map((f) => [f, rows[0][f] == null || rows[0][f] === "" ? null : Number(rows[0][f])])) };
      results.push({ ...diagnoseObservationRevision({ cached: a.history.rows[0], fresh: history.rows[0], official, saved: decodeOfficialSeedRow(seed, code, date), rawKisMapped: mapped, observationHashVerified: true }),
        cachedRequestedAt: a.history.requestedAt, cachedReceivedAt: a.history.receivedAt, freshRequestedAt: history.requestedAt, freshReceivedAt: history.receivedAt,
        publicRequestedAt: requestedAt, publicReceivedAt: new Date().toISOString(), rawResponseHash: sha256Canonical(payload), publicResponseHash: sha256Canonical(p),
        adjustedCurrentOHLCVEqual: forensicComparison(adjusted.rows[0], history.rows[0]).equalOHLCV, corporateActionReported: history.adjustmentMetadata.some((m) => m.changed === "Y" || m.splitRatio), status: "VERIFIED_SAMPLE" });
    } catch (error) { results.push({ code, status: "FAILED", reason: /^FORENSIC_[A-Z_]+$/u.test(error?.message ?? "") ? error.message : "FORENSIC_SAMPLE_UNVERIFIED" }); }
  }
  return { namespace: "market-source-forensics-v1", date, startedAt, completedAt: new Date().toISOString(), attempts, samples: codes.length, results, rawStored: false, productionChanged: false };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { const args = process.argv.slice(2); if (args.length !== 2) throw new Error("ARGS");
    const result = await diagnoseSourceDiscrepancy({ date: args.find((v) => v.startsWith("--date="))?.slice(7), codes: args.find((v) => v.startsWith("--codes="))?.slice(8).split(",") });
    console.log(JSON.stringify(result));
    if (result.results.some((r) => r.status !== "VERIFIED_SAMPLE")) process.exitCode = 1;
  } catch { console.error("FORENSIC_DIAGNOSIS_FAILED"); process.exitCode = 1; }
}
