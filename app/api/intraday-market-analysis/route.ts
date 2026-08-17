import "server-only";
import { promises as fs } from "node:fs";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { getKisQuote } from "@/lib/kis-quote-provider";
import { calculateIntradayMarketAnalysis, INTRADAY_MARKET_ANALYSIS_VERSION } from "@/lib/intraday-market-analysis-v1.mjs";
import { evaluateIntradaySession } from "@/lib/intraday-session-policy.mjs";

const codeOf = (value: string | null) => {
  if (!value) return null;
  const code = (value.startsWith("A") && value.length === 7 ? value.slice(1) : value).toUpperCase();
  return /^[0-9A-Z]{6}$/.test(code) ? code : null;
};

type BlockedInput = {
  official: { asOfDate: string; finalTechnicalScore: number | null } | null;
  quote: { asOfDate?: string | null; asOfTime?: string | null; receivedAt?: string | null; source?: string } | null;
  marketStatusEvidence: unknown;
};

const createBlockedResult = (reasons: string[], input: BlockedInput) => ({
  calculatorVersion: INTRADAY_MARKET_ANALYSIS_VERSION,
  displayOnly: true,
  eligibleForRanking: false,
  eligibleForBacktest: false,
  eligibleForOptimization: false,
  officialBaseAsOfDate: input.official?.asOfDate ?? null,
  quoteAsOfDate: input.quote?.asOfDate ?? null,
  quoteAsOfTime: input.quote?.asOfTime ?? null,
  receivedAt: input.quote?.receivedAt ?? null,
  marketStatusEvidence: input.marketStatusEvidence ?? null,
  quoteSource: input.quote?.source ?? "KIS",
  priceBasis: "kisLastQuotedIntradayObservation",
  qualityStatus: "BLOCKED",
  blockingReasons: [...new Set(reasons)],
  finalTechnicalScore: null,
  officialFinalTechnicalScore: input.official?.finalTechnicalScore ?? null,
  scoreDifference: null,
});

export async function GET(request: NextRequest) {
  const code = codeOf(request.nextUrl.searchParams.get("code"));
  if (!code) return NextResponse.json({ status: "blocked", blockingReasons: ["invalidCode"] }, { status: 400 });
  const root = process.cwd();
  let officialSnapshot = null;
  let seed = null;
  let quote = null;
  const resourceBlockingReasons: string[] = [];
  try {
    const marketDir = path.join(root, "data", "analysis", "market");
    const names = (await fs.readdir(marketDir)).filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name)).sort().reverse();
    if (!names[0]) resourceBlockingReasons.push("officialSnapshotMissing");
    else officialSnapshot = JSON.parse(await fs.readFile(path.join(marketDir, names[0]), "utf8"));
  } catch { resourceBlockingReasons.push("officialSnapshotMissing"); }
  if (officialSnapshot) {
    try { seed = JSON.parse(await fs.readFile(path.join(root, "data", "analysis", "market-seeds", `${officialSnapshot.requestedDate}.json`), "utf8")); }
    catch { resourceBlockingReasons.push("seedMissing"); }
  }
  try { quote = await getKisQuote(code); }
  catch { resourceBlockingReasons.push("kisQuoteFailed"); }

  let calendarRecord = null;
  if (quote?.asOfDate) {
    try {
      const calendar = JSON.parse(await fs.readFile(path.join(root, "data", "trading-calendar", "status.json"), "utf8"));
      calendarRecord = calendar.dates?.[quote.asOfDate] ?? { status: "unchecked" };
    } catch { calendarRecord = { status: "unchecked" }; }
  }
  const policy = JSON.parse(await fs.readFile(path.join(root, "config", "intraday-session-policy.json"), "utf8"));
  const official = officialSnapshot?.records?.find((record: { code?: string }) => record.code === code);
  const seedRecord = seed?.records?.find((record: { code?: string }) => record.code === code);
  if (official && seedRecord) {
    const sourceHash = officialSnapshot.sourceManifest?.sources?.officialDailyPrice?.normalizedInputHash;
    if (seedRecord.sourceHash !== sourceHash) resourceBlockingReasons.push("sourceHashMismatch");
    if (seedRecord.formulaHash !== officialSnapshot.formulaHash) resourceBlockingReasons.push("formulaHashMismatch");
    if (seedRecord.officialAsOfDate !== official.asOfDate) resourceBlockingReasons.push("seedOfficialDateMismatch");
  }
  const session = evaluateIntradaySession({ requestedDate: quote?.asOfDate ?? null, quote, calendarRecord, resourceBlockingReasons }, policy);
  const input = {
    requestedDate: quote?.asOfDate ?? null,
    quote,
    calendarStatus: calendarRecord?.status ?? "unchecked",
    marketSessionVerified: session.allowed,
    marketStatusEvidence: session,
    official: official ? {
      asOfDate: official.asOfDate,
      sourceHash: officialSnapshot.sourceManifest?.sources?.officialDailyPrice?.normalizedInputHash,
      formulaHash: officialSnapshot.formulaHash,
      finalTechnicalScore: official.finalTechnicalScore,
    } : null,
    seedMeta: seed ? { seedVersion: seed.seedVersion } : null,
    seedRecord,
  };
  const result = session.allowed ? calculateIntradayMarketAnalysis(input) : createBlockedResult(session.blockingReasons, input);
  return NextResponse.json({
    status: result.blockingReasons.length ? "blocked" : "provisional",
    session,
    quote: quote ? { ...quote, quoteAgeSeconds: session.quoteAgeSeconds, freshnessStatus: session.allowed ? "fresh" : "blocked", sessionEvidence: session.evidenceType, marketStatus: "unknown", isRealtime: false } : null,
    intradayAnalysis: result,
    officialReference: official ? { asOfDate: official.asOfDate, calculatorVersion: officialSnapshot.calculatorVersion, finalTechnicalScore: official.finalTechnicalScore } : null,
  }, { headers: { "Cache-Control": "no-store" } });
}
