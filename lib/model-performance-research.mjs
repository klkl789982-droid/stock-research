import { MODEL_VERSIONS, hashObject, scoreRank } from "./rank-backtest-engine.mjs";
import { PUBLIC_EOD_T2_POLICY_ID, EXECUTION_HORIZONS, locateExecutionTradingDay, resolveExecutionReturnsByPolicy } from "./execution-return-resolver.mjs";
import { immutableSnapshotView, prepareMarketPriceLedgers } from "./future-return-resolver.mjs";
import { validateMarketPriceLedger } from "./market-price-ledger.mjs";

export const RESEARCH_VERSION = "daily-execution-research-v1";
export const RESEARCH_CONTRACT = {
  version: RESEARCH_VERSION, executionPolicyId: PUBLIC_EOD_T2_POLICY_ID,
  entry: "신호일 이후 두 번째 검증 거래일 09:00 공식 시가. 실제 발행 완료가 진입보다 앞선 경우만 사용",
  exit: "진입일을 1일로 세어 1/5/20번째 거래일 15:30 공식 종가",
  aggregation: "개별 종목 관측과 완전한 신호일별 동일가중 포트폴리오를 분리. 중첩 포트폴리오는 복리·연율화하지 않음",
  benchmark: "동일 진입/청산일·시가/종가의 공식 시장 지수. 종목별 시장 비중으로 동일가중",
  costFormula: "net = ((1 + gross/100) × (1-sellSlippage) × (1-sellFee-sellTax) / ((1+buySlippage) × (1+buyFee)) - 1) × 100; 각 비율=bps/10000",
  statistics: "상승비율은 수익률>0의 비율(%), 표준편차는 표본 표준편차(n-1). 날짜도 독립성을 보장하지 않음. IID 신뢰구간·유의성·모델 우열은 산출하지 않음",
};
const round = (value) => Number.isFinite(value) ? Number(value.toFixed(6)) : null;
const validDate = (value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const unique = (items) => [...new Set(items)];
export function summarizeResearchReturns(values) {
  const data = values.filter(Number.isFinite).sort((a, b) => a - b), n = data.length;
  const mean = n ? data.reduce((a, b) => a + b, 0) / n : null;
  return { observationCount: n, meanReturn: round(mean), medianReturn: n ? round((data[Math.floor((n - 1) / 2)] + data[Math.floor(n / 2)]) / 2) : null,
    positiveRate: n ? round(data.filter((v) => v > 0).length / n * 100) : null,
    standardDeviation: n > 1 ? round(Math.sqrt(data.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (n - 1))) : null,
    minReturn: n ? data[0] : null, maxReturn: n ? data.at(-1) : null,
    distribution: n ? { negative: data.filter((v) => v < 0).length, zero: data.filter((v) => v === 0).length, positive: data.filter((v) => v > 0).length } : null };
}

export function validateResearchOptions(options = {}) {
  const result = { models: MODEL_VERSIONS, topN: 10, horizon: "H1", market: "ALL", classification: "AS_PUBLISHED", benchmark: "MATCHED_MARKET", from: null, to: null, cost: { mode: "GROSS_ONLY" }, ...options };
  if (!Array.isArray(result.models) || !result.models.length || result.models.some((v) => !MODEL_VERSIONS.includes(v)) || unique(result.models).length !== result.models.length) throw new Error("모델 버전을 확인하세요.");
  if (![5, 10, 20].includes(result.topN) || !EXECUTION_HORIZONS[result.horizon] || !["ALL", "KOSPI", "KOSDAQ"].includes(result.market) || !["AS_PUBLISHED", "RETROSPECTIVE"].includes(result.classification) || !["NONE", "MATCHED_MARKET"].includes(result.benchmark)) throw new Error("연구 필터가 올바르지 않습니다.");
  if ((result.from && !validDate(result.from)) || (result.to && !validDate(result.to)) || (result.from && result.to && result.from > result.to)) throw new Error("분석 기간을 확인하세요.");
  const cost = result.cost;
  if (!cost || !["GROSS_ONLY", "ZERO_COST_RESEARCH", "USER_INPUT"].includes(cost.mode)) throw new Error("비용 시나리오를 확인하세요.");
  if (cost.mode === "USER_INPUT") {
    for (const key of ["buyFeeBps", "sellFeeBps", "sellTaxBps", "buySlippageBps", "sellSlippageBps"]) if (!Number.isFinite(cost[key]) || cost[key] < 0 || cost[key] > 1000) throw new Error("비용은 각각 0~1000bps로 입력하세요.");
    if (!validDate(cost.basisDate) || typeof cost.basis !== "string" || !cost.basis.trim() || cost.basis.length > 200) throw new Error("비용 적용 기준일과 근거를 입력하세요.");
  }
  return result;
}
export function applyResearchCosts(gross, cost) {
  if (!Number.isFinite(gross) || cost.mode === "GROSS_ONLY") return null;
  if (cost.mode === "ZERO_COST_RESEARCH") return gross;
  const rate = (key) => cost[key] / 10000;
  return round(((1 + gross / 100) * (1 - rate("sellSlippageBps")) * (1 - rate("sellFeeBps") - rate("sellTaxBps")) / ((1 + rate("buySlippageBps")) * (1 + rate("buyFeeBps"))) - 1) * 100);
}

function formulaEvidence(snapshot, model) {
  const registered = snapshot.modelVersionDefinitions?.[model]?.formulaHash ?? null;
  const source = snapshot.sourceManifest?.modelFormulaHashes?.[model] ?? null;
  return { hash: registered ?? source, conflict: Boolean(registered && source && registered !== source) };
}
function matchedBenchmark(observation, benchmarks, asOf) {
  const leg = benchmarks.find((item) => item.market === observation.market && item.entryDate === observation.entryDate && item.exitDate === observation.exitDate && item.entryBasis === "officialDailyOpen" && item.exitBasis === "officialDailyClose"
    && item.source === "official-index" && item.provenance?.verified === true && item.provenance?.sourceHash && Number.isFinite(Date.parse(item.provenance.observedAt)) && Date.parse(item.provenance.observedAt) <= asOf
    && Date.parse(item.provenance.observedAt) >= Date.parse(`${observation.exitDate}T15:30:00+09:00`) && Number.isFinite(item.returnPercent));
  return leg ? { returnPercent: leg.returnPercent, source: leg.source, sourceHash: leg.provenance.sourceHash } : null;
}
function researchWarnings(rows, portfolios) {
  const mature = rows.filter((r) => r.status === "MATURE"), dates = unique(mature.map((r) => r.signalDate));
  const warnings = ["성과는 연구용 체결 가정이며 실제 체결·실현 수익률이 아닙니다.", "같은 날짜의 종목은 상관될 수 있고 신호일 수 역시 독립 표본 수가 아닙니다.", "과거 고정 universe의 생존자 편향 및 한정된 시장 환경을 확인해야 합니다.", "기간·TOP·모델을 반복 선택하면 데이터 스누핑이 발생할 수 있습니다. 유의성·최적 모델은 판정하지 않습니다."];
  if (dates.length < 30) warnings.push("성숙한 신호일이 30일 미만입니다. 30일도 유효성 보장의 기준은 아닙니다.");
  if (mature.length > unique(mature.map((r) => r.ticker)).length) warnings.push("동일 종목의 반복 선정이 포함됩니다. 관측 건수를 독립 표본 수로 해석하지 마세요.");
  if (portfolios.some((p, i) => portfolios.slice(0, i).some((q) => p.entryDate <= q.exitDate && q.entryDate <= p.exitDate))) warnings.push("보유 기간이 중첩됩니다. 포트폴리오 수익률을 연속 복리·연율화하지 않습니다.");
  return warnings;
}

/** Read-only research: frozen ranks only, never re-score or write a signal/outcome. */
export function buildModelPerformanceResearch({ signals = [], ledgers = [], calendar = { dates: {} }, benchmarks = [], asOf = new Date().toISOString(), options = {}, inputFiles = [] } = {}) {
  const filter = validateResearchOptions(options), now = Date.parse(asOf);
  if (!Number.isFinite(now)) throw new Error("연구 평가 시각이 유효하지 않습니다.");
  const kstDate = new Date(now + 9 * 3600000).toISOString().slice(0, 10);
  // Exclude today's close before 15:30 even if a file accidentally contains it.
  const closed = (date) => validDate(date) && Date.parse(`${date}T15:30:00+09:00`) <= now;
  const priceInputs = ledgers.filter((l) => l.source === "data-go-kr-official-daily-price" && closed(l.date) && ledgers.filter((other) => other.date === l.date).length === 1 && !validateMarketPriceLedger(l, 0).length);
  const prices = new Map(prepareMarketPriceLedgers(priceInputs).map((l) => [l.date, l]));
  const calendarAtTime = { ...calendar, dates: Object.fromEntries(Object.entries(calendar.dates ?? {}).filter(([date]) => closed(date))) };
  const filteredSignals = signals.filter(({ snapshot: s }) => s?.asOfDate && s.asOfDate <= kstDate && (!filter.from || s.asOfDate >= filter.from) && (!filter.to || s.asOfDate <= filter.to));
  const cohorts = new Map(), rejectedSignals = [];
  for (const signal of filteredSignals) {
    const s = signal.snapshot, classification = signal.classification ?? "UNVERIFIED";
    if (filteredSignals.filter((other) => other.snapshot.asOfDate === s.asOfDate && other.classification === classification).length > 1) { rejectedSignals.push({ signalDate: s.asOfDate, reason: "DUPLICATE_SIGNAL_DATE" }); continue; }
    if (classification !== filter.classification) { rejectedSignals.push({ signalDate: s.asOfDate, reason: classification === "UNVERIFIED" ? "PUBLICATION_UNVERIFIED" : "DIFFERENT_RESEARCH_LAYER" }); continue; }
    // Private / intraday sources cannot enter the Daily research layer, even if mislabeled.
    if (signal.layer !== "DAILY_EOD" || s.sourceManifest?.sources?.officialDailyPrice?.provider !== "공공데이터포털") { rejectedSignals.push({ signalDate: s.asOfDate, reason: "SOURCE_LAYER_NOT_ALLOWED" }); continue; }
    for (const model of filter.models) {
      const ranked = (s.records ?? []).map((r) => ({ r, meta: scoreRank(s, r, model) })).filter((v) => v.meta?.rank > 0).sort((a, b) => a.meta.rank - b.meta.rank || a.r.code.localeCompare(b.r.code));
      if (!ranked.length) continue;
      const formula = formulaEvidence(s, model), universeCodes = ranked.map((v) => v.r.code).sort(), universeHash = hashObject(universeCodes);
      const cohortKey = hashObject({ model, formulaHash: formula.hash, universeHash, classification });
      if (!cohorts.has(cohortKey)) cohorts.set(cohortKey, { id: cohortKey, modelVersion: model, formulaHash: formula.hash, universeHash, universeCount: universeCodes.length, classification, rows: [], signalDates: [], selectionCounts: {} });
      const cohort = cohorts.get(cohortKey); cohort.signalDates.push(s.asOfDate);
      const top = ranked.filter((v) => v.meta.rank <= filter.topN), selected = top.filter((v) => filter.market === "ALL" || v.r.market === filter.market);
      cohort.selectionCounts[s.asOfDate] = selected.length;
      const duplicatedRank = new Set(ranked.map((v) => v.meta.rank)).size !== ranked.length;
      const duplicatedTicker = new Set((s.records ?? []).map((r) => r.code)).size !== (s.records ?? []).length;
      const certified = s.dataQuality?.certification?.eligibleForRankBacktest === true && s.dataQuality?.eligibleForRankBacktest !== false;
      const universeCertified = s.sourceManifest?.universe?.artifact?.verificationStatus === "VERIFIED";
      for (const { r, meta } of selected) {
        const row = { researchVersion: RESEARCH_VERSION, layer: "DAILY_EOD", classification, signalDate: s.asOfDate, signalGeneratedAt: s.signalComputedAt ?? s.sourceAvailability?.signalComputedAt ?? s.generatedAt ?? null,
          signalAvailableAt: signal.availableAt ?? null, sourceSnapshotHash: signal.sourceSnapshotHash ?? hashObject(immutableSnapshotView(s)), ticker: r.code, companyName: r.name ?? null, market: r.market ?? null,
          modelVersion: model, formulaHash: formula.hash, universeHash, universeCount: universeCodes.length, rank: meta.rank, score: meta.score,
          referencePrice: Number.isFinite(r.closePrice) ? r.closePrice : null, referencePriceBasis: "signalDayOfficialClose_NOT_EXECUTION", horizon: filter.horizon,
          executionPolicyId: PUBLIC_EOD_T2_POLICY_ID, entryDate: null, exitDate: null, status: "DATA_MISSING", reason: null, grossReturn: null, netScenarioReturn: null, benchmark: null,
          provenance: { source: "data-go-kr-official-daily-price", normalizedInputHash: s.sourceManifest?.sources?.officialDailyPrice?.normalizedInputHash ?? null, availabilityEvidence: signal.availabilityEvidence ?? "UNVERIFIED", qualityBlockingReasons: s.dataQuality?.blockingReasons ?? [] } };
        if (!certified) row.reason = "DATA_QUALITY_BLOCKED";
        else if (!universeCertified) row.reason = "POINT_IN_TIME_UNIVERSE_UNVERIFIED";
        else if (formula.conflict) row.reason = "FORMULA_HASH_CONFLICT";
        else if (!formula.hash) row.reason = "FORMULA_HASH_MISSING";
        else if (duplicatedRank || duplicatedTicker || top.length !== filter.topN || !top.every((v, i) => v.meta.rank === i + 1)) row.reason = "INCOMPLETE_OR_DUPLICATE_RANKING";
        else if (r.qualityEligibility?.eligible === false) row.reason = "RECORD_QUALITY_BLOCKED";
        else if (signal.availabilityEvidence !== "VERIFIED" || !Number.isFinite(Date.parse(signal.availableAt))) row.reason = "SIGNAL_PUBLICATION_TIME_UNVERIFIED";
        else if (Date.parse(signal.availableAt) < Date.parse(`${s.asOfDate}T15:30:00+09:00`) || (row.signalGeneratedAt && (!Number.isFinite(Date.parse(row.signalGeneratedAt)) || Date.parse(row.signalGeneratedAt) > Date.parse(signal.availableAt)))) row.reason = "SIGNAL_TIMING_CONFLICT";
        else if (Date.parse(signal.availableAt) > now) { row.status = "PENDING"; row.reason = "SIGNAL_NOT_YET_AVAILABLE"; }
        else {
          // Discard cached execution envelopes: they may have been resolved after this as-of.
          const cleanRecord = { ...r }; delete cleanRecord.executionReturnsByPolicy;
          const availableSnapshot = { ...s, signalAvailableAt: signal.availableAt, sourceAvailabilityStatus: "VERIFIED" };
          const execution = resolveExecutionReturnsByPolicy(cleanRecord, availableSnapshot, prices, calendarAtTime);
          const h = EXECUTION_HORIZONS[filter.horizon];
          const entryTarget = locateExecutionTradingDay(calendarAtTime, s.asOfDate, 2);
          const exitTarget = entryTarget.status === "resolved" ? (h.holdingTradingDay === 1 ? entryTarget : locateExecutionTradingDay(calendarAtTime, entryTarget.date, h.holdingTradingDay - 1)) : entryTarget;
          row.entryDate = execution.entry.date ?? (entryTarget.status === "resolved" ? entryTarget.date : null);
          row.exitDate = execution.exits[h.exitKey].date ?? (exitTarget.status === "resolved" ? exitTarget.date : null);
          row.reason = execution.resolution.entryStatus === "timingValid" ? execution.resolution[h.statusKey] : execution.resolution.entryStatus;
          if (execution.timingValidationStatus === "VALID" && execution.resolution[h.statusKey] === "resolved" && Number.isFinite(execution.returns[h.returnKey])) {
            row.status = "MATURE"; row.reason = null; row.grossReturn = execution.returns[h.returnKey];
            row.netScenarioReturn = applyResearchCosts(row.grossReturn, filter.cost);
            if (filter.benchmark !== "NONE") row.benchmark = matchedBenchmark(row, benchmarks, now);
          } else if (entryTarget.status === "pendingFutureTradingDay" || (execution.resolution.entryStatus === "timingValid" && exitTarget.status === "pendingFutureTradingDay")) row.status = "PENDING";
          row.provenance.entryLedgerHash = row.entryDate && prices.has(row.entryDate) ? hashObject(ledgers.find((l) => l.date === row.entryDate)) : null;
          row.provenance.exitLedgerHash = row.exitDate && prices.has(row.exitDate) ? hashObject(ledgers.find((l) => l.date === row.exitDate)) : null;
        }
        cohort.rows.push(row);
      }
    }
  }
  const summaries = [...cohorts.values()].map((cohort) => {
    const mature = cohort.rows.filter((r) => r.status === "MATURE"), dates = unique(cohort.signalDates).sort(), portfolios = [];
    for (const date of dates) {
      const rows = cohort.rows.filter((r) => r.signalDate === date), expected = cohort.selectionCounts[date];
      // No partial-data reweighting: an incomplete TOP portfolio is not a complete observation.
      if (!expected || rows.length !== expected || rows.some((r) => r.status !== "MATURE")) continue;
      const mean = (key) => round(rows.reduce((sum, r) => sum + r[key], 0) / rows.length);
      const benchmarkReturn = rows.every((r) => r.benchmark) ? round(rows.reduce((sum, r) => sum + r.benchmark.returnPercent, 0) / rows.length) : null;
      portfolios.push({ signalDate: date, entryDate: rows[0].entryDate, exitDate: rows[0].exitDate, memberCount: expected, grossReturn: mean("grossReturn"), netScenarioReturn: rows.every((r) => Number.isFinite(r.netScenarioReturn)) ? mean("netScenarioReturn") : null,
        benchmarkReturn, excessReturn: benchmarkReturn == null ? null : round(mean("grossReturn") - benchmarkReturn) });
    }
    const reasons = Object.fromEntries(unique(cohort.rows.map((r) => r.reason).filter(Boolean)).map((reason) => [reason, cohort.rows.filter((r) => r.reason === reason).length]));
    const { selectionCounts: _selectionCounts, ...publicCohort } = cohort; void _selectionCounts;
    return { ...publicCohort, signalDates: dates, status: mature.length ? "DESCRIPTIVE_ONLY" : cohort.rows.some((r) => r.reason === "DATA_QUALITY_BLOCKED") ? "DATA_QUALITY_BLOCKED" : "ACCUMULATING_OR_UNVERIFIED",
      signalDateCount: dates.length, observedSignalDateCount: unique(mature.map((r) => r.signalDate)).length, matureSignalDateCount: portfolios.length,
      uniqueStockCount: unique(mature.map((r) => r.ticker)).length, repeatedObservationCount: mature.length - unique(mature.map((r) => r.ticker)).length,
      pendingCount: cohort.rows.filter((r) => r.status === "PENDING").length, missingCount: cohort.rows.filter((r) => r.status === "DATA_MISSING").length, exclusionReasons: reasons,
      stockMetrics: summarizeResearchReturns(mature.map((r) => r.grossReturn)), portfolioMetrics: summarizeResearchReturns(portfolios.map((r) => r.grossReturn)),
      netScenarioMetrics: summarizeResearchReturns(portfolios.map((r) => r.netScenarioReturn)), benchmarkMetrics: summarizeResearchReturns(portfolios.map((r) => r.benchmarkReturn)), excessMetrics: summarizeResearchReturns(portfolios.map((r) => r.excessReturn)),
      portfolios, warnings: researchWarnings(cohort.rows, portfolios) };
  });
  // Compare only common mature dates AND identical native ranking universe for every model.
  const comparable = summaries.filter((c) => c.portfolios.length);
  let commonDates = comparable.length ? comparable[0].portfolios.map((p) => p.signalDate) : [];
  if (filter.models.some((m) => comparable.filter((c) => c.modelVersion === m).length !== 1)) commonDates = [];
  commonDates = commonDates.filter((date) => comparable.every((c) => c.portfolios.some((p) => p.signalDate === date)) && new Set(comparable.map((c) => c.universeHash)).size === 1);
  return { researchVersion: RESEARCH_VERSION, layer: "DAILY_EOD_EXECUTION_RESEARCH", asOf, filter, contract: RESEARCH_CONTRACT,
    costStatus: filter.cost.mode === "GROSS_ONLY" ? "NOT_APPLIED" : "UNVERIFIED_RESEARCH_SCENARIO", benchmarkStatus: summaries.some((c) => c.benchmarkMetrics.observationCount) ? "PARTIAL_OR_AVAILABLE" : "UNAVAILABLE",
    coverage: { storedSignalCount: filteredSignals.length, selectedSignalCount: filteredSignals.length - rejectedSignals.length, latestStoredSignalDate: filteredSignals.map((v) => v.snapshot.asOfDate).sort().at(-1) ?? null,
      officialPriceDateRange: priceInputs.length ? { from: priceInputs.map((l) => l.date).sort()[0], to: priceInputs.map((l) => l.date).sort().at(-1) } : null, rejectedSignals },
    cohorts: summaries, comparison: { status: commonDates.length ? "COMPARABLE_DESCRIPTIVE_ONLY" : "NOT_COMPARABLE", commonMatureSignalDates: commonDates, winner: null,
      metrics: commonDates.length ? comparable.map((c) => ({ modelVersion: c.modelVersion, formulaHash: c.formulaHash, universeHash: c.universeHash, ...summarizeResearchReturns(c.portfolios.filter((p) => commonDates.includes(p.signalDate)).map((p) => p.grossReturn)) })) : [],
      reason: "같은 기간·공식 hash별 코호트·동일 native universe·완전한 포트폴리오만 비교. 통계적 우열은 미판정" },
    provenance: { inputFiles, inputHash: hashObject({ signals: filteredSignals.map((v) => ({ snapshot: immutableSnapshotView(v.snapshot), classification: v.classification, availableAt: v.availableAt, availabilityEvidence: v.availabilityEvidence })), ledgers: priceInputs, calendar: calendarAtTime, benchmarks, filter, version: RESEARCH_VERSION }) } };
}
