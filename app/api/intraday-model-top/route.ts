import { withAdminAccess } from "@/lib/admin-access";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { validateIntradayModelTopSignal } from "@/lib/intraday-model-top-official-signal.mjs";
import { loadCurrentLiveUniverse } from "@/lib/current-live-universe.mjs";

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

async function handleGet(request: NextRequest) {
  const requestedModel = (request.nextUrl.searchParams.get("model") ?? "B").toUpperCase();
  if (!Object.hasOwn(MODEL_VERSIONS, requestedModel)) return NextResponse.json({ error: { code: "INVALID_MODEL", message: "model은 A, B, C, D 중 하나여야 합니다." } }, { status: 400 });
  const requestedLimit = Number(request.nextUrl.searchParams.get("limit") ?? "5");
  if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 50) return NextResponse.json({ error: { code: "INVALID_LIMIT", message: "limit은 1~50 정수여야 합니다." } }, { status: 400 });
  const profile = request.nextUrl.searchParams.get("profile") ?? "1400";
  const date = request.nextUrl.searchParams.get("date");
  if (!["1400", "1430"].includes(profile) || (date && !/^\d{4}-\d{2}-\d{2}$/u.test(date))) return NextResponse.json({ error: { message: "관측 기준 또는 날짜를 확인해 주세요." } }, { status: 400 });
  if (profile === "1400") {
    const headers = { "Cache-Control": "private, no-store" };
    try {
      const signal = await loadCurrentLiveUniverse({ signalDate: date });
      const model = requestedModel as ModelId, modelVersion = MODEL_VERSIONS[model];
      type LiveStock = { code: string; name: string; market: string; reason?: string; models: Record<string, { rank: number; score: number }>; observedDate?: string; observedTime?: string; receivedAt?: string; observationHash?: string };
      const stocks = (signal.records as LiveStock[]).filter(row => !row.reason).sort((a,b) => a.models[modelVersion].rank - b.models[modelVersion].rank).slice(0, requestedLimit)
        .map(row => ({ code: row.code, name: row.name, market: row.market, ...row.models[modelVersion], observedPrice: null,
          quoteAsOfDate: row.observedDate, quoteAsOfTime: row.observedTime, receivedAt: row.receivedAt, observationId: row.observationHash }));
      return NextResponse.json({ dataMode: "intradayOfficialSignal", archive: false, activeProducer: true, observationType: signal.observationType,
        model, modelVersion, modelName: signal.modelDefinitions[model].name, formulaHash: signal.modelDefinitions[model].formulaHash,
        signalDate: signal.signalDate, seedReferenceDate: signal.seedReferenceDate, officialSignalTime: signal.officialSignalTime,
        collectionStartedAt: signal.collectionStartedAt, collectionCompletedAt: signal.collectionCompletedAt,
        freshnessStatus: signal.signalDate < new Date(Date.now() + 9*3600000).toISOString().slice(0,10) ? "HISTORICAL" : "CURRENT_DATE",
        publishedAt: signal.publishedAt, revision: signal.revision, sourceHash: signal.sourceHash, deliveryHash: signal.deliveryHash,
        publicationStatus: signal.publicationStatus, coverage: signal.coverage, priceBasis: "notPubliclyRedistributed",
        transitionInputsRetained: signal.transitionInputsRetained,
        rankingUniverse: { count: signal.coverage.validCount, tieBreak: "scoreDescThenTickerAsc" }, count: stocks.length, stocks }, { headers });
    } catch (error) {
      if (error instanceof Error && (error.message === "LIVE_GLOBAL_BLOCKED" || error.message === "LIVE_PUBLICATION_WITHHELD")) {
        return NextResponse.json({ error: { code: error.message, message: error.message === "LIVE_GLOBAL_BLOCKED" ? "전체 관측 검증 오류로 새 LIVE 순위 게시가 차단되었습니다." : "필수 종목 5개 이상이 미반영되어 오늘 순위 게시를 보류했습니다." },
          coverage: "coverage" in error ? error.coverage : undefined }, { status: 503, headers });
      }
      return NextResponse.json({ error: { code: "INTRADAY_OFFICIAL_SIGNAL_UNAVAILABLE", message: "검증된 14:00 LIVE 전체 순위를 확인할 수 없습니다." } }, { status: 503, headers });
    }
  }
  try {
    const signalPath = await resolveSignalPath(date);
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
    return NextResponse.json({ dataMode: "intradayOfficialSignal", archive: true, activeProducer: false, currentResultsEndpoint: "/api/private-live-delivery", observationType: signal.observationType, signalDate: signal.signalDate, officialSignalTime: signal.officialSignalTime, model, modelVersion, modelName: definition?.name ?? null, formulaHash: definition?.formulaHash ?? null, seedReferenceDate: signal.seedReferenceDate, collectionStartedAt: signal.collectionStartedAt, collectionCompletedAt: signal.collectionCompletedAt, priceBasis: "kisLastQuoteAtCollection", rankingUniverse: signal.rankingUniverse[modelVersion], signalPath, count: stocks.length, stocks, source: signal.source }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const reason = error instanceof Error && /^(?:INVALID_DATE|INVALID_SIGNAL_PATH|OFFICIAL_SIGNAL_NOT_READY|OFFICIAL_SIGNAL_INVALID)/u.test(error.message)
      ? error.message
      : "OFFICIAL_SIGNAL_NOT_AVAILABLE";
    return NextResponse.json({ error: { code: "INTRADAY_OFFICIAL_SIGNAL_UNAVAILABLE", message: "14:30 공식 신호를 사용할 수 없습니다.", reason } }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}

export const GET = withAdminAccess(handleGet);
