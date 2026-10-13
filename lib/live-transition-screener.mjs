import { buildTransitionRows, TRANSITION_PAIRS } from "./transition-screener.mjs";
import { validateIntradayModelTopSignal, hashIntradayModelTop, OFFICIAL_SIGNAL_TIME, OFFICIAL_SIGNAL_WINDOW_END } from "./intraday-model-top-official-signal.mjs";
import { isWeekend } from "./trading-calendar-status.mjs";

export const LIVE_TRANSITION_RULE_VERSION = "live-golden-transition-v1";
export const LIVE_NEAR_PERCENT_DEFAULT = 1;
export const LIVE_TRANSITION_ERRORS = Object.freeze({
  LIVE_SNAPSHOT_MISSING: "저장된 TOP LIVE 14:30 관측 자료가 없습니다.",
  LIVE_SNAPSHOT_FAILED: "최근 TOP LIVE 수집·검증이 실패해 LIVE 판정을 중단했습니다.",
  LIVE_SNAPSHOT_WAITING: "TOP LIVE 14:30 관측 자료를 기다리고 있습니다.",
  LIVE_MARKET_CLOSED: "휴장으로 LIVE 관측 대상이 아닙니다.",
  LIVE_SNAPSHOT_INVALID: "TOP LIVE 관측 자료의 형식·수집 범위·내용 해시를 검증하지 못했습니다.",
  LIVE_SNAPSHOT_STALE: "다음 14:30 관측 시점이 지났지만 새 TOP LIVE 자료가 없어 LIVE 판정을 중단했습니다.",
  LIVE_SNAPSHOT_FUTURE: "관측 시각이 현재보다 미래인 TOP LIVE 자료는 사용할 수 없습니다.",
  LIVE_SOURCE_MISMATCH: "TOP LIVE와 당시 확정 일봉의 원천 해시가 일치하지 않습니다.",
  LIVE_SEED_MISSING: "TOP LIVE가 사용한 당시 확정 일봉 입력을 찾을 수 없습니다.",
  LIVE_HISTORY_MISSING: "TOP LIVE 직전 확정 거래일의 저장 이력을 찾을 수 없습니다.",
  LIVE_PRIOR_TRADING_DAY_UNVERIFIED: "직전 실제 거래일 또는 사이 휴장일을 확인하지 못해 LIVE 판정을 중단했습니다.",
  LIVE_CALENDAR_MISSING: "거래일 검증 자료가 없어 LIVE 판정을 중단했습니다.",
  LIVE_HISTORY_INVALID: "TOP LIVE 직전 확정 일봉의 이력·품질 검증을 통과하지 못했습니다.",
});

const validDate = (value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(value)
  && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const nextDate = (date) => new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
const closed = (calendar, date) => isWeekend(date) || calendar?.dates?.[date]?.status === "marketClosed";
const fail = (reason) => { throw new Error(reason); };

// A saved 14:30 observation is not a streaming quote. It expires when the next
// potentially open session reaches 14:30; unknown weekdays are never holidays.
export function validateLiveTransitionSources({ latest, signal, seed, history, calendar, now = new Date() }) {
  if (!latest) fail("LIVE_SNAPSHOT_MISSING");
  if (latest.status === "MARKET_CLOSED") fail("LIVE_MARKET_CLOSED");
  if (latest.status === "WAITING") fail("LIVE_SNAPSHOT_WAITING");
  if (latest.status !== "READY") fail("LIVE_SNAPSHOT_FAILED");
  if (!signal || validateIntradayModelTopSignal(signal).length || signal.status !== "READY"
    || signal.observationType !== "LIVE_OBSERVATION" || !validDate(signal.signalDate) || !validDate(signal.seedReferenceDate)
    || latest.signalDate !== signal.signalDate || latest.contentHash !== signal.contentHash
    || latest.signalPath !== `data/intraday-signals/model-top/${signal.signalDate}/1430.json`
    || signal.source?.provider !== "KIS" || signal.calculationBasis !== "priorOfficialDailyHistoryPlusSameDayKisProvisionalCandle") fail("LIVE_SNAPSHOT_INVALID");
  validateLiveTransitionFreshness(signal, calendar, now);
  if (!seed) fail("LIVE_SEED_MISSING");
  if (!history) fail("LIVE_HISTORY_MISSING");
  if (!Array.isArray(seed.records) || !Array.isArray(history.records)) fail("LIVE_HISTORY_INVALID");
  const eligible = seed.records.filter((record) => record.eligible === true);
  const byCode = new Map(signal.records.map((record) => [record.ticker, record]));
  if (signal.records.length !== seed.records.length || signal.universe?.sourceCount !== seed.records.length
    || signal.universe?.eligibleCount !== eligible.length
    || signal.universe?.eligibleHash !== hashIntradayModelTop(eligible.map((record) => record.code).sort())
    || signal.collection?.successful !== eligible.length || signal.collection?.failed !== 0
    || signal.collection?.ineligible !== seed.records.length - eligible.length
    || seed.records.some((record) => typeof record.eligible !== "boolean" || byCode.get(record.code)?.dataStatus !== (record.eligible ? "AVAILABLE" : "INELIGIBLE"))) fail("LIVE_SNAPSHOT_INVALID");
  if (seed.requestedDate !== signal.seedReferenceDate || history.asOfDate !== signal.seedReferenceDate
    || seed.requestedDate >= signal.signalDate || calendar.dates[seed.requestedDate]?.status !== "tradingDay") fail("LIVE_PRIOR_TRADING_DAY_UNVERIFIED");
  // The READY signal establishes its observed trading day; its earlier EOD seed
  // must be exactly the previous trading session, not merely the latest file.
  for (let date = nextDate(seed.requestedDate); date < signal.signalDate; date = nextDate(date)) {
    if (!closed(calendar, date)) fail("LIVE_PRIOR_TRADING_DAY_UNVERIFIED");
  }
  const dailyHash = seed.sourceManifest?.sources?.officialDailyPrice?.normalizedInputHash;
  if (!seed.contentHash || !dailyHash || !signal.source?.seedHash || !signal.source?.seedOfficialDailyHash
    || signal.source.seedHash !== seed.contentHash || signal.source.seedOfficialDailyHash !== dailyHash
    || history.sourceManifest?.sources?.officialDailyPrice?.normalizedInputHash !== dailyHash) fail("LIVE_SOURCE_MISMATCH");
}

export function validateLiveTransitionFreshness(signal, calendar, now = new Date()) {
  if (!calendar?.dates) fail("LIVE_CALENDAR_MISSING");
  if (closed(calendar, signal.signalDate)) fail("LIVE_MARKET_CLOSED");
  const nowMs = new Date(now).getTime();
  const started = Date.parse(signal.collectionStartedAt), completed = Date.parse(signal.collectionCompletedAt);
  const windowStart = Date.parse(`${signal.signalDate}T${OFFICIAL_SIGNAL_TIME}+09:00`);
  const windowEnd = Date.parse(`${signal.signalDate}T${OFFICIAL_SIGNAL_WINDOW_END}+09:00`);
  if (![nowMs, started, completed].every(Number.isFinite) || started < windowStart || started > windowEnd || completed < started) fail("LIVE_SNAPSHOT_INVALID");
  if (completed > nowMs) fail("LIVE_SNAPSHOT_FUTURE");
  const today = new Date(nowMs + 9 * 3_600_000).toISOString().slice(0, 10);
  for (let date = nextDate(signal.signalDate); date <= today; date = nextDate(date)) {
    if (!closed(calendar, date) && nowMs >= Date.parse(`${date}T${OFFICIAL_SIGNAL_TIME}+09:00`)) fail("LIVE_SNAPSHOT_STALE");
  }
}

export function observeLiveGoldenTransition(closedRows, observedPrice, pair, nearPercent = LIVE_NEAR_PERCENT_DEFAULT) {
  if (!Object.hasOwn(TRANSITION_PAIRS, pair) || !Number.isFinite(nearPercent) || nearPercent < 0 || nearPercent > 5) throw new Error("LIVE_FILTER_INVALID");
  const [short, long] = pair.split("-").map(Number);
  const closes = closedRows.slice(0, long).map((row) => row[4]);
  if (closes.length !== long || ![...closes, observedPrice].every((value) => Number.isFinite(value) && value > 0)) throw new Error("LIVE_MA_INPUT_MISSING");
  const sum = (count) => closes.slice(0, count).reduce((total, value) => total + value, 0);
  const previousShortSum = sum(short), previousLongSum = sum(long);
  const shortHistory = sum(short - 1), longHistory = sum(long - 1);
  const previousShort = previousShortSum / short, previousLong = previousLongSum / long;
  const currentShort = (shortHistory + observedPrice) / short, currentLong = (longHistory + observedPrice) / long;
  // Compare unrounded sums so equal lines do not become false crossings.
  const previousDifference = long * previousShortSum - short * previousLongSum;
  const currentDifference = long * (shortHistory + observedPrice) - short * (longHistory + observedPrice);
  const gapPercent = (currentShort / currentLong - 1) * 100;
  const previousGapPercent = (previousShort / previousLong - 1) * 100;
  const shortSlopePercent = (currentShort / previousShort - 1) * 100;
  const boundaryNumerator = short * longHistory - long * shortHistory, boundaryDenominator = long - short;
  const crossRequiredPrice = boundaryNumerator / boundaryDenominator;
  const priceRiseNumerator = boundaryNumerator - observedPrice * boundaryDenominator;
  const requiredAdditionalRisePercent = Math.max(0, priceRiseNumerator * 100 / (observedPrice * boundaryDenominator));
  const crossed = previousDifference <= 0 && currentDifference > 0;
  const near = previousDifference <= 0 && currentDifference < 0 && Math.abs(gapPercent) < Math.abs(previousGapPercent)
    && shortSlopePercent > 0 && priceRiseNumerator * 100 <= observedPrice * boundaryDenominator * nearPercent;
  return { status: crossed ? "CROSS_OCCURRED" : near ? "APPROACHING" : previousDifference > 0 && currentDifference > 0 ? "ALREADY_ABOVE" : "NONE",
    gapPercent, previousGapPercent, shortSlopePercent, currentShort, currentLong, previousShort, previousLong,
    crossRequiredPrice, requiredAdditionalRisePercent };
}

function quoteReason(record, signal) {
  if (record?.dataStatus !== "AVAILABLE") return "liveQuoteUnavailable";
  const quote = record.quote, candle = record.provisionalOhlcv;
  if (quote?.source !== "KIS" || quote.asOfDate !== signal.signalDate || !/^\d{2}:\d{2}:\d{2}$/u.test(quote.asOfTime ?? "")
    || quote.asOfTime < OFFICIAL_SIGNAL_TIME || quote.asOfTime > OFFICIAL_SIGNAL_WINDOW_END) return "liveQuoteTimestampInvalid";
  const observed = Date.parse(`${quote.asOfDate}T${quote.asOfTime}+09:00`), received = Date.parse(quote.receivedAt);
  if (![observed, received].every(Number.isFinite) || received < observed || received - observed >= 60_000
    || received < Date.parse(signal.collectionStartedAt) || received > Date.parse(signal.collectionCompletedAt)) return "liveQuoteStaleOrInvalid";
  if (!candle || ![candle.open, candle.high, candle.low, candle.close, candle.volume].every((v) => Number.isFinite(v) && v > 0)
    || candle.high < Math.max(candle.open, candle.close) || candle.low > Math.min(candle.open, candle.close)) return "liveQuoteOhlcvInvalid";
  return null;
}

export function buildLiveTransitionRows(input) {
  validateLiveTransitionSources(input);
  const { signal, seed, history, calendar } = input;
  let priorRows;
  try { priorRows = buildTransitionRows({ history, seed, calendar }); }
  catch { fail("LIVE_HISTORY_INVALID"); }
  const seeds = new Map(seed.records.map((row) => [row.code, row]));
  const live = new Map(signal.records.map((row) => [row.ticker, row]));
  return priorRows.map((prior) => {
    const record = live.get(prior.code), reason = quoteReason(record, signal);
    const missingReasons = [...prior.missingReasons, ...(reason ? [reason] : [])];
    const base = { code: prior.code, name: prior.name, market: prior.market, referenceDate: signal.signalDate,
      modelReferenceDate: history.asOfDate, models: prior.models, missingReasons,
      qualityStatus: missingReasons.length ? "UNAVAILABLE" : "PROVISIONAL" };
    if (missingReasons.length) return base;
    return { ...base, observedPrice: record.provisionalOhlcv.close, quoteAsOfDate: record.quote.asOfDate,
      quoteAsOfTime: record.quote.asOfTime, receivedAt: record.quote.receivedAt,
      // Retain only validated closed prices needed for both independent pairs.
      closedRows: seeds.get(prior.code).rows.slice(0, 60) };
  });
}

export function parseLiveTransitionFilters(params) {
  const pair = params.get("pair") ?? "5-20", state = params.get("state") ?? "candidates", market = params.get("market") ?? "all", code = params.get("code");
  const raw = params.get("nearPercent") ?? String(LIVE_NEAR_PERCENT_DEFAULT), nearPercent = Number(raw);
  if (!Object.hasOwn(TRANSITION_PAIRS, pair) || !["all", "candidates", "CROSS_OCCURRED", "APPROACHING", "ALREADY_ABOVE", "NONE"].includes(state)
    || !["all", "KOSPI", "KOSDAQ"].includes(market) || (code !== null && !/^[0-9A-Z]{6}$/u.test(code))
    || !/^(?:\d+(?:\.\d*)?|\.\d+)$/u.test(raw) || !Number.isFinite(nearPercent) || nearPercent < 0 || nearPercent > 5) throw new Error("LIVE_FILTER_INVALID");
  return { pair, state, market, code, nearPercent };
}

export function screenLiveTransitions(rows, filters) {
  const results = [], exclusions = { dataMissing: 0, conditionNotMet: 0 }, reasonCounts = {};
  for (const row of rows) {
    if (filters.code && row.code !== filters.code) continue;
    if (row.missingReasons.length) {
      exclusions.dataMissing++;
      for (const reason of row.missingReasons) reasonCounts[reason] = (reasonCounts[reason] ?? 0) + 1;
      continue;
    }
    const transition = observeLiveGoldenTransition(row.closedRows, row.observedPrice, filters.pair, filters.nearPercent);
    const matches = filters.state === "all" || (filters.state === "candidates" ? ["CROSS_OCCURRED", "APPROACHING"].includes(transition.status) : filters.state === transition.status);
    if (!matches || filters.market !== "all" && row.market !== filters.market) { exclusions.conditionNotMet++; continue; }
    const { closedRows: ignored, ...publicRow } = row; void ignored;
    results.push({ ...publicRow, pair: filters.pair, ...transition });
  }
  const order = ["CROSS_OCCURRED", "APPROACHING", "ALREADY_ABOVE", "NONE"];
  results.sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status) || a.requiredAdditionalRisePercent - b.requiredAdditionalRisePercent || a.code.localeCompare(b.code));
  return { results, exclusions, reasonCounts };
}
