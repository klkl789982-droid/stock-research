import { NextRequest, NextResponse } from "next/server";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const query = searchParams.get("query");

  if (!query) {
    return NextResponse.json(
      { error: "검색어가 필요합니다." },
      { status: 400 }
    );
  }
  const normalizedQuery = query.trim().toUpperCase();

  const serviceKey = process.env.DATA_GO_KR_SERVICE_KEY;

  if (!serviceKey) {
    return NextResponse.json(
      { error: "API 인증키가 설정되지 않았습니다." },
      { status: 500 }
    );
  }

  const apiUrl =
    "https://apis.data.go.kr/1160100/service/GetKrxListedInfoService/getItemInfo";

  const url =
    `${apiUrl}?serviceKey=${serviceKey}` +
    `&pageNo=1` +
    `&numOfRows=20` +
    `&resultType=json` +
    `&likeItmsNm=${encodeURIComponent(normalizedQuery)}`;

  try {
    const response = await fetch(url, {
      cache: "no-store",
    });

    if (!response.ok) {
      return NextResponse.json(
        { error: "공공데이터 API 호출에 실패했습니다." },
        { status: response.status }
      );
    }

    const data = await response.json();

    const items = data?.response?.body?.items?.item ?? [];

    return NextResponse.json({
      query,
      items,
    });
  } catch (error) {
    console.error(error);

    return NextResponse.json(
      { error: "API 처리 중 오류가 발생했습니다." },
      { status: 500 }
    );
  }
}