"use client";

import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import Link from "next/link";
import type { ForecastSwingPreparingResponse } from "../lib/forecast-swing-view-types";

type Resource =
  | { status: "loading" }
  | { status: "success"; data: ForecastSwingPreparingResponse }
  | { status: "error"; kind: "auth" | "unavailable" | "request"; message: string };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const nullableString = (value: unknown) => value === null || typeof value === "string";
const count = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0;
const validOutcome = (value: unknown) => value === undefined || (isRecord(value)
  && ["OBSERVED", "PENDING", "BLOCKED", "NOT_EVALUATED"].includes(String(value.status))
  && Array.isArray(value.reasons) && value.reasons.every(reason => typeof reason === "string")
  && ["resolvedAt", "entryDate", "exitDate"].every(key => nullableString(value[key])) && value.netReturnPercent === null
  && (value.status === "OBSERVED" ? typeof value.benchmarkReturnPercent === "number" && Number.isFinite(value.benchmarkReturnPercent) : value.benchmarkReturnPercent === null));

/** Fail closed if another API shape or a numeric prediction reaches the preparing UI. */
export function validateForecastSwingResponse(value: unknown): ForecastSwingPreparingResponse {
  const fail = () => { throw new Error("예측 준비 상태를 확인할 수 없습니다. 잠시 후 다시 조회해 주세요."); };
  if (!isRecord(value)) return fail();
  const { model, horizon, prediction, observation, readiness, ledger, evaluation, daytrade } = value;
  if (value.schemaVersion !== 1 || value.observationPolicyId !== "intraday-1400-v1" || value.officialSignalTime !== "14:00:00" || value.status !== "PREPARING" || typeof value.generatedAt !== "string"
    || !isRecord(model) || typeof model.version !== "string" || model.trainingStatus !== "NOT_TRAINED" || model.externalValidationStatus !== "NOT_VALIDATED"
    || !isRecord(horizon) || horizon.tradingDays !== 5 || horizon.entryPolicy !== "NEXT_SESSION_OPEN_AFTER_ISSUANCE" || horizon.exitPolicy !== "FIFTH_SESSION_CLOSE"
    || !isRecord(prediction) || prediction.expectedReturnPercent !== null || prediction.lossProbability !== null || prediction.rangePercent !== null
    || !isRecord(observation) || !["AVAILABLE", "UNAVAILABLE"].includes(String(observation.status))
    || !["signalDate", "collectionStartedAt", "collectionCompletedAt", "availableAt", "ticker", "companyName", "observedAt"].every((key) => nullableString(observation[key]))
    || !(observation.referencePrice === null || (typeof observation.referencePrice === "number" && Number.isFinite(observation.referencePrice) && observation.referencePrice >= 0))
    || !count(observation.rowCount) || !count(observation.independentDateCount)
    || !isRecord(readiness) || readiness.status !== "BLOCKED" || readiness.eligibleForTraining !== false || !Array.isArray(readiness.blockers)
    || !readiness.blockers.every((blocker) => isRecord(blocker) && typeof blocker.code === "string" && typeof blocker.message === "string")
    || !isRecord(ledger) || !count(ledger.recordCount) || !Array.isArray(ledger.records) || (ledger.recordCount as number) < ledger.records.length || ledger.records.length > 20
    || !ledger.records.every((record) => isRecord(record) && typeof record.id === "string" && record.status === "PREPARING"
      && nullableString(record.issuedAt) && nullableString(record.ticker) && typeof record.modelVersion === "string"
      && (record.observedModels === undefined || (Array.isArray(record.observedModels) && record.observedModels.length <= 4 && record.observedModels.every(model => isRecord(model)
        && typeof model.modelVersion === "string" && (model.score === null || (typeof model.score === "number" && Number.isFinite(model.score)))
        && (model.rank == null || (Number.isSafeInteger(model.rank) && Number(model.rank) >= 1 && Number(model.rank) <= 5)))))
      && record.expectedReturnPercent === null && record.lossProbability === null && record.rangePercent === null && validOutcome(record.outcome))
    || !isRecord(evaluation) || !count(evaluation.mature5DayCount) || !count(evaluation.independentDateCount)
    || Number(evaluation.mature5DayCount) > Number(ledger.recordCount) || Number(evaluation.independentDateCount) > Number(evaluation.mature5DayCount)
    || evaluation.costStatus !== "UNKNOWN" || evaluation.costAdjustedReturnPercent !== null
    || !isRecord(daytrade) || daytrade.status !== "PREPARING" || typeof daytrade.reason !== "string") return fail();
  return value as ForecastSwingPreparingResponse;
}

export function formatForecastTimestamp(value: string | null) {
  if (!value) return "미확인";
  // A timestamp without an offset is kept as stored; never invent its time zone.
  if (!/(?:Z|[+-]\d{2}:\d{2})$/u.test(value)) return value;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "미확인";
  return `${new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(date)} KST`;
}

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return <div className="min-w-0 border-t border-slate-200/80 py-3 first:border-t-0"><dt className="text-xs text-slate-500">{label}</dt><dd className="mt-1 break-words text-sm font-medium text-slate-800">{children}</dd></div>;
}

function SectionTitle({ number, children }: { number: string; children: ReactNode }) {
  return <h2 className="flex items-center gap-3 text-base font-semibold tracking-tight"><span className="font-mono text-xs font-normal text-slate-400" aria-hidden="true">{number}</span>{children}</h2>;
}

function SavedResult({ outcome }: { outcome: import("../lib/forecast-swing-view-types").ForecastSwingLedgerRecord["outcome"] }) {
  if (!outcome) return <p className="mt-2 text-slate-500">후속 결과 자료 대기 · 판단 보류</p>;
  const labels = { OBSERVED: "공식 가격 비교 완료", PENDING: "5거래일 경과 대기", BLOCKED: "자료 부족 · 판단 보류", NOT_EVALUATED: "후속 결과 자료 대기" };
  return <div className="mt-2 text-slate-600"><p>{labels[outcome.status]}{outcome.status === "OBSERVED" && outcome.benchmarkReturnPercent !== null ? ` · 비용 전 관측 수익률 ${outcome.benchmarkReturnPercent.toFixed(2)}%` : ""}</p>
    <p className="mt-1">진입 기준일 {outcome.entryDate ?? "미확정"} → 평가 종료일 {outcome.exitDate ?? "미확정"}</p>
    <p className="mt-1">실제 체결·실현 성과 아님 · 비용 차감 수익률 미확정</p>
    {outcome.reasons.length > 0 && <details className="mt-1"><summary className="cursor-pointer">보류 사유</summary><ul>{outcome.reasons.map(reason => <li key={reason}>{reason}</li>)}</ul></details>}
  </div>;
}

export function ForecastSwingPreparingView({ data }: { data: ForecastSwingPreparingResponse }) {
  const { observation, model, evaluation, ledger, readiness } = data;
  const hasObservation = observation.status === "AVAILABLE";
  return (
    <div className="space-y-5">
      <section aria-labelledby="forecast-preparing-title" className="overflow-hidden rounded-2xl border border-[#28334a] bg-[#101d35] text-white shadow-sm">
        <div className="grid gap-7 px-5 py-6 sm:px-7 lg:grid-cols-[1.2fr_1fr] lg:gap-10 lg:py-8">
          <div>
            <div className="mb-4 flex flex-wrap items-center gap-2 text-[11px] font-medium tracking-wide"><span className="rounded-full border border-amber-200/30 bg-amber-200/10 px-2.5 py-1 text-amber-100">PREPARING · 준비 중</span><span className="text-slate-400">학습 · 외부 검증 전</span></div>
            <h2 id="forecast-preparing-title" className="text-2xl font-semibold tracking-tight sm:text-3xl">지금은 판단을 보류합니다.</h2>
            <p className="mt-3 max-w-lg text-sm leading-7 text-slate-300">5거래일 수익률을 추정할 학습·검증 근거가 아직 부족합니다. 저장된 관측만 확인할 수 있으며, 예측값은 제공하지 않습니다.</p>
          </div>
          <div className="grid grid-cols-3 gap-2 self-center border-t border-white/10 pt-5 lg:border-l lg:border-t-0 lg:pl-7 lg:pt-0">
            {[["기대 수익률", "expected-return"], ["손실 확률", "loss-probability"], ["예측 범위", "prediction-range"]].map(([label, id]) => <div key={id} className="min-w-0"><p className="text-xs leading-5 text-slate-300">{label}</p><p data-testid={id} className="my-3 text-3xl font-light text-slate-200" aria-label={`${label} 미산출`}>—</p><span className="text-[11px] text-slate-400">판단 보류</span></div>)}
          </div>
        </div>
        <div className="border-t border-white/10 bg-white/[0.025] px-5 py-3 text-xs leading-5 text-slate-400 sm:px-7">관측 참고가격은 체결가가 아닙니다. 기존 A–D 순위 점수를 수익률이나 확률로 변환하지 않습니다.</div>
      </section>

      {!hasObservation && <div role="status" className="rounded-xl border border-slate-300 bg-white/70 px-5 py-4"><p className="text-sm font-semibold">{data.ledger.recordCount > 0 ? "최신 관측 요약은 연결되지 않았습니다." : "저장 관측이 없습니다."}</p><p className="mt-1 text-xs leading-6 text-slate-600">{data.ledger.recordCount > 0 ? "아래의 고정 저장 기록은 조회할 수 있습니다. 기록의 존재를 최신 LIVE 게시 성공으로 간주하지 않습니다." : "조회 조건에 맞는 자료를 찾지 못했습니다. 다른 종목코드로 조회하거나 저장 관측 전체를 확인해 주세요."}</p></div>}

      <div className="grid items-start gap-5 lg:grid-cols-[1.4fr_1fr]">
        <section aria-label="저장 관측 정보" className="rounded-2xl border border-slate-300/80 bg-[#faf9f5] p-5 sm:p-6">
          <SectionTitle number="01">저장 관측</SectionTitle>
          <div className="mb-5 mt-5 flex flex-wrap items-start justify-between gap-4">
            <div><p className="text-lg font-semibold">{hasObservation ? (observation.companyName ?? "종목 미확인") : "조회 가능한 관측 없음"}</p><p className="mt-1 font-mono text-xs text-slate-500">{observation.ticker ?? "—"}</p></div>
            <div className="text-right"><p className="text-xs text-slate-500">관측 참고가격 · 체결가 아님</p><p data-testid="reference-price" className="mt-1 text-xl font-semibold tabular-nums">{observation.referencePrice === null ? "—" : `${observation.referencePrice.toLocaleString("ko-KR")}원`}</p></div>
          </div>
          <dl className="grid gap-x-6 sm:grid-cols-2">
            <Detail label="관측 기준일">{observation.signalDate ?? "미확인"}</Detail>
            <Detail label="14:00 관측창의 실제 시각">{formatForecastTimestamp(observation.observedAt)}</Detail>
            <Detail label="수집 시작">{formatForecastTimestamp(observation.collectionStartedAt)}</Detail>
            <Detail label="수집 완료">{formatForecastTimestamp(observation.collectionCompletedAt)}</Detail>
            <Detail label="입력 사용 가능 시각 (availableAt)">{formatForecastTimestamp(observation.availableAt)}</Detail>
            <Detail label="모델 버전"><span className="font-mono text-xs">{model.version}</span></Detail>
          </dl>
          <p className="mt-3 rounded-lg bg-slate-100 px-3 py-3 text-xs leading-6 text-slate-600">저장 관측 {observation.rowCount.toLocaleString("ko-KR")}행 · 서로 다른 관측일 {observation.independentDateCount.toLocaleString("ko-KR")}일. 종목별 행을 독립 표본으로 세지 않으며, 날짜 간 중첩과 상관도 별도로 검증합니다.</p>
        </section>

        <section aria-label="예측 준비 상태" className="rounded-2xl border border-slate-300/80 bg-[#faf9f5] p-5 sm:p-6">
          <div className="flex items-center justify-between gap-3"><SectionTitle number="02">예측 준비 상태</SectionTitle><span className="rounded-full bg-[#eee5d4] px-2.5 py-1 text-[10px] font-semibold text-[#795a25]">학습 불가</span></div>
          <dl className="my-4 grid grid-cols-2 gap-4 border-b border-slate-200 pb-5"><div><dt className="text-xs text-slate-500">모델 학습</dt><dd className="mt-2 text-sm font-semibold">미학습</dd></div><div><dt className="text-xs text-slate-500">외부 검증</dt><dd className="mt-2 text-sm font-semibold">미검증</dd></div></dl>
          <p className="mb-3 text-xs font-medium text-slate-500">해결해야 할 조건</p>
          <ul className="space-y-3">{readiness.blockers.map((blocker, index) => <li key={`${blocker.code}-${index}`} className="flex items-start gap-2.5 text-sm leading-6 text-slate-700"><span aria-hidden="true" className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-[#a97c3c]" /><span>{blocker.message}</span></li>)}</ul>
          <p className="mt-5 border-t border-slate-200 pt-4 text-xs leading-6 text-slate-500">조건이 충족되기 전에는 예측을 발행하지 않습니다.</p>
        </section>
      </div>

      <section aria-label="5거래일 평가 기준" className="rounded-2xl border border-slate-300/80 bg-[#faf9f5] p-5 sm:p-6">
        <SectionTitle number="03">5거래일 평가 기준</SectionTitle>
        <div className="mt-5 grid gap-5 md:grid-cols-3">
          <div><p className="text-xs font-medium text-[#9a6246]">진입 기준</p><p className="mt-2 text-sm font-semibold">발행 후 첫 거래 세션 시가</p><p className="mt-2 text-xs leading-6 text-slate-500">진입 시각은 발행 시각보다 엄격히 늦어야 합니다. 실제 진입가는 아직 없습니다.</p></div>
          <div className="border-t border-slate-200 pt-4 md:border-l md:border-t-0 md:pl-5 md:pt-0"><p className="text-xs font-medium text-[#9a6246]">청산 기준</p><p className="mt-2 text-sm font-semibold">진입일을 1일로 센 5번째 거래일 종가</p><p className="mt-2 text-xs leading-6 text-slate-500">예정일이 지났다는 이유만으로 평가 완료로 처리하지 않습니다. 확정 가격과 사용 가능 시각이 필요합니다.</p></div>
          <div className="border-t border-slate-200 pt-4 md:border-l md:border-t-0 md:pl-5 md:pt-0"><p className="text-xs font-medium text-[#9a6246]">비용 · 순수익률</p><p className="mt-2 text-sm font-semibold">거래비용 미확인 · 순수익률 —</p><p className="mt-2 text-xs leading-6 text-slate-500">수수료·세금·슬리피지가 확정되지 않아 비용 차감 수익률을 산출하지 않습니다.</p></div>
        </div>
      </section>

      <section aria-label="읽기 전용 예측 기록" className="overflow-hidden rounded-2xl border border-slate-300/80 bg-[#faf9f5]">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 p-5 sm:px-6"><SectionTitle number="04">예측 기록</SectionTitle><span className="text-xs text-slate-500">읽기 전용 · 준비 기록 {ledger.records.length < ledger.recordCount ? `최근 ${ledger.records.length}건 / 전체 ${ledger.recordCount}건` : `${ledger.recordCount}건`}</span></div>
        {ledger.records.length === 0 ? <div className="px-5 py-10 text-center"><span aria-hidden="true" className="mx-auto mb-4 flex h-10 w-10 items-center justify-center rounded-xl border border-slate-200 font-mono text-lg text-slate-400">≡</span><p className="text-sm font-semibold">발행된 예측이 없습니다.</p><p className="mx-auto mt-2 max-w-lg text-xs leading-6 text-slate-500">준비 기록은 실제 예측·검증 성과가 아닙니다. 화면 조회는 예측을 생성하지 않습니다.</p></div> : <ul className="divide-y divide-slate-200 px-5 sm:px-6">{ledger.records.map((record) => <li key={record.id} className="flex flex-wrap justify-between gap-3 py-4 text-xs"><div><p className="font-medium">{record.ticker ?? "종목 미확인"} · 준비 기록 · 예측 미발행</p><p className="mt-1 text-slate-500">준비 기록 시각 {formatForecastTimestamp(record.issuedAt)} · {record.modelVersion}</p>
          {record.observedModels?.length ? <p className="mt-2 leading-6 text-slate-600">선정 근거: {record.observedModels.map(model => `${model.modelVersion}${model.rank == null ? "" : ` ${model.rank}위`} · ${model.score == null ? "점수 미확인" : `${model.score.toFixed(2)}점`}`).join(" / ")}<br />동일 종목의 모델별 선정은 독립 표본이 아닙니다.</p> : null}
          <SavedResult outcome={record.outcome} /></div><span className="text-slate-500">기대 수익률 — · 손실 확률 — · 범위 —</span></li>)}</ul>}
        <div className="grid grid-cols-2 gap-4 border-t border-slate-200 bg-slate-100/60 px-5 py-4 text-xs sm:flex sm:gap-8 sm:px-6"><p className="text-slate-500">5거래일 평가 완료 <span className="ml-1 font-semibold text-slate-800">{evaluation.mature5DayCount}건</span></p><p className="text-slate-500">평가 날짜 묶음 <span className="ml-1 font-semibold text-slate-800">{evaluation.independentDateCount}일</span></p></div>
      </section>
      <footer className="flex flex-col gap-2 px-1 text-[11px] leading-5 text-slate-500 sm:flex-row sm:justify-between"><p>단타 준비 중 · {data.daytrade.reason}</p><p>상태 조회 시각 {formatForecastTimestamp(data.generatedAt)}</p></footer>
    </div>
  );
}

export default function ForecastSwingPanel() {
  const [query, setQuery] = useState("");
  const [request, setRequest] = useState({ code: "", version: 0 });
  const [validationError, setValidationError] = useState<string | null>(null);
  const [resource, setResource] = useState<Resource>({ status: "loading" });
  const requestIdRef = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    controllerRef.current = controller;
    const requestId = ++requestIdRef.current;
    const isCurrent = () => !controller.signal.aborted && requestId === requestIdRef.current;
    async function load() {
      try {
        const response = await fetch(`/api/forecasts/swing${request.code ? `?code=${encodeURIComponent(request.code)}` : ""}`, { signal: controller.signal, cache: "no-store", credentials: "same-origin" });
        if (!isCurrent()) return;
        if (!response.ok) {
          const kind = response.status === 401 ? "auth" : response.status === 503 ? "unavailable" : "request";
          const message = kind === "auth" ? "로그인이 필요합니다. 다시 로그인한 뒤 조회해 주세요." : kind === "unavailable" ? "현재 준비 상태를 확인할 수 없습니다. 잠시 후 다시 조회해 주세요." : "저장 자료 조회에 실패했습니다. 다시 시도해 주세요.";
          setResource({ status: "error", kind, message });
          return;
        }
        const data = validateForecastSwingResponse(await response.json());
        if (request.code && data.observation.ticker !== request.code) throw new Error("OBSERVATION_CODE_MISMATCH");
        if (isCurrent()) setResource({ status: "success", data });
      } catch {
        if (isCurrent()) setResource({ status: "error", kind: "request", message: "저장 자료 조회에 실패했습니다. 다시 시도해 주세요." });
      }
    }
    void load();
    return () => { controller.abort(); if (controllerRef.current === controller) controllerRef.current = null; };
  }, [request]);

  function requestCode(code: string) {
    // Invalidate immediately, including the interval before the next effect runs.
    requestIdRef.current += 1;
    controllerRef.current?.abort();
    setResource({ status: "loading" });
    setValidationError(null);
    setRequest((previous) => ({ code, version: previous.version + 1 }));
  }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const code = query.trim().toUpperCase();
    if (code && !/^[0-9A-Z]{6}$/u.test(code)) { setValidationError("종목코드 6자리를 입력해 주세요. 비워 두면 저장 관측 전체를 조회합니다."); return; }
    requestCode(code);
  }

  return <div>
    <div className="mb-7 flex flex-col justify-between gap-5 lg:flex-row lg:items-end">
      <div><p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-[#93674f]">Forecast workspace</p><h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">스윙 예측</h1><p className="mt-3 text-sm leading-6 text-slate-600">예측에 앞서, 관측과 검증의 준비 상태를 확인합니다.</p></div>
      <form onSubmit={submit} className="w-full lg:max-w-sm" aria-label="저장 관측 종목 조회">
        <label htmlFor="forecast-stock-code" className="mb-2 block text-xs font-medium text-slate-600">저장 관측 조회 · 종목코드 6자리</label>
        <div className="flex gap-2"><input id="forecast-stock-code" value={query} onChange={(event) => setQuery(event.target.value)} inputMode="text" autoComplete="off" maxLength={6} placeholder="종목코드 입력" aria-describedby="forecast-query-help" aria-invalid={Boolean(validationError)} className="min-w-0 flex-1 rounded-lg border border-slate-300 bg-[#faf9f5] px-3 py-2.5 text-sm outline-offset-2 focus:outline-2 focus:outline-[#a95835]" /><button type="submit" className="rounded-lg bg-[#24324a] px-4 py-2.5 text-xs font-semibold text-white hover:bg-[#354560]">조회</button></div>
        <p id="forecast-query-help" className={`mt-2 text-[11px] leading-5 ${validationError ? "text-red-700" : "text-slate-500"}`} role={validationError ? "alert" : undefined}>{validationError ?? "비워 두면 저장 관측 전체를 조회합니다."}</p>
      </form>
    </div>
    <div className="mb-5 flex flex-wrap items-center justify-between gap-3 border-b border-slate-300">
      <div className="flex items-stretch gap-5" aria-label="예측 기간"><span aria-current="page" className="border-b-2 border-[#a95835] pb-3 text-sm font-semibold text-[#8b4b2c]">5거래일 스윙</span><span aria-disabled="true" className="pb-3 text-sm text-slate-500">단타 <span className="ml-1 rounded bg-slate-200 px-1.5 py-0.5 text-[10px]">준비 중 · 분봉 없음</span></span></div>
      <button type="button" onClick={() => requestCode(request.code)} className="mb-3 rounded px-1 py-0.5 text-xs font-medium text-slate-600 hover:text-slate-950">상태 다시 조회 <span aria-hidden="true">↻</span></button>
    </div>
    {request.code && <div className="mb-4 flex items-center gap-3 text-xs text-slate-600"><p>조회 조건 <span className="font-mono font-semibold">{request.code}</span></p><button type="button" onClick={() => { setQuery(""); requestCode(""); }} className="rounded underline underline-offset-4">전체 관측 보기</button></div>}
    <div aria-live="polite" aria-busy={resource.status === "loading"}>
      {resource.status === "loading" && <section role="status" className="rounded-2xl border border-slate-300 bg-[#faf9f5] px-6 py-16 text-center"><p className="text-sm font-semibold">저장 관측과 준비 상태를 불러오는 중입니다.</p><p className="mt-3 text-xs text-slate-500">조회가 끝나기 전에는 이전 종목의 자료를 표시하지 않습니다.</p></section>}
      {resource.status === "error" && <section role="alert" className="rounded-2xl border border-amber-300/70 bg-amber-50 px-6 py-8"><h2 className="text-base font-semibold">준비 상태 조회를 완료하지 못했습니다.</h2><p className="mt-2 text-sm leading-6 text-slate-600">{resource.message}</p><div className="mt-5 flex gap-4"><button type="button" onClick={() => requestCode(request.code)} className="rounded-lg bg-[#24324a] px-4 py-2 text-xs font-semibold text-white">다시 시도</button>{resource.kind === "auth" && <Link href="/login" prefetch={false} className="rounded-lg border border-slate-300 px-4 py-2 text-xs font-semibold">로그인</Link>}</div></section>}
      {resource.status === "success" && <ForecastSwingPreparingView data={resource.data} />}
    </div>
  </div>;
}
