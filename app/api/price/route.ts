import { NextRequest, NextResponse } from "next/server";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");

  if (!code) {
    return NextResponse.json(
      { error: "종목코드가 필요합니다." },
      { status: 400 }
    );
  }

  const serviceKey = process.env.DATA_GO_KR_SERVICE_KEY;

  if (!serviceKey) {
    return NextResponse.json(
      { error: "API 인증키가 설정되지 않았습니다." },
      { status: 500 }
    );
  }

  const apiUrl =
    "https://apis.data.go.kr/1160100/service/GetStockSecuritiesInfoService/getStockPriceInfo";

  const url =
    `${apiUrl}?serviceKey=${serviceKey}` +
    `&pageNo=1` +
    `&numOfRows=260` +
    `&resultType=json` +
    `&likeSrtnCd=${encodeURIComponent(code)}`;

  try {
    const response = await fetch(url, {
      cache: "no-store",
    });

    if (!response.ok) {
      return NextResponse.json(
        { error: "주식시세 API 호출에 실패했습니다." },
        { status: response.status }
      );
    }

    const data = await response.json();

    const items = data?.response?.body?.items?.item ?? [];
console.log("최근 가격 데이터:", items.slice(0, 5));
    return NextResponse.json({
      code,
      items,
    });
  } catch (error) {
  console.error("PRICE API 실제 오류:", error);

  return NextResponse.json(
    {
      error: "주식시세 처리 중 오류가 발생했습니다.",
      detail:
        error instanceof Error
          ? error.message
          : String(error),
    },
    { status: 500 }
  );
}
}