import { calculateTechnicalModelFeatures } from "./technical-model-features.mjs";
import { sha256Canonical } from "./snapshot-quality-pipeline.mjs";
import { TRANSITION_PAIRS } from "./transition-rule-policy.mjs";
import { evidencePolicy } from "./transition-evidence-policy.mjs";

export const evidenceConfigHash = sha256Canonical(evidencePolicy);
const finite = (v) => Number.isFinite(v);
const positive = (v) => finite(v) && v > 0;
const percent = (a, b) => finite(a) && positive(b) ? (a / b - 1) * 100 : null;
const item = (status, reason, metrics) => ({ status, reason, metrics });
const missing = (metrics) => item("DATA_MISSING", "필요한 확정 관측값이 부족하여 판정하지 않습니다.", metrics);
const decide = (yes, partial, fullReason, partialReason, noReason, metrics) => item(yes ? "MET" : partial ? "PARTIAL" : "NOT_MET", yes ? fullReason : partial ? partialReason : noReason, metrics);

// Pure point-in-time evidence. No model scoring, realtime calls, or outcome estimates.
export function evaluateTransitionEvidence({ points, pair, current, bars }) {
  const t = evidencePolicy.thresholds;
  const [short, long] = TRANSITION_PAIRS[pair];
  const p = points.at(-1), prev = points.at(-2), earlier = points.at(-3);
  const gap = (point) => positive(point?.[short]) && positive(point?.[long]) ? percent(point[short], point[long]) : null;
  const gapPercent = gap(p), previousGapPercent = gap(prev);
  const shrink = finite(gapPercent) && finite(previousGapPercent) && gapPercent < 0 && previousGapPercent < 0 ? Math.abs(previousGapPercent) - Math.abs(gapPercent) : null;
  const gaps = points.slice(-(t.sustainedGapTransitions + 1)).map(gap);
  const gapMetrics = { gapPercent, previousGapPercent, shrinkPercentPoints: shrink,
    shrinkingTransitions: gaps.slice(1).filter((g, i) => finite(g) && finite(gaps[i]) && g < 0 && gaps[i] < 0 && Math.abs(gaps[i]) - Math.abs(g) > t.improvement).length,
    requiredTransitions: t.sustainedGapTransitions, phase: finite(gapPercent) ? gapPercent >= 0 ? "ALREADY_AT_OR_ABOVE" : "BELOW" : "UNKNOWN" };
  const gapEvidence = gaps.length !== t.sustainedGapTransitions + 1 || gaps.some((g) => !finite(g)) ? missing(gapMetrics)
    : gapPercent >= 0 ? item("NOT_MET", "이미 단기선이 장기선 이상입니다. 교차 발생·확인은 별도 신호 상태로 확인하세요.", gapMetrics)
      : decide(gapMetrics.shrinkingTransitions === t.sustainedGapTransitions, shrink > t.improvement,
        `장기선 아래에서 최근 ${t.sustainedGapTransitions}거래일 연속 간격이 축소됐습니다.`, `당일 간격은 축소됐지만 ${t.sustainedGapTransitions}거래일 연속 축소는 아닙니다.`, "장기선 아래의 지속적인 간격 축소를 확인하지 못했습니다.", gapMetrics);
  const slope = percent(p?.[short], prev?.[short]), previousSlope = percent(prev?.[short], earlier?.[short]);
  const longSlope = percent(p?.[long], prev?.[long]);
  const slopeChange = finite(slope) && finite(previousSlope) ? slope - previousSlope : null;
  const trendMetrics = { shortSlopePercent: slope, previousShortSlopePercent: previousSlope, slopeChangePercentPoints: slopeChange, longSlopePercent: longSlope,
    phase: !finite(slope) || !finite(previousSlope) ? "UNKNOWN" : slope > 0 && previousSlope <= 0 ? "TURNED_UP" : slope > 0 ? "RISING" : slopeChange > 0 ? "DECLINE_SLOWING" : slope === 0 ? "FLAT" : "DECLINING" };
  const trendEvidence = !finite(slope) || !finite(previousSlope) ? missing(trendMetrics)
    : decide(slope > t.improvement && slopeChange > t.improvement, slope > t.improvement || slopeChange > t.improvement,
      "단기선이 상승 중이며 직전보다 상승 기울기도 개선됐습니다.", slope <= 0 ? "상승 기울기는 아니지만 하락 속도가 둔화됐습니다." : "단기선은 상승 중이나 기울기 개선은 확인되지 않았습니다.", "단기선의 상승 또는 기울기 개선을 확인하지 못했습니다.", trendMetrics);
  const momentumMetrics = { rsi: current?.rsi ?? null, rsiChange: current?.rsiChange ?? null, macd: current?.macd ?? null, signal: current?.signal ?? null,
    histogram: current?.histogram ?? null, previousHistogram: current?.previousHistogram ?? null,
    histogramChange: finite(current?.histogram) && finite(current?.previousHistogram) ? current.histogram - current.previousHistogram : null };
  const momentumEvidence = ![momentumMetrics.rsi, momentumMetrics.rsiChange, momentumMetrics.macd, momentumMetrics.signal, momentumMetrics.histogramChange].every(finite) ? missing(momentumMetrics)
    : decide(momentumMetrics.rsiChange > t.improvement && momentumMetrics.histogramChange > t.improvement, momentumMetrics.rsiChange > t.improvement || momentumMetrics.histogramChange > t.improvement,
      "RSI와 MACD 히스토그램이 모두 개선됐습니다. MACD가 Signal 아래여도 개선을 인정합니다.", "RSI 또는 히스토그램 중 한 지표만 개선됐습니다.", "RSI·히스토그램 개선을 확인하지 못했습니다.", momentumMetrics);
  const today = bars?.[0], yesterday = bars?.[1];
  const volumeMetrics = { volumeMultiple: finite(current?.volumeRatio) ? current.volumeRatio / 100 : null,
    volumeGrowthPercent: percent(today?.trqu, yesterday?.trqu), priceChangePercent: percent(today?.clpr, yesterday?.clpr) };
  const volumeEvidence = !Object.values(volumeMetrics).every(finite) ? missing(volumeMetrics)
    : decide(volumeMetrics.priceChangePercent > t.priceChangePercent && volumeMetrics.volumeMultiple >= t.volumeMultiple && volumeMetrics.volumeGrowthPercent > t.volumeGrowthPercent,
      volumeMetrics.priceChangePercent > t.priceChangePercent && (volumeMetrics.volumeMultiple >= t.volumeMultiple || volumeMetrics.volumeGrowthPercent > t.volumeGrowthPercent),
      `종가 상승과 평균 대비 ${t.volumeMultiple}배 이상 거래량, 전일 대비 거래량 증가가 동반됐습니다.`, "종가는 상승했지만 두 거래량 조건 중 하나만 충족했습니다.", volumeMetrics.priceChangePercent <= t.priceChangePercent ? "하락·보합 거래의 거래량 증가는 상승 근거로 보지 않습니다." : "상승 거래량 동반 조건이 충족되지 않았습니다.", volumeMetrics);
  const prior = bars?.slice(1, t.breakoutLookback + 1) ?? [];
  const priorHigh = prior.length === t.breakoutLookback && prior.every((b) => positive(b.hipr)) ? Math.max(...prior.map((b) => b.hipr)) : null;
  const breakout = { lookback: t.breakoutLookback, priorHigh, status: !positive(today?.clpr) || priorHigh === null ? "DATA_MISSING" : today.clpr > priorHigh ? "MET" : "NOT_MET" };
  const categories = { gap: gapEvidence, trend: trendEvidence, momentum: momentumEvidence, volume: volumeEvidence };
  return { version: evidencePolicy.version, configHash: evidenceConfigHash, researchOnly: true, direction: "UPWARD", pair,
    fulfilledCount: Object.values(categories).filter((e) => e.status === "MET").length,
    evaluableCount: Object.values(categories).filter((e) => e.status !== "DATA_MISSING").length, categories, breakout };
}

// Called only AFTER existing seed/quality/calendar validation. Additive metadata leaves
// legacy transition observations and their immutable hashes unchanged.
export function attachTransitionEvidence(rows, seed) {
  const inputs = new Map(seed.records.map((r) => [r.code, r]));
  return rows.map((row) => {
    if (row.missingReasons.length) return { ...row, upwardEvidence: null };
    const bars = inputs.get(row.code).rows.map(([basDt, mkp, hipr, lopr, clpr, trqu]) => ({ basDt, mkp, hipr, lopr, clpr, trqu }));
    const current = calculateTechnicalModelFeatures(bars);
    const points = Array.from({ length: evidencePolicy.thresholds.sustainedGapTransitions + 1 }, (_, index) => evidencePolicy.thresholds.sustainedGapTransitions - index).map((offset) => {
      const f = offset === 0 ? current : calculateTechnicalModelFeatures(bars.slice(offset));
      return { ma5: f.ma5, ma20: f.ma20, ma60: f.ma60 };
    });
    return { ...row, upwardEvidence: Object.fromEntries(Object.keys(TRANSITION_PAIRS).map((pair) => [pair, evaluateTransitionEvidence({ points, pair, current, bars })])) };
  });
}

export function createEvidenceObservationSnapshot({ rows, history, seed }) {
  const base = { schemaVersion: 1, dataset: "transition-evidence-signals", layer: "DAILY_EOD_RESEARCH_ONLY", version: evidencePolicy.version, config: evidencePolicy, configHash: evidenceConfigHash,
    signalDate: history.asOfDate, referenceDate: history.asOfDate, source: { seedContentHash: seed.contentHash, priceInputHash: seed.sourceManifest.sources.officialDailyPrice.normalizedInputHash },
    records: rows.filter((r) => !r.missingReasons.length && r.upwardEvidence).flatMap((r) => Object.keys(TRANSITION_PAIRS).flatMap((pair) => ["golden", "dead"].map((direction) => ({
      observationId: sha256Canonical({ signalDate: r.referenceDate, code: r.code, pair, direction, version: evidencePolicy.version, configHash: evidenceConfigHash, seedContentHash: seed.contentHash }),
      code: r.code, name: r.name, signalDate: r.referenceDate, referenceDate: r.referenceDate, pair, signalDirection: direction,
      transition: r.directionalTransitions[pair][direction], upwardEvidence: r.upwardEvidence[pair],
    })))).sort((a, b) => a.observationId.localeCompare(b.observationId)),
    futureOutcomes: { namespace: "transition-evidence-outcomes", horizons: ["1D", "5D", "20D"], status: "NOT_OBSERVED", entryContract: null },
  };
  return { ...base, contentHash: sha256Canonical(base) };
}
