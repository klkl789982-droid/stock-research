import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { validateIntradayModelTopSignal } from "@/lib/intraday-model-top-official-signal.mjs";

const MODEL_VERSIONS = { A: "A-v1", B: "B-v1", C: "C-v1", D: "D-v1" } as const;
type ModelId = keyof typeof MODEL_VERSIONS;
type SignalRecord = { ticker: string; companyName: string; market: string | null; dataStatus: string; scores: Record<string, number | null>; ranks: Record<string, number | null>; observationIds: Record<string, string>; quote?: { asOfDate?: string; asOfTime?: string; receivedAt?: string }; provisionalOhlcv?: { close?: number } };
type Signal = { signalDate: string; officialSignalTime: string; status: string; signalVersion: string; observationType: "LIVE_OBSERVATION"; seedReferenceDate: string; collectionStartedAt: string; collectionCompletedAt: string; modelDefinitions: Record<string, { modelVersion: string; name: string; formulaHash: string }>; rankingUniverse: Record<string, { count: number; codesHash: string; tieBreak: string }>; source: unknown; records: SignalRecord[] };

async function resolveSignalPath(requestedDate: string | null) {
  if (requestedDate) {
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(requestedDate)) throw new Error("INVALID_DATE");
    return `data/intraday-signals/model-top/${requestedDate}/1430.json`;
  }
  const latest = JSON.parse(await readFile(path.join(process.cwd(), "data", "intraday-signals", "model-top", "latest.json"), "utf8")) as { status?: string; signalPath?: string; reason?: string };
  if (latest.status !== "READY" || typeof latest.signalPath !== "string") throw new Error(latest.reason ?? "OFFICIAL_SIGNAL_NOT_READY");
  if (!/^data\/intraday-signals\/model-top\/\d{4}-\d{2}-\d{2}\/1430\.json$/u.test(latest.signalPath)) throw new Error("INVALID_SIGNAL_PATH");
  return latest.signalPath;
}

function resolveSignalFilePath(signalPath: string) {
  const match = /^data\/intraday-signals\/model-top\/(\d{4}-\d{2}-\d{2})\/1430\.json$/u.exec(signalPath);
  if (!match) throw new Error("INVALID_SIGNAL_PATH");
  return path.join(process.cwd(), "data", "intraday-signals", "model-top", match[1], "1430.json");
}

export async function GET(request: NextRequest) {
  const requestedModel = (request.nextUrl.searchParams.get("model") ?? "B").toUpperCase();
  if (!(requestedModel in MODEL_VERSIONS)) return NextResponse.json({ error: { code: "INVALID_MODEL", message: "model은 A, B, C, D 중 하나여야 합니다." } }, { status: 400 });
  const requestedLimit = Number(request.nextUrl.searchParams.get("limit") ?? "5");
  if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 50) return NextResponse.json({ error: { code: "INVALID_LIMIT", message: "limit은 1~50 정수여야 합니다." } }, { status: 400 });
  try {
    const signalPath = await resolveSignalPath(request.nextUrl.searchParams.get("date"));
    const signal = JSON.parse(await readFile(resolveSignalFilePath(signalPath), "utf8")) as Signal;
    const errors = validateIntradayModelTopSignal(signal);
    if (errors.length || signal.status !== "READY" || signal.observationType !== "LIVE_OBSERVATION") throw new Error(`OFFICIAL_SIGNAL_INVALID:${errors.join(",")}`);
    const model = requestedModel as ModelId;
    const modelVersion = MODEL_VERSIONS[model];
    const definition = signal.modelDefinitions[model];
    const stocks = signal.records
      .filter((record) => record.dataStatus === "AVAILABLE" && Number.isInteger(record.ranks[modelVersion]) && Number.isFinite(record.scores[modelVersion]))
      .sort((left, right) => Number(left.ranks[modelVersion]) - Number(right.ranks[modelVersion]))
      .slice(0, requestedLimit)
      .map((record) => ({ rank: record.ranks[modelVersion], code: record.ticker, name: record.companyName, market: record.market, score: record.scores[modelVersion], observedPrice: record.provisionalOhlcv?.close ?? null, quoteAsOfDate: record.quote?.asOfDate ?? null, quoteAsOfTime: record.quote?.asOfTime ?? null, receivedAt: record.quote?.receivedAt ?? null, observationId: record.observationIds[modelVersion] }));
    return NextResponse.json({ dataMode: "intradayOfficialSignal", observationType: signal.observationType, signalDate: signal.signalDate, officialSignalTime: signal.officialSignalTime, model, modelVersion, modelName: definition?.name ?? null, formulaHash: definition?.formulaHash ?? null, seedReferenceDate: signal.seedReferenceDate, collectionStartedAt: signal.collectionStartedAt, collectionCompletedAt: signal.collectionCompletedAt, priceBasis: "kisLastQuoteAtCollection", rankingUniverse: signal.rankingUniverse[modelVersion], signalPath, count: stocks.length, stocks, source: signal.source }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const reason = error instanceof Error && /^(?:INVALID_DATE|INVALID_SIGNAL_PATH|OFFICIAL_SIGNAL_NOT_READY|OFFICIAL_SIGNAL_INVALID)/u.test(error.message)
      ? error.message
      : "OFFICIAL_SIGNAL_NOT_AVAILABLE";
    return NextResponse.json({ error: { code: "INTRADAY_OFFICIAL_SIGNAL_UNAVAILABLE", message: "14:30 공식 신호를 사용할 수 없습니다.", reason } }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
