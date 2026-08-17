import { NextResponse } from "next/server";
import { classifyKisHttpStatus, kisRequest, safeKisError } from "@/lib/kis-token-manager";

const formatDate = (value: unknown) => typeof value === "string" && /^\d{8}$/.test(value)
  ? `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}` : null;
const formatTime = (value: unknown) => typeof value === "string" && /^\d{6}$/.test(value)
  ? `${value.slice(0, 2)}:${value.slice(2, 4)}:${value.slice(4, 6)}` : null;

export async function GET(request: Request) {
  const code = new URL(request.url).searchParams.get("code");
  if (!code || !/^[0-9A-Z]{6}$/.test(code)) return NextResponse.json({ error: "유효한 종목 코드가 필요합니다." }, { status: 400 });
  try {
    const response = await kisRequest(`https://openapi.koreainvestment.com:9443/uapi/domestic-stock/v1/quotations/inquire-price?FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD=${code}`, {
      headers: { "Content-Type": "application/json", tr_id: "FHKST01010100" },
    });
    if (!response.ok) {
      const safe = classifyKisHttpStatus(response.status);
      return NextResponse.json({ error: { code: safe.code, message: safe.message } }, { status: safe.httpStatus });
    }
    const data = await response.json();
    if (data.rt_cd !== "0" || !data.output) return NextResponse.json({ error: { code: "KIS_BUSINESS_ERROR", message: "KIS 시세 응답이 올바르지 않습니다." } }, { status: 502 });
    const output = data.output as Record<string, unknown>;
    const responseCode = typeof output.stck_shrn_iscd === "string" ? output.stck_shrn_iscd : null;
    if (responseCode && responseCode !== code) return NextResponse.json({ error: { code: "KIS_SYMBOL_MISMATCH", message: "KIS 응답 종목코드가 요청과 일치하지 않습니다." } }, { status: 502 });
    const price = Number(output.stck_prpr);
    if (!Number.isFinite(price) || price <= 0) return NextResponse.json({ error: { code: "KIS_INVALID_QUOTE", message: "KIS 현재 조회가가 유효하지 않습니다." } }, { status: 502 });
    const change = Number(output.prdy_vrss);
    const rate = Number(output.prdy_ctrt);
    const volume = Number(output.acml_vol);
    const high = Number(output.stck_hgpr);
    const low = Number(output.stck_lwpr);
    if (![change, rate, volume, high, low].every(Number.isFinite)) {
      return NextResponse.json({ error: { code: "KIS_INVALID_QUOTE", message: "KIS 부가 시세 데이터가 유효하지 않습니다." } }, { status: 502 });
    }
    const seoulDay = new Date(Date.now() + 9 * 60 * 60 * 1000).getUTCDay();
    const marketStatus = seoulDay === 0 || seoulDay === 6 ? "closed" : "unknown";

    return NextResponse.json({
      code,
      source: "KIS",
      priceBasis: "lastQuotedPrice",
      price,
      change,
      rate,
      volume,
      high,
      low,
      asOfDate: formatDate(output.stck_bsop_date),
      asOfTime: formatTime(output.stck_cntg_hour),
      responseAt: new Date().toISOString(),
      marketStatus,
      isRealtime: false,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const safe = safeKisError(error);
    console.error("KIS 시세 처리 오류 코드:", safe.code);
    return NextResponse.json({ error: { code: safe.code, message: safe.message } }, { status: safe.httpStatus });
  }
}
