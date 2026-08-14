import { NextRequest, NextResponse } from "next/server";
async function getAccessToken() {
  const response = await fetch(
    "https://openapi.koreainvestment.com:9443/oauth2/tokenP",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        grant_type: "client_credentials",
        appkey: process.env.KIS_APP_KEY,
        appsecret: process.env.KIS_APP_SECRET,
      }),
    }
  );

  const data = await response.json();

  return data.access_token;
}
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");

  if (!code) {
    return NextResponse.json(
      { error: "종목코드가 필요합니다." },
      { status: 400 }
    );
  }
  const token = await getAccessToken();

console.log("조회 종목:", code);
const apiUrl =
  "https://openapi.koreainvestment.com:9443/uapi/domestic-stock/v1/quotations/investor-trend-estimate" +
  `?MKSC_SHRN_ISCD=${code}`;

const response = await fetch(apiUrl, {
  headers: {
    "Content-Type": "application/json",
    authorization: `Bearer ${token}`,
    appkey: process.env.KIS_APP_KEY!,
    appsecret: process.env.KIS_APP_SECRET!,
    tr_id: "HHPTJ04160200",
  },
});

const data = await response.json();

const latest = data.output2?.[0];

return NextResponse.json({
  foreignNetBuyQty: Number(
    latest?.frgn_fake_ntby_qty ?? 0
  ),
  institutionNetBuyQty: Number(
    latest?.orgn_fake_ntby_qty ?? 0
  ),
  totalNetBuyQty: Number(
    latest?.sum_fake_ntby_qty ?? 0
  ),
});
}