import { withAdminAccess } from "@/lib/admin-access";
import { NextRequest, NextResponse } from "next/server";

import { officialPricePage } from "@/lib/official-price-page.mjs";
import { candleWindow } from "@/lib/daily-candles.mjs";
import calendar from "@/data/trading-calendar/status.json";

async function handleGet(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  if (!code || !/^[0-9A-Z]{6}$/.test(code)) return NextResponse.json({ error: "유효한 종목코드가 필요합니다." }, { status: 400 });
  const serviceKey = process.env.DATA_GO_KR_SERVICE_KEY;
  if (!serviceKey) return NextResponse.json({ error: "API 인증키가 설정되지 않았습니다." }, { status: 500 });
  try {
    const page=await officialPricePage(code,1,serviceKey);
    const belongs=(r:Record<string, unknown>)=>String(r.srtnCd??"").replace(/^A(?=.{6}$)/,"")===code;
    const chartRows=page.rows.filter(belongs);
    let fetched=page.rows.length,failedPages=0;
    for(let i=2;i<=3 && fetched<page.total && new Set(chartRows.map((r:Record<string,unknown>)=>r.basDt)).size<50;i++){
      try{const extra=await officialPricePage(code,i,serviceKey);if(!extra.rows.length)break;chartRows.push(...extra.rows.filter(belongs));fetched+=extra.rows.length;}
      catch{failedPages++;break;}
    }
    const through=new Date(Date.parse(page.receivedAt)+9*3600000).toISOString().slice(0,10);
    const candles=candleWindow(chartRows.map((r:Record<string,unknown>)=>({date:r.basDt,open:r.mkp,high:r.hipr,low:r.lopr,close:r.clpr,noTrade:r.trqu!=null&&Number(r.trqu)===0})),{through,calendar,receivedAt:page.receivedAt,failedPages});
    const items = page.rows
      .filter((item:Record<string,string>) => belongs(item))
      .filter((item:Record<string,string>) => /^\d{8}$/.test(String(item.basDt ?? "")) && Number.isFinite(Number(item.clpr)) && Number(item.clpr) > 0)
      .sort((left:Record<string,string>, right:Record<string,string>) => String(right.basDt).localeCompare(String(left.basDt)));
    if (items.length === 0) return NextResponse.json({ error: "유효한 공식 일봉 데이터가 없습니다." }, { status: 404 });
    const latest = items[0];
    const asOfDate = `${latest.basDt.slice(0, 4)}-${latest.basDt.slice(4, 6)}-${latest.basDt.slice(6, 8)}`;
    return NextResponse.json({ code, candles, source: "officialDailyPrice", priceBasis: "officialDailyClose", asOfDate, closePrice: Number(latest.clpr), items }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "공식 일봉을 조회하지 못했습니다." }, {status:502});
  }
}

export const GET = withAdminAccess(handleGet);
