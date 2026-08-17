import { NextRequest, NextResponse } from "next/server";
import { classifyKisHttpStatus, kisRequest, safeKisError } from "@/lib/kis-token-manager";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");

  if (!code || !/^[0-9A-Z]{6}$/.test(code)) {
    return NextResponse.json(
      { error: "종목코드가 필요합니다." },
      { status: 400 }
    );
  }
  try {
    const apiUrl = "https://openapi.koreainvestment.com:9443/uapi/domestic-stock/v1/quotations/investor-trend-estimate" + `?MKSC_SHRN_ISCD=${code}`;
    const response = await kisRequest(apiUrl, { headers: { "Content-Type": "application/json", tr_id: "HHPTJ04160200" } });
    if (!response.ok) {
      const safe = classifyKisHttpStatus(response.status);
      return NextResponse.json({ error: { code: safe.code, message: safe.message } }, { status: safe.httpStatus });
    }
    const data = await response.json();
    if (data.rt_cd !== "0" || !Array.isArray(data.output2) || !data.output2[0]) {
      return NextResponse.json({ error: { code: "KIS_INVESTOR_DATA_UNAVAILABLE", message: "KIS 투자자 수급 데이터가 없습니다." } }, { status: 502 });
    }
    const latest = data.output2[0];
    const foreignNetBuyQty = Number(latest.frgn_fake_ntby_qty);
    const institutionNetBuyQty = Number(latest.orgn_fake_ntby_qty);
    const totalNetBuyQty = Number(latest.sum_fake_ntby_qty);
    if (![foreignNetBuyQty, institutionNetBuyQty, totalNetBuyQty].every(Number.isFinite)) {
      return NextResponse.json({ error: { code: "KIS_INVESTOR_DATA_INVALID", message: "KIS 투자자 수급 데이터가 올바르지 않습니다." } }, { status: 502 });
    }
    return NextResponse.json({ code, source: "KIS", foreignNetBuyQty, institutionNetBuyQty, totalNetBuyQty });
  } catch (error) {
    const safe = safeKisError(error);
    console.error("KIS 수급 처리 오류 코드:", safe.code);
    return NextResponse.json({ error: { code: safe.code, message: safe.message } }, { status: safe.httpStatus });
  }
}
