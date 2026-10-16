import { createScreeningRows, SCREENING_MODELS } from "./stock-screener.mjs";
import { TRANSITION_RULE_VERSION, TRANSITION_PAIRS, TRANSITION_STATUSES } from "./transition-rule-policy.mjs";
import { DIRECTIONAL_RULE_VERSION } from "./directional-transition.mjs";

export const HOME_MODELS = Object.keys(SCREENING_MODELS);
const ranked = (rows, model) => rows.filter((r) => r.qualityEligible && Number.isFinite(r.models[model]?.score) && Number.isInteger(r.models[model]?.rank) && r.models[model].rank > 0);
const stock = (row, model) => ({ code: row.code, name: row.name, market: row.market, rank: row.models[model].rank, score: row.models[model].score });

// Frozen native ranks only. A universe change is not a technical TOP entry/exit.
export function summarizeModelChanges(current, previous, previousOfficialDate, topN = 5) {
  if (![5, 10, 20].includes(topN)) throw new Error("HOME_TOP_N_INVALID");
  const currentRows = createScreeningRows(current, null), previousRows = previous ? createScreeningRows(previous, null) : [];
  const models = HOME_MODELS.map((model) => {
    const now = ranked(currentRows, model), before = ranked(previousRows, model);
    const top = now.filter((r) => r.models[model].rank <= topN).sort((a, b) => a.models[model].rank - b.models[model].rank || a.code.localeCompare(b.code));
    const currentHash = current.modelVersionDefinitions?.[model]?.formulaHash ?? current.sourceManifest?.modelFormulaHashes?.[model] ?? null;
    const previousHash = previous?.modelVersionDefinitions?.[model]?.formulaHash ?? previous?.sourceManifest?.modelFormulaHashes?.[model] ?? null;
    const previousAvailable = previous && previous.asOfDate === previousOfficialDate && previous.asOfDate < current.asOfDate && previous.dataQuality?.structuralStatus === "passed" && current.dataQuality?.structuralStatus === "passed";
    const formulaMatches = currentHash && previousHash && currentHash === previousHash;
    const versionMatches = current.modelDefinitions?.[model[0]]?.modelVersion === model && previous?.modelDefinitions?.[model[0]]?.modelVersion === model;
    const identity = (rows) => rows.map((r) => `${r.code}:${r.market}`).sort();
    const sameSet = (a, b) => a.length > 0 && a.length === b.length && new Set(a).size === a.length && new Set(b).size === b.length && a.every((value, index) => value === b[index]);
    const universeMatches = sameSet(identity(currentRows), identity(previousRows)) && sameSet(identity(now), identity(before));
    const validRanks = (rows) => new Set(rows.map((r) => r.models[model].rank)).size === rows.length && rows.every((r) => r.models[model].rank <= rows.length);
    const comparable = previousAvailable && formulaMatches && versionMatches && universeMatches && validRanks(now) && validRanks(before);
    const oldMap = new Map(before.map((r) => [r.code, r])), nowMap = new Map(now.map((r) => [r.code, r]));
    const common = new Set(now.filter((r) => oldMap.has(r.code)).map((r) => r.code));
    const priorTop = before.filter((r) => r.models[model].rank <= topN);
    return { modelVersion: model, top: top.map((r) => ({ ...stock(r, model), previousRank: comparable ? oldMap.get(r.code).models[model].rank : null, rankChange: comparable ? oldMap.get(r.code).models[model].rank - r.models[model].rank : null })), rankingUniverseCount: now.length,
      comparisonStatus: comparable ? "AVAILABLE" : "UNAVAILABLE", previousDate: previousOfficialDate,
      comparisonReason: comparable ? null : !previousAvailable ? "PREVIOUS_TRADING_SNAPSHOT_MISSING_OR_INVALID" : !formulaMatches ? "FORMULA_PROVENANCE_CHANGED_OR_MISSING" : !versionMatches ? "MODEL_VERSION_CHANGED_OR_MISSING" : !universeMatches ? "RANKING_UNIVERSE_CHANGED" : "RANKING_STRUCTURE_INVALID",
      commonUniverseCount: comparable ? common.size : null,
      entered: comparable ? top.filter((r) => common.has(r.code) && oldMap.get(r.code).models[model].rank > topN).map((r) => stock(r, model)) : null,
      exited: comparable ? priorTop.filter((r) => common.has(r.code) && nowMap.get(r.code).models[model].rank > topN).map((r) => ({ ...stock(r, model), currentRank: nowMap.get(r.code).models[model].rank })) : null,
      risers: comparable ? top.filter((r) => common.has(r.code) && r.models[model].rank < oldMap.get(r.code).models[model].rank).map((r) => ({ ...stock(r, model), previousRank: oldMap.get(r.code).models[model].rank, rankRise: oldMap.get(r.code).models[model].rank - r.models[model].rank })) : null,
      universeAddedTop: comparable ? top.filter((r) => !common.has(r.code)).map((r) => stock(r, model)) : null,
      universeRemovedTop: comparable ? priorTop.filter((r) => !common.has(r.code)).map((r) => stock(r, model)) : null,
    };
  });
  const appearances = new Map();
  for (const model of models) for (const row of model.top) {
    if (!appearances.has(row.code)) appearances.set(row.code, { code: row.code, name: row.name, models: [] });
    appearances.get(row.code).models.push(model.modelVersion);
  }
  return { layer: "DAILY_EOD", referenceDate: current.asOfDate, previousOfficialDate, topN, models,
    overlap: [...appearances.values()].filter((r) => r.models.length > 1).sort((a, b) => b.models.length - a.models.length || a.code.localeCompare(b.code)) };
}

export function summarizeTransitions(data, modelSummary) {
  const available = data.rows.filter((r) => !r.missingReasons.length);
  const topModels = new Map();
  if (modelSummary?.referenceDate === data.referenceDate) for (const model of modelSummary.models) for (const row of model.top) {
    if (!topModels.has(row.code)) topModels.set(row.code, []);
    topModels.get(row.code).push(model.modelVersion);
  }
  return { referenceDate: data.referenceDate, ruleVersion: TRANSITION_RULE_VERSION, researchOnly: true,
    indicatorCoverage: available.length, totalUniverse: data.rows.length, excludedCount: data.rows.length - available.length,
    sourceQualityGrade: data.sourceQualityGrade, isPartialRanking: data.isPartialRanking,
    directionalRuleVersion: DIRECTIONAL_RULE_VERSION,
    pairs: Object.keys(TRANSITION_PAIRS).map((pair) => ({ pair,
      directionalStates: ["APPROACHING", "CROSS_OCCURRED", "CONFIRMED"].flatMap((state) => ["golden", "dead"].map((direction) => {
        const matches = available.filter((r) => r.directionalTransitions?.[pair]?.[direction]?.status === state);
        return { direction, state, count: available.some((r) => r.directionalTransitions?.[pair]) ? matches.length : null,
          examples: [...matches].sort((a, b) => (b.directionalTransitions[pair][direction].approachStrength ?? -1) - (a.directionalTransitions[pair][direction].approachStrength ?? -1) || a.code.localeCompare(b.code))
            .slice(0, 1).map((r) => ({ code: r.code, name: r.name, market: r.market, gapPercent: r.directionalTransitions[pair][direction].gapPercent })) };
      })),
      states: TRANSITION_STATUSES.filter((state) => state !== "NONE").map((state) => {
        const matches = available.filter((r) => r.transitions[pair].status === state);
        return { state, count: matches.length,
          examples: [...matches].sort((a, b) => Math.abs(a.transitions[pair].gapPercent) - Math.abs(b.transitions[pair].gapPercent) || a.code.localeCompare(b.code)).slice(0, 3).map((r) => ({ code: r.code, name: r.name, gapPercent: r.transitions[pair].gapPercent, shortSlopePercent: r.transitions[pair].shortSlopePercent, crossDate: r.transitions[pair].crossDate, aboveTradingDays: r.transitions[pair].aboveTradingDays, topModels: topModels.get(r.code) ?? [] })) };
      }) })),
  };
}

// Select the latest resolved *cross-section*, never relabel pooled performance.
export function latestOneDayPerformance(performance, topN = 5) {
  const summarize = (layer) => HOME_MODELS.map((model) => {
    const row = (layer?.daily ?? []).filter((r) => r.modelVersion === model && r.topN === topN && r.horizon === "1DAY" && r.observationCount > 0 && Number.isFinite(r.meanReturn)).sort((a, b) => b.signalDate.localeCompare(a.signalDate)).at(0);
    return row ? { modelVersion: model, signalDate: row.signalDate, resultDate: row.targetTradingDate, meanReturn: row.meanReturn, positiveRate: row.positiveRate, observationCount: row.observationCount, rankedConstituentCount: row.rankedConstituentCount } : { modelVersion: model, meanReturn: null, positiveRate: null, observationCount: 0, signalDate: null, resultDate: null };
  });
  return { topN, daily: summarize(performance), live: summarize(performance?.live?.layer === "INTRADAY_1400_LIVE" && performance.live.executionPolicyId === "intraday-1400-t1-open-v1" ? performance.live : null) };
}

export function calendarContext(calendar, now = new Date()) {
  const kst = new Date(now.getTime() + 9 * 3600000).toISOString();
  const today = kst.slice(0, 10), time = kst.slice(11, 19);
  const weekend = (date) => [0, 6].includes(new Date(`${date}T00:00:00Z`).getUTCDay());
  const dayStatus = weekend(today) ? "marketClosed" : calendar?.dates?.[today]?.status ?? "unchecked";
  let expectedTradingDate = null;
  if (dayStatus === "tradingDay") expectedTradingDate = today;
  if (dayStatus === "marketClosed") {
    const cursor = new Date(`${today}T00:00:00Z`);
    for (let i = 0; i < 15; i += 1) {
      cursor.setUTCDate(cursor.getUTCDate() - 1);
      const date = cursor.toISOString().slice(0, 10);
      if (weekend(date) || calendar?.dates?.[date]?.status === "marketClosed") continue;
      if (calendar?.dates?.[date]?.status === "tradingDay") expectedTradingDate = date;
      break; // Unknown weekdays are not invented holidays.
    }
  }
  return { today, time, dayStatus, expectedTradingDate };
}

// Source availability and deployment proof are independent. A calendar/time
// heuristic cannot prove a new EOD exists or that this deployment was verified.
export function dailyOperationState(status, context) {
  if (!status) return "UNKNOWN";
  if (context?.today && status.siteApiReferenceDate > context.today) return "UNKNOWN";
  if (["DEPLOYMENT_FAILED", "VERIFICATION_FAILED", "DEPLOYING"].includes(status.deployment?.state)) return status.deployment.state;
  if (status.latestAttempt?.conclusion === "failure" && status.latestAttempt?.stage === "REPOSITORY" && (status.latestAttempt.sourceCommitSha === status.repositoryCommitSha || status.latestAttempt.completedAt >= status.lastAttemptAt)) return "PUBLICATION_FAILED";
  if (status.runStatus === "FAILED" || status.runStatus === "REVISION_REQUIRES_APPROVAL" || (status.recentFailureReason && status.lastFailureAt && (!status.lastSuccessAt || status.lastFailureAt > status.lastSuccessAt))) return "FAILED";
  if (status.repositoryPublicationStatus === "candidateValidated") return "COLLECTED_VALIDATED";
  if (status.deployment?.state !== "VERIFIED") return "UNVERIFIED";
  if (status.freshnessStatus === "stale" || status.lagTradingDays > 0) return "DELAYED";
  if (status.sourceStatus === "NO_NEW_DATA") return "SOURCE_WAITING";
  return "VERIFIED";
}

export function publicationReasonLabel(reason) {
  return ({
    CURRENT_HOME_READ_FAILED: "현재 홈 데이터 조회 실패", CURRENT_PERFORMANCE_READ_FAILED: "현재 성과 데이터 조회 실패",
    CURRENT_PAGE_LOADING: "현재 홈·성과 데이터 확인 중", CURRENT_PAGE_UNAVAILABLE: "현재 홈·성과 데이터 확인 불가",
    CURRENT_PAGE_IDENTITY_MISMATCH: "현재 홈·성과·운영 데이터 내용 또는 커밋 불일치",
    VERCEL_DEPLOYMENT_FAILED: "Git 저장 후 Vercel 배포 실패",
    VERCEL_DEPLOYMENT_PENDING: "Vercel 배포 진행 중",
    SITE_SNAPSHOT_DIFFERS_REPOSITORY: "저장 데이터와 사이트 데이터가 아직 다름",
    SITE_COMMIT_DIFFERS_REPOSITORY: "조회한 저장소 커밋과 사이트 커밋이 다름",
    EXACT_DEPLOYMENT_EVIDENCE_MISSING: "현재 커밋·데이터의 실제 사이트 확인 기록 없음",
    IDENTITY_UNAVAILABLE: "기준일·데이터 해시·배포 커밋 확인 불가",
    HTTP_401: "사이트 검증 인증 실패 (401)", HTTP_403: "사이트 검증 접근 거부 (403)",
    REQUEST_TIMEOUT: "사이트 검증 응답 시간 초과", NETWORK_ERROR: "사이트 검증 네트워크 실패",
    HTTP_ERROR: "사이트 검증 HTTP 오류", NON_JSON_RESPONSE: "사이트 검증 응답 형식 오류",
    SNAPSHOT_HASH_MISMATCH: "같은 기준일의 데이터 내용이 일치하지 않음",
    SITE_COMMIT_MISMATCH: "사이트 배포 커밋 불일치", SITE_SUMMARY_UNAVAILABLE: "홈 또는 API 요약을 읽을 수 없음",
    REFERENCE_DATE_NOT_DEPLOYED: "사이트 기준일이 저장 기준일과 다름",
    GITHUB_401: "배포 증거 조회 인증 실패", GITHUB_403: "배포 증거 조회 제한 (403)",
    GITHUB_429: "배포 증거 조회 횟수 제한", GITHUB_TIMEOUT: "배포 증거 조회 시간 초과",
    GITHUB_EVIDENCE_EXPIRED: "배포 증거 조회 기록이 오래됨 · 다시 확인 필요",
    GITHUB_UNAVAILABLE: "배포 증거를 조회할 수 없음", GITHUB_INVALID_RESPONSE: "배포 증거 형식 확인 불가",
    LOCAL_STATUS_UNAVAILABLE: "사이트 저장 상태를 읽을 수 없음",
  })[reason] ?? (reason ? "확인 기록 없음 또는 검증 불가" : "없음");
}

// Historical four-endpoint verification cannot override a failed/mixed current
// Home read. Keep the historical timestamp, downgrade only the current badge.
export function homeOperationStatus(operations, home, performance, { homeError = false, performanceError = false } = {}) {
  if (operations?.deployment?.state !== "VERIFIED") return operations;
  const expected = operations.deployment.localIdentity;
  const matches = (identity) => expected && /^[a-f0-9]{64}$/u.test(expected.snapshotHash ?? "") && /^[a-f0-9]{40}$/u.test(expected.commitSha ?? "")
    && identity?.referenceDate === expected.referenceDate && identity?.snapshotHash === expected.snapshotHash && identity?.commitSha === expected.commitSha;
  const reason = homeError ? "CURRENT_HOME_READ_FAILED" : performanceError ? "CURRENT_PERFORMANCE_READ_FAILED"
    : !home || !performance ? "CURRENT_PAGE_LOADING"
    : home.publicationReady !== true || !home.models || performance.publicationReady !== true ? "CURRENT_PAGE_UNAVAILABLE"
    : !matches(home.dataIdentity) || !matches(performance.dataIdentity) ? "CURRENT_PAGE_IDENTITY_MISMATCH" : null;
  return reason ? { ...operations, deployment: { ...operations.deployment, state: "UNVERIFIED", reason } } : operations;
}
