import { NextResponse } from "next/server";
import { getKisQuote } from "@/lib/kis-quote-provider";
import { safeKisError } from "@/lib/kis-token-manager";

export async function GET(request: Request) {
  const code = new URL(request.url).searchParams.get("code");
  if (!code || !/^[0-9A-Z]{6}$/.test(code)) return NextResponse.json({ error: "유효한 종목 코드가 필요합니다." }, { status: 400 });
  try {
    const quote=await getKisQuote(code);
    const quoteTimestamp = quote.asOfDate && quote.asOfTime ? Date.parse(`${quote.asOfDate}T${quote.asOfTime}+09:00`) : NaN;
    const quoteAgeSeconds = Number.isFinite(quoteTimestamp) ? (Date.parse(quote.receivedAt) - quoteTimestamp) / 1000 : null;
    return NextResponse.json({ ...quote, quoteAsOfDate: quote.asOfDate, quoteAsOfTime: quote.asOfTime, responseAt: quote.receivedAt, quoteAgeSeconds, freshnessStatus: quoteAgeSeconds != null && quoteAgeSeconds >= 0 && quoteAgeSeconds <= 60 ? "freshObservation" : "unverified", sessionEvidence: "notEvaluated", marketStatus: "unknown", isRealtime: false }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const safe = safeKisError(error);
    console.error("KIS 시세 처리 오류 코드:", safe.code);
    return NextResponse.json({ error: { code: safe.code, message: safe.message } }, { status: safe.httpStatus });
  }
}
