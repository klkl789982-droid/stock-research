import { withAdminAccess } from "@/lib/admin-access";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { isCurrentIntradayModelTopSignal, validateIntradayModelTopSignal } from "@/lib/intraday-model-top-official-signal.mjs";
import { CURRENT_LIVE_PROFILE, LEGACY_LIVE_PROFILE, LIVE_INPUT_WAIT_REASONS } from "@/lib/intraday-model-top-time-policy.mjs";
import { validateLiveTransitionFreshness } from "@/lib/live-transition-screener.mjs";

const MODEL_VERSIONS = { A: "A-v1", B: "B-v1", C: "C-v1", D: "D-v1" } as const;
type ModelId = keyof typeof MODEL_VERSIONS;
type SignalRecord = { ticker: string; companyName: string; market: string | null; dataStatus: string; scores: Record<string, number | null>; ranks: Record<string, number | null>; observationIds: Record<string, string>; quote?: { asOfDate?: string; asOfTime?: string; receivedAt?: string }; provisionalOhlcv?: { close?: number } };
type Signal = { schemaVersion: number; signalDate: string; officialSignalTime: string; status: string; signalVersion: string; observationPolicyId?: string; contentHash: string; observationType: "LIVE_OBSERVATION"; seedReferenceDate: string; collectionStartedAt: string; collectionCompletedAt: string; modelDefinitions: Record<string, { modelVersion: string; name: string; formulaHash: string }>; rankingUniverse: Record<string, { count: number; codesHash: string; tieBreak: string }>; source: unknown; records: SignalRecord[] };
type Latest = { reason?: string; failureStage?: string; lastGood?: { signalDate?: string; signalPath?: string; observationPolicyId?: string; officialSignalTime?: string }; schemaVersion?: number; status?: string; signalDate?: string; officialSignalTime?: string; observationPolicyId?: string; signalPath?: string; contentHash?: string };
type CurrentAttempt = { observationPolicyId: string; officialSignalTime: string; attemptDate: string | null; failureStageLabel: string | null; lastGoodDate: string | null };
const FAILURE_STAGE_LABELS: Record<string, string> = { calendar: "거래일 검증", collection: "수집", calculation: "모델 계산", validation: "검증", storage: "저장", publication: "게시" };
const INPUT_WAIT_REASONS: readonly string[] = LIVE_INPUT_WAIT_REASONS;
const validDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/u.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

function currentAttempt(value: Latest): CurrentAttempt | null {
  if (!["READY", "FAILED", "FAILED_COLLECTION", "WAITING", "MARKET_CLOSED"].includes(value.status ?? "")) return null;
  const lastGood = value.lastGood;
  const lastGoodDate = typeof lastGood?.signalDate === "string" && validDate(lastGood.signalDate)
    && lastGood.observationPolicyId === CURRENT_LIVE_PROFILE.policyId && lastGood.officialSignalTime === CURRENT_LIVE_PROFILE.signalTime
    && lastGood.signalPath === `data/intraday-signals/model-top/${lastGood.signalDate}/${CURRENT_LIVE_PROFILE.slot}.json` ? lastGood.signalDate : null;
  return { observationPolicyId: CURRENT_LIVE_PROFILE.policyId, officialSignalTime: CURRENT_LIVE_PROFILE.signalTime,
    attemptDate: typeof value.signalDate === "string" && validDate(value.signalDate) ? value.signalDate : null,
    failureStageLabel: typeof value.failureStage === "string" && Object.hasOwn(FAILURE_STAGE_LABELS, value.failureStage) ? FAILURE_STAGE_LABELS[value.failureStage] : null, lastGoodDate };
}

async function resolveSignal(requestedDate: string | null, slot: string, onAttempt: (attempt: CurrentAttempt | null) => void) {
  if (requestedDate) return { signalPath: `data/intraday-signals/model-top/${requestedDate}/${slot}.json`, latest: null };
  const latest = JSON.parse(await readFile(path.join(process.cwd(), "data", "intraday-signals", "model-top", "latest.json"), "utf8")) as Latest;
  if (latest.schemaVersion !== CURRENT_LIVE_PROFILE.schemaVersion || latest.officialSignalTime !== CURRENT_LIVE_PROFILE.signalTime || latest.observationPolicyId !== CURRENT_LIVE_PROFILE.policyId) throw new Error("OFFICIAL_SIGNAL_NOT_READY");
  onAttempt(currentAttempt(latest));
  if (latest.status === "WAITING" && typeof latest.reason === "string" && INPUT_WAIT_REASONS.includes(latest.reason)) throw new Error(latest.reason);
  if (latest.status !== "READY" || typeof latest.signalDate !== "string" || !validDate(latest.signalDate)) throw new Error("OFFICIAL_SIGNAL_NOT_READY");
  if (latest.signalPath !== `data/intraday-signals/model-top/${latest.signalDate}/${CURRENT_LIVE_PROFILE.slot}.json`) throw new Error("INVALID_SIGNAL_PATH");
  return { signalPath: latest.signalPath, latest };
}

function resolveSignalFilePath(signalPath: string) {
  const match = /^data\/intraday-signals\/model-top\/(\d{4}-\d{2}-\d{2})\/(1400|1430)\.json$/u.exec(signalPath);
  if (!match || !validDate(match[1])) throw new Error("INVALID_SIGNAL_PATH");
  return path.join(process.cwd(), "data", "intraday-signals", "model-top", match[1], `${match[2]}.json`);
}

async function handleGet(request: NextRequest) {
  const requestedModel = (request.nextUrl.searchParams.get("model") ?? "B").toUpperCase();
  if (!Object.hasOwn(MODEL_VERSIONS, requestedModel)) return NextResponse.json({ error: { code: "INVALID_MODEL", message: "model은 A, B, C, D 중 하나여야 합니다." } }, { status: 400 });
  const requestedLimit = Number(request.nextUrl.searchParams.get("limit") ?? "5");
  if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 50) return NextResponse.json({ error: { code: "INVALID_LIMIT", message: "limit은 1~50 정수여야 합니다." } }, { status: 400 });
  const requestedDate = request.nextUrl.searchParams.get("date"), requestedTime = request.nextUrl.searchParams.get("time") ?? CURRENT_LIVE_PROFILE.slot;
  if (requestedDate !== null && !validDate(requestedDate)) return NextResponse.json({ error: { code: "INVALID_DATE", message: "실제 날짜를 YYYY-MM-DD 형식으로 입력해 주세요." } }, { status: 400 });
  if ((requestedTime !== CURRENT_LIVE_PROFILE.slot && requestedTime !== LEGACY_LIVE_PROFILE.slot) || (requestedTime === LEGACY_LIVE_PROFILE.slot && !requestedDate)) return NextResponse.json({ error: { code: "INVALID_SIGNAL_TIME", message: "현재 LIVE는 14:00입니다. 14:30 보존 자료는 날짜와 time=1430을 함께 지정해 주세요." } }, { status: 400 });
  const archived = requestedTime === LEGACY_LIVE_PROFILE.slot;
  let attempt: CurrentAttempt | null = null;
  try {
    const { signalPath, latest } = await resolveSignal(requestedDate, requestedTime, value => { attempt = value; });
    const signal = JSON.parse(await readFile(resolveSignalFilePath(signalPath), "utf8")) as Signal;
    if (validateIntradayModelTopSignal(signal).length || signal.status !== "READY" || signal.observationType !== "LIVE_OBSERVATION"
      || (archived ? signal.officialSignalTime !== LEGACY_LIVE_PROFILE.signalTime || signal.signalVersion !== LEGACY_LIVE_PROFILE.signalVersion : !isCurrentIntradayModelTopSignal(signal))
      || signalPath !== `data/intraday-signals/model-top/${signal.signalDate}/${requestedTime}.json`
      || (latest && (latest.signalDate !== signal.signalDate || latest.contentHash !== signal.contentHash))) throw new Error("OFFICIAL_SIGNAL_INVALID");
    if (!requestedDate) {
      const calendar = JSON.parse(await readFile(path.join(process.cwd(), "data", "trading-calendar", "status.json"), "utf8"));
      validateLiveTransitionFreshness(signal, calendar, new Date());
    }
    const model = requestedModel as ModelId, modelVersion = MODEL_VERSIONS[model], definition = signal.modelDefinitions[model];
    const stocks = signal.records
      .filter((record) => record.dataStatus === "AVAILABLE" && Number.isInteger(record.ranks[modelVersion]) && Number.isFinite(record.scores[modelVersion]))
      .sort((left, right) => Number(left.ranks[modelVersion]) - Number(right.ranks[modelVersion]))
      .slice(0, requestedLimit)
      .map((record) => ({ rank: record.ranks[modelVersion], code: record.ticker, name: record.companyName, market: record.market, score: record.scores[modelVersion], observedPrice: record.provisionalOhlcv?.close ?? null, quoteAsOfDate: record.quote?.asOfDate ?? null, quoteAsOfTime: record.quote?.asOfTime ?? null, receivedAt: record.quote?.receivedAt ?? null, observationId: record.observationIds[modelVersion] }));
    return NextResponse.json({ dataMode: archived ? "intradayArchivedSignal" : "intradayOfficialSignal", archived, observationType: signal.observationType, signalVersion: signal.signalVersion, contentHash: signal.contentHash, observationPolicyId: signal.observationPolicyId ?? null, signalDate: signal.signalDate, officialSignalTime: signal.officialSignalTime, model, modelVersion, modelName: definition?.name ?? null, formulaHash: definition?.formulaHash ?? null, seedReferenceDate: signal.seedReferenceDate, collectionStartedAt: signal.collectionStartedAt, collectionCompletedAt: signal.collectionCompletedAt, priceBasis: "kisLastQuoteAtCollection", rankingUniverse: signal.rankingUniverse[modelVersion], signalPath, count: stocks.length, stocks, source: signal.source }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const reason = error instanceof Error && (INPUT_WAIT_REASONS.includes(error.message) || /^(?:INVALID_SIGNAL_PATH|OFFICIAL_SIGNAL_NOT_READY|OFFICIAL_SIGNAL_INVALID|LIVE_SNAPSHOT_STALE|LIVE_SNAPSHOT_FUTURE|LIVE_MARKET_CLOSED|LIVE_CALENDAR_MISSING)$/u.test(error.message))
      ? error.message : "OFFICIAL_SIGNAL_NOT_AVAILABLE";
    return NextResponse.json({ error: { code: "INTRADAY_OFFICIAL_SIGNAL_UNAVAILABLE", message: archived ? "요청한 14:30 보존 신호를 사용할 수 없습니다." : INPUT_WAIT_REASONS.includes(reason) ? "직전 공식 EOD 입력 확인 대기 중입니다. 14:00 관측을 생성하지 않았습니다." : "14:00 공식 신호를 사용할 수 없습니다.", reason, currentAttempt: attempt } }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}

export const GET = withAdminAccess(handleGet);
