import { NextResponse } from "next/server";
import { loadModelPerformanceResearch } from "@/lib/model-performance-research-store.mjs";
import { validateResearchOptions } from "@/lib/model-performance-research.mjs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const headers = { "Cache-Control": "no-store" };

export async function GET(request: Request) {
  const query = new URL(request.url).searchParams;
  let options;
  try {
    const numberInput = (key: string) => { const value = query.get(key); return value == null || !value.trim() ? NaN : Number(value); };
    const mode = query.get("costMode") ?? "GROSS_ONLY";
    const cost = mode === "USER_INPUT" ? {
      mode, buyFeeBps: numberInput("buyFeeBps"), sellFeeBps: numberInput("sellFeeBps"), sellTaxBps: numberInput("sellTaxBps"),
      buySlippageBps: numberInput("buySlippageBps"), sellSlippageBps: numberInput("sellSlippageBps"), basisDate: query.get("basisDate"), basis: query.get("basis"),
    } : { mode };
    options = validateResearchOptions({ ...(query.has("models") ? { models: query.get("models")!.split(",") } : {}),
      topN: Number(query.get("topN") ?? 10), horizon: query.get("horizon") ?? "H1", market: query.get("market") ?? "ALL", classification: query.get("classification") ?? "AS_PUBLISHED",
      benchmark: query.get("benchmark") ?? "MATCHED_MARKET", from: query.get("from") || null, to: query.get("to") || null, cost });
  } catch {
    return NextResponse.json({ status: "INVALID_RESEARCH_FILTER", message: "모델·기간·비용 입력을 확인하세요." }, { status: 400, headers });
  }
  try {
    const result = await loadModelPerformanceResearch({ options });
    // Derived statistics only. Entry/exit/reference raw prices are not returned by this public route.
    const cohorts = result.cohorts.map((cohort: { rows: Array<Record<string, unknown>> }) => ({ ...cohort, rows: cohort.rows.map(({ referencePrice: _price, ...row }) => { void _price; return row; }) }));
    return NextResponse.json({ ...result, cohorts }, { headers });
  } catch {
    return NextResponse.json({ status: "RESEARCH_DATA_UNAVAILABLE", message: "공식 연구 입력의 무결성을 확인할 수 없습니다. 기존 성과 데이터는 유지됩니다." }, { status: 503, headers });
  }
}
