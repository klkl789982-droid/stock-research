import { NextResponse } from "next/server";

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


export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);

  const code = searchParams.get("code");

  if (!code) {
    return NextResponse.json(
      { error: "종목 코드가 없습니다." },
      { status: 400 }
    );
  }

  const token = await getAccessToken();

  const response = await fetch(
    `https://openapi.koreainvestment.com:9443/uapi/domestic-stock/v1/quotations/inquire-price?FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD=${code}`,
    {
      headers: {
        "Content-Type": "application/json",
        authorization: `Bearer ${token}`,
        appkey: process.env.KIS_APP_KEY!,
        appsecret: process.env.KIS_APP_SECRET!,
        tr_id: "FHKST01010100",
      },
    }
  );

  const data = await response.json();

  return NextResponse.json({
  price: Number(data.output.stck_prpr),
  change: Number(data.output.prdy_vrss),
  rate: Number(data.output.prdy_ctrt),
  volume: Number(data.output.acml_vol),
  high: Number(data.output.stck_hgpr),
  low: Number(data.output.stck_lwpr),
});

}