import { NextRequest, NextResponse } from "next/server";

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  if (!code || !/^[0-9A-Z]{6}$/.test(code)) return NextResponse.json({ error: "유효한 종목코드가 필요합니다." }, { status: 400 });
  const serviceKey = process.env.DATA_GO_KR_SERVICE_KEY;
  if (!serviceKey) return NextResponse.json({ error: "API 인증키가 설정되지 않았습니다." }, { status: 500 });
  const query = new URLSearchParams({ pageNo: "1", numOfRows: "260", resultType: "json", likeSrtnCd: code });
  try {
    const response = await fetch(`https://apis.data.go.kr/1160100/service/GetStockSecuritiesInfoService/getStockPriceInfo?serviceKey=${serviceKey}&${query}`, { cache: "no-store" });
    if (!response.ok) return NextResponse.json({ error: `공식 일봉 API HTTP ${response.status}` }, { status: 502 });
    const data = await response.json();
    if (data?.response?.header?.resultCode !== "00") return NextResponse.json({ error: data?.response?.header?.resultMsg ?? "공식 일봉 응답이 올바르지 않습니다." }, { status: 502 });
    const raw = data?.response?.body?.items?.item;
    const items = (Array.isArray(raw) ? raw : raw ? [raw] : [])
      .filter((item) => String(item.srtnCd ?? "").replace(/^A/, "") === code)
      .filter((item) => /^\d{8}$/.test(String(item.basDt ?? "")) && Number.isFinite(Number(item.clpr)) && Number(item.clpr) > 0)
      .sort((left, right) => String(right.basDt).localeCompare(String(left.basDt)));
    if (items.length === 0) return NextResponse.json({ error: "유효한 공식 일봉 데이터가 없습니다." }, { status: 404 });
    const latest = items[0];
    const asOfDate = `${latest.basDt.slice(0, 4)}-${latest.basDt.slice(4, 6)}-${latest.basDt.slice(6, 8)}`;
    return NextResponse.json({ code, source: "officialDailyPrice", priceBasis: "officialDailyClose", asOfDate, closePrice: Number(latest.clpr), items }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("공식 일봉 처리 오류:", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "공식 일봉 처리 중 오류가 발생했습니다." }, { status: 502 });
  }
}
