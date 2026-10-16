"use client";

import { CURRENT_LIVE_PROFILE } from "../lib/intraday-model-top-time-policy.mjs";
import { useEffect, useState } from "react";
import { transitionLabel } from "../lib/directional-transition.mjs";
import { LiveTransitionMetadata, LiveTransitionRules, TransitionModeSelector, liveNumber, livePrice, liveQuoteStamp, liveStatusLabel, type LiveTransitionResponse, type LiveTransitionStatus, type TransitionMode } from "./LiveTransitionDetails";
import { useLiveTransitionRevalidation } from "./useLiveTransitionRevalidation";

type Stock = { code: string; name: string; market?: string };
type TransitionState = { direction?: string; state: string; count: number | null; examples: Stock[] };
export type HomeEodTransitions = { referenceDate: string; indicatorCoverage: number; totalUniverse: number; sourceQualityGrade: string; pairs: { pair: string; states: TransitionState[]; directionalStates?: TransitionState[] }[] };
export type HomeTransitionNavigation = (pair: string, state: string, direction?: string, mode?: TransitionMode) => void;
export type HomeLiveTransitionPair = LiveTransitionResponse & { pair: "5-20" | "20-60"; source: { signalContentHash: string; seedContentHash: string; normalizedInputHash: string; isRealtime: false } };
type Actions = { onSelectStock: (stock: Stock) => void | Promise<void>; onOpenTransition: HomeTransitionNavigation };
const PAIRS = ["5-20", "20-60"] as const;
const STATUSES: LiveTransitionStatus[] = ["CROSS_OCCURRED", "APPROACHING", "ALREADY_ABOVE", "NONE"];
const INVALID_RESPONSE = "LIVE 관측 자료의 기준일·이평선 조합·개별 품질을 검증하지 못해 홈 집계를 표시할 수 없습니다.";
const MIXED_RESPONSE = "두 이평선 조합의 TOP LIVE 관측·확정 일봉 원천이 일치하지 않아 홈 집계를 표시할 수 없습니다. 다시 조회해 주세요.";
const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const date = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const count = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

// Validate response identity only. Signal math and status classification remain
// owned by the existing LIVE screener API.
export function validateHomeLiveTransitionResponses(value: unknown): [HomeLiveTransitionPair, HomeLiveTransitionPair] {
  if (!Array.isArray(value) || value.length !== PAIRS.length) throw new Error(INVALID_RESPONSE);
  for (const [index, input] of value.entries()) {
    const response = record(input), source = record(response?.source), exclusions = record(response?.exclusions);
    if (!response || response.mode !== "LIVE" || response.pair !== PAIRS[index] || response.nearPercent !== 1
      || !date(response.referenceDate) || !date(response.previousOfficialDate) || response.modelReferenceDate !== response.previousOfficialDate
      || response.previousOfficialDate >= response.referenceDate || response.snapshotTime !== CURRENT_LIVE_PROFILE.signalTime || response.signalVersion !== CURRENT_LIVE_PROFILE.signalVersion || response.observationPolicyId !== CURRENT_LIVE_PROFILE.policyId || !text(response.ruleVersion)
      || !text(response.collectionStartedAt) || !Number.isFinite(Date.parse(response.collectionStartedAt))
      || !text(response.collectionCompletedAt) || !Number.isFinite(Date.parse(response.collectionCompletedAt))
      || !source || !text(source.signalContentHash) || !text(source.seedContentHash) || !text(source.normalizedInputHash) || source.isRealtime !== false
      || !count(response.totalUniverse) || !count(response.indicatorCoverage) || !text(response.sourceQualityGrade) || typeof response.isPartialRanking !== "boolean"
      || !exclusions || !count(exclusions.dataMissing) || !count(exclusions.conditionNotMet)
      || !Array.isArray(response.results) || response.resultCount !== response.results.length) throw new Error(INVALID_RESPONSE);
    const codes = new Set<string>();
    for (const inputRow of response.results) {
      const row = record(inputRow);
      if (!row || !text(row.code) || codes.has(row.code) || !text(row.name) || !text(row.market)
        || row.pair !== response.pair || row.referenceDate !== response.referenceDate || row.modelReferenceDate !== response.modelReferenceDate
        || row.qualityStatus !== "PROVISIONAL" || !Array.isArray(row.missingReasons) || row.missingReasons.length !== 0
        || !STATUSES.includes(row.status as LiveTransitionStatus) || !finite(row.observedPrice) || row.observedPrice <= 0
        || !finite(row.crossRequiredPrice) || !finite(row.requiredAdditionalRisePercent) || row.requiredAdditionalRisePercent < 0
        || row.quoteAsOfDate !== response.referenceDate || typeof row.quoteAsOfTime !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/u.test(row.quoteAsOfTime)
        || !text(row.receivedAt) || !Number.isFinite(Date.parse(row.receivedAt))) throw new Error(INVALID_RESPONSE);
      codes.add(row.code);
    }
  }
  const responses = value as [HomeLiveTransitionPair, HomeLiveTransitionPair];
  const [first, second] = responses;
  if (["signalVersion", "observationPolicyId", "referenceDate", "previousOfficialDate", "modelReferenceDate", "snapshotTime", "collectionStartedAt", "collectionCompletedAt", "ruleVersion"]
    .some((key) => first[key as keyof HomeLiveTransitionPair] !== second[key as keyof HomeLiveTransitionPair])
    || first.source.signalContentHash !== second.source.signalContentHash || first.source.seedContentHash !== second.source.seedContentHash
    || first.source.normalizedInputHash !== second.source.normalizedInputHash) throw new Error(MIXED_RESPONSE);
  return responses;
}

function StockButton({ stock, onSelectStock }: { stock: Stock; onSelectStock: Actions["onSelectStock"] }) {
  return <button type="button" onClick={() => void onSelectStock({ code: stock.code, name: stock.name, market: stock.market })} className="tb-focus min-w-0 rounded text-left hover:text-[var(--tb-orange)]"><span className="block truncate font-medium">{stock.name}</span><span className="text-[10px] text-slate-600">{stock.code}</span></button>;
}

export default function HomeTransitionCard({ transitions, onSelectStock, onOpenTransition, eodError = false }: Actions & { transitions: HomeEodTransitions | null; eodError?: boolean }) {
  const [mode, setMode] = useState<TransitionMode>("LIVE");
  const { rootRef, refreshVersion } = useLiveTransitionRevalidation(mode === "LIVE");
  return <section ref={rootRef} className="tb-card min-w-0 p-4" aria-labelledby="home-transition-heading">
    <h2 id="home-transition-heading" className="text-base font-semibold">전환 신호 · {mode === "LIVE" ? "LIVE 장중 잠정" : "EOD 확정 일봉"}</h2>
    <div className="mt-3"><TransitionModeSelector mode={mode} onChange={setMode} label="홈 전환 신호 데이터 기준" /></div>
    {mode === "LIVE" ? <>
      <p className="mt-3 text-xs leading-relaxed text-amber-800">TOP LIVE의 저장된 14:00 관측 스냅샷입니다. 실시간 스트리밍이 아니며, 장중 또는 종가에서 신호가 되돌아갈 수 있습니다.</p>
      <p className="mt-2 text-xs text-slate-600">근접 기준: 교차 경계까지 필요 추가 상승률 1% 이하 · 연구용 탐색 조건이며 검증된 확률이 아닙니다.</p>
      <HomeLiveTransitionResults key={refreshVersion} onSelectStock={onSelectStock} onOpenTransition={onOpenTransition} />
      <LiveTransitionRules nearPercent={1} />
    </> : <HomeEodTransitionSummary transitions={transitions} eodError={eodError} onSelectStock={onSelectStock} onOpenTransition={onOpenTransition} />}
  </section>;
}

export function HomeLiveTransitionResults({ onSelectStock, onOpenTransition }: Actions) {
  const [responses, setResponses] = useState<[HomeLiveTransitionPair, HomeLiveTransitionPair] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void Promise.all(PAIRS.map(async (pair) => {
      const query = new URLSearchParams({ tab: "transition", mode: "LIVE", pair, state: "all", nearPercent: "1" });
      const response = await fetch(`/api/screener?${query}`, { cache: "no-store", signal: controller.signal });
      const body: unknown = await response.json();
      if (!response.ok) {
        const message = record(record(body)?.error)?.message;
        throw new Error(text(message) ? message : "LIVE 전환 신호를 불러오지 못했습니다.");
      }
      return body;
    })).then((body) => {
      if (!controller.signal.aborted) setResponses(validateHomeLiveTransitionResponses(body));
    }).catch((caught: unknown) => {
      if (!controller.signal.aborted) {
        setError(caught instanceof Error ? caught.message : "LIVE 전환 신호를 불러오지 못했습니다.");
        controller.abort();
      }
    });
    return () => controller.abort();
  }, []);
  if (error) return <div role="alert" className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs leading-relaxed text-amber-900"><p className="font-semibold">LIVE 조회 불가</p><p className="mt-1">{error}</p><p className="mt-2">위의 EOD · 확정 일봉 비교에서 별도로 확인할 수 있습니다.</p></div>;
  if (!responses) return <p role="status" className="py-4 text-xs text-slate-600">두 이평선 조합의 저장된 LIVE 관측 자료 확인 중</p>;
  return <HomeLiveTransitionSummary responses={responses} onSelectStock={onSelectStock} onOpenTransition={onOpenTransition} />;
}

export function HomeLiveTransitionSummary({ responses, onSelectStock, onOpenTransition }: Actions & { responses: [HomeLiveTransitionPair, HomeLiveTransitionPair] }) {
  return <div aria-label="홈 LIVE 전환 집계">
    <LiveTransitionMetadata data={responses[0]} />
    {responses.map((response) => {
      const groups = STATUSES.map((status) => ({ status, rows: response.results.filter((row) => row.status === status) }));
      const examples = groups.slice(0, 2).flatMap((group) => group.rows.slice(0, 1));
      const quoteTimes = response.results.map((row) => row.quoteAsOfTime).sort();
      return <div key={response.pair} className="mt-4 border-t border-slate-200 pt-3">
        <h3 className="text-sm font-semibold text-slate-900">{response.pair.replace("-", "/")}일 이동평균선</h3>
        <p className="mt-1 text-[11px] text-slate-600">입력 검증 통과 {response.resultCount}종목 기준 · 데이터 부족 제외 {response.exclusions.dataMissing}종목</p>
        <p className="mt-1 text-[11px] text-slate-600">실제 시세 시각 {quoteTimes.length ? `${quoteTimes[0]}${quoteTimes.at(-1) !== quoteTimes[0] ? ` ~ ${quoteTimes.at(-1)}` : ""} KST` : "검증 가능한 관측 없음"}</p>
        <div className="mt-2 grid grid-cols-2 gap-2">{groups.map(({ status, rows }) => <button key={status} type="button" onClick={() => onOpenTransition(response.pair, status, "golden", "LIVE")} className="tb-focus min-w-0 rounded-lg bg-[#f7f3eb] px-2 py-2 text-left text-xs hover:bg-orange-50"><span className="block font-medium text-slate-800">{liveStatusLabel(status)}</span><span className="mt-1 block font-semibold text-[var(--tb-orange)]">{rows.length}종목 →</span></button>)}</div>
        {examples.length ? <div className="mt-3 space-y-2" aria-label={`${response.pair} 대표 LIVE 후보`}>{examples.map((row) => <article key={row.code} className="rounded-lg border border-slate-200 p-3 text-xs">
          <div className="flex flex-wrap items-start justify-between gap-2"><StockButton stock={row} onSelectStock={onSelectStock} /><p className="text-[11px] text-orange-800">{liveStatusLabel(row.status)}</p></div>
          <p className="mt-2 text-[11px] text-slate-600">실제 시세 {liveQuoteStamp(row)}</p>
          <dl className="mt-2 grid grid-cols-2 gap-2"><div><dt className="text-slate-500">관측가</dt><dd className="mt-0.5 font-semibold tabular-nums">{livePrice(row.observedPrice)}</dd></div><div><dt className="text-slate-500">필요 추가 상승률</dt><dd className="mt-0.5 font-semibold tabular-nums">{liveNumber(row.requiredAdditionalRisePercent, "%")}</dd></div><div className="col-span-2"><dt className="text-slate-500">교차 경계가 초과</dt><dd className="mt-0.5 tabular-nums">약 {livePrice(row.crossRequiredPrice, 4)} 초과 (참고 경계)</dd></div></dl>
        </article>)}</div> : <p className="mt-3 text-xs text-slate-600">검증 가능한 종목 중 골든크로스 진입·근접 후보가 없습니다.</p>}
      </div>;
    })}
    <p className="mt-3 text-[10px] leading-relaxed text-slate-600">표시 경계가는 참고용 반올림 값입니다. 엄격 교차는 관측가가 원래 계산된 경계가를 초과해야 합니다. 주문 가능한 최소 가격·매수 추천이 아닙니다.</p>
  </div>;
}

export function HomeEodTransitionSummary({ transitions, onSelectStock, onOpenTransition, eodError = false }: Actions & { transitions: HomeEodTransitions | null; eodError?: boolean }) {
  return <div aria-label="홈 EOD 전환 집계">
    <p className="mt-3 text-xs text-slate-600">{transitions ? transitions.referenceDate + " · 확정 일봉 지표 " + transitions.indicatorCoverage + "/" + transitions.totalUniverse : eodError ? "확정 일봉 전환 지표 조회 실패" : "전환 지표 데이터 없음"}</p>
    {transitions?.pairs.map((pair) => <div key={pair.pair} className="mt-3"><h3 className="mb-1 text-xs font-medium">{pair.pair.replace("-", "/")}일 이동평균선</h3><div className="grid grid-cols-2 gap-1">{(pair.directionalStates ?? pair.states.map((state) => ({ ...state, direction: "golden" }))).map((state) => <div key={state.direction + ":" + state.state} className="min-w-0 rounded-lg bg-[#f7f3eb] px-2 py-2 text-xs"><button type="button" onClick={() => onOpenTransition(pair.pair, state.state, state.direction, "EOD")} className="tb-focus w-full rounded text-left hover:text-[var(--tb-orange)]"><span className="block font-medium">{transitionLabel(state.direction, state.state)}</span><span className="mt-1 block text-[var(--tb-orange)]">{state.count === null ? "확인 불가" : state.count + "종목"} →</span></button>{state.examples[0] ? <div className="mt-1 truncate text-[10px] text-slate-600"><StockButton stock={state.examples[0]} onSelectStock={onSelectStock} /></div> : <p className="mt-1 text-[10px] text-slate-600">{state.count === 0 ? "해당 조건 종목 없음" : "대표 종목 없음"}</p>}</div>)}</div></div>)}
    <p className="mt-2 text-[10px] text-slate-600">연구 규칙 · 매수 추천 아님{transitions ? " · 원천 품질 " + transitions.sourceQualityGrade : ""}</p>
  </div>;
}
