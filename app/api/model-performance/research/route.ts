import { withAdminAccess } from "@/lib/admin-access";
import { NextResponse } from "next/server";
import { loadModelPerformanceResearch } from "@/lib/model-performance-research-store.mjs";
import { validateResearchOptions } from "@/lib/model-performance-research.mjs";
import { kisRequest } from "@/lib/kis-token-manager";
import { loadPublicationEvidence } from "@/lib/daily-publication-status.mjs";
import { loadPrivateBenchmarkLegs } from "@/lib/research-index-benchmarks.mjs";
import { readResearchPublicationReceipts } from "@/lib/research-publication-receipts.mjs";
import frozenStudy from "@/data/model-validation/frozen-strategy-summary-20261103.json";
import taxStudy from "@/data/model-validation/sell-tax-comparison-20261103.json";
import crossStudy from "@/data/model-validation/top-cross-comparison-v1.json";
import { compareOfficialMarkets } from "@/lib/top-cross-benchmark.mjs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const headers = { "Cache-Control": "no-store" };
type ResearchResult = Awaited<ReturnType<typeof loadModelPerformanceResearch>>;
const inventoryOf = (result: ResearchResult) => ({ choices: result.choices, asOf: result.asOf, confirmedDates: result.verifiedPublicationDates, study: {
  ...frozenStudy, sellTax: taxStudy.protocolHash === frozenStudy.protocolHash && taxStudy.sourceStudyHash === frozenStudy.sourceStudyHash ? taxStudy.comparisons : [],
} });
let cachedInventory: { expiresAt: number; body: ReturnType<typeof inventoryOf> } | null = null;
let pendingInventory: Promise<ReturnType<typeof inventoryOf>> | null = null;

async function handleGet(request: Request) {
  const query = new URL(request.url).searchParams;
  const view = query.get("view");
  if(view==="top-cross" && [...query].length===1){
    try{return NextResponse.json({version:crossStudy.version,through:crossStudy.through,planHash:crossStudy.planHash,inventory:crossStudy.inventory,summary:await compareOfficialMarkets(crossStudy,kisRequest)},{headers});}
    catch{return NextResponse.json({status:"COMPARISON_READ_FAILED"},{status:503,headers});}
  }
  const inventory = view === "backtest-options";
  let options;
  try {
    if ((view && !["backtest-options", "backtest"].includes(view)) || (inventory && [...query].length !== 1)) throw new Error();
    const numberInput = (key: string) => { const value = query.get(key); return value == null || !value.trim() ? NaN : Number(value); };
    const mode = query.get("costMode") ?? "GROSS_ONLY";
    const cost = mode === "USER_INPUT" ? {
      mode, buyFeeBps: numberInput("buyFeeBps"), sellFeeBps: numberInput("sellFeeBps"), sellTaxBps: numberInput("sellTaxBps"),
      buySlippageBps: numberInput("buySlippageBps"), sellSlippageBps: numberInput("sellSlippageBps"), basisDate: query.get("basisDate"), basis: query.get("basis"),
    } : { mode };
    options = inventory ? validateResearchOptions({ topN: 20, classification: "PUBLISHED_PRICE_OBSERVATION", benchmark: "NONE" }) : validateResearchOptions({ ...(query.has("models") ? { models: query.get("models")!.split(",") } : {}),
      topN: Number(query.get("topN") ?? 10), horizon: query.get("horizon") ?? "H1", market: query.get("market") ?? "ALL", classification: query.get("classification") ?? "AS_PUBLISHED",
      benchmark: query.get("benchmark") ?? "MATCHED_MARKET", from: query.get("from") || null, to: query.get("to") || null, cost });
    if (view === "backtest" && (options.models.length !== 1 || options.classification !== "PUBLISHED_PRICE_OBSERVATION")) throw new Error();
  } catch {
    return NextResponse.json({ status: "INVALID_RESEARCH_FILTER", message: "모델·기간·비용 입력을 확인하세요." }, { status: 400, headers });
  }
  try {
    const load = () => loadModelPerformanceResearch({ options, includeChoices: inventory, compareTax: view === "backtest", indexRequest: kisRequest, archiveReader: loadPrivateBenchmarkLegs,
      receiptReader: readResearchPublicationReceipts, publicationEvidence: loadPublicationEvidence });
    if (inventory) {
      if (cachedInventory && cachedInventory.expiresAt > Date.now()) return NextResponse.json(cachedInventory.body, { headers });
      pendingInventory ??= load().then(inventoryOf).then(body => {
        cachedInventory = { body, expiresAt: Date.now() + 120_000 };
        return body;
      }).finally(() => { pendingInventory = null; });
      return NextResponse.json(await pendingInventory, { headers });
    }
    const result = await load();
    if (view === "backtest") {
      const cohorts = result.cohorts.map(c => ({
        id: c.id, formulaHash: c.formulaHash, signalDates: c.signalDates, matureDates: c.matureSignalDateCount, universeCount: c.universeCount,
        mature: c.stockMetrics.observationCount, pending: c.pendingCount, missing: c.missingCount,
        distinctStocks: c.uniqueStockCount, repeats: c.repeatedObservationCount, stockMean: c.stockMetrics.meanReturn,
        basketMean: c.portfolioMetrics.meanReturn, scenarioMean: c.netScenarioMetrics.meanReturn, taxComparison: c.taxComparison ?? null,
        benchmarkDates: c.excessMetrics.observationCount, grossExcess: c.excessMetrics.meanReturn,
        account: { status: c.fundedAccount.status, total: c.fundedAccount.totalReturn, maxDrawdown: c.fundedAccount.maxDrawdown,
          exposure: c.fundedAccount.averageExposurePct, buys: c.fundedAccount.tradeCount },
      }));
      return NextResponse.json({ cohorts, filter: result.filter, asOf: result.asOf, confirmedDates: result.verifiedPublicationDates }, { headers });
    }
    // Derived statistics only. Entry/exit/reference raw prices are not returned by this public route.
    const cohorts = result.cohorts.map((cohort: { rows: Array<Record<string, unknown>> }) => ({ ...cohort, rows: cohort.rows.map(({ referencePrice: _price, ...row }) => { void _price; return row; }) }));
    return NextResponse.json({ ...result, cohorts }, { headers });
  } catch {
    return NextResponse.json({ status: "RESEARCH_DATA_UNAVAILABLE", message: "공식 연구 입력의 무결성을 확인할 수 없습니다. 기존 성과 데이터는 유지됩니다." }, { status: 503, headers });
  }
}

export const GET = withAdminAccess(handleGet);
