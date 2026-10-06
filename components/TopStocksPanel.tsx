"use client";

import { useEffect, useRef, useState } from "react";
import { TOP_INTRADAY_POLL_MS, toTopIntradayOverlay } from "../lib/top-stocks-intraday-overlay.mjs";

type ModelId = "A" | "B" | "C" | "D";
type TopStock = {
  rank: number;
  code: string;
  name: string;
  market: string;
  score: number;
  closePrice: number;
  priceBasis: "officialDailyClose";
  priceAsOfDate: string;
  rankingUniverseCount?: number;
  rankPercentile?: number;
};
type TopStocksResponse = {
  dataMode: "historySnapshot";
  model: ModelId;
  modelName: string;
  modelVersion: string | null;
  modelRole?: "champion" | "challenger";
  promotionStatus?: "notApproved";
  rankingAsOfDate: string;
  priceAsOfDate: string;
  priceBasis: "officialDailyClose";
  generatedAt: string;
  count: number;
  stocks: TopStock[];
  dataQualityGrade?: string;
  structuralStatus?: string;
  eligibleForRankBacktest?: boolean;
  sourceManifestVersion?: number | null;
  freshness?: { snapshotReferenceDate: string | null; observedOfficialDate: string | null; freshnessStatus: "fresh" | "stale" | "unavailable"; freshnessReason: string | null; updatedAt: string };
  originalUniverseCount?: number;
  qualityEligibleUniverseCount?: number;
  rankingUniverseCount?: number;
  quarantinedCount?: number;
  isPartialRanking?: boolean;
  exclusionPolicyVersion?: string;
};

type StockSelection = { code: string; name: string };
type TopStocksPanelProps = { onSelectStock?: (stock: StockSelection) => void | Promise<void>; compact?: boolean; onOpenFull?: () => void };
type IntradayOverlay = { code: string; status: "available"; price: number; rate: number | null; asOfDate: string | null; asOfTime: string | null; receivedAt: string | null; source: "KIS" | null } | { code: string; status: "unavailable" };

const primaryTabs = [
  { id: "B", model: "B" as const, label: "모델 B · 추세 강도" },
  { id: "C", model: "C" as const, label: "모델 C · 진입 강도" },
];
const researchTabs = [
  { id: "A-v1", model: "A" as const, label: "A-v1 · 기존 기술 강도 · 연구 보존" },
  { id: "A-v2", model: "A" as const, version: "A-v2" as const, label: "A-v2 · 기술 강도 · 검증 중" },
  { id: "D", model: "D" as const, label: "D-v1 · 결합 점수 · 연구 보존" },
];
const tabs = [...primaryTabs, ...researchTabs];
const compactTabs = [
  { id: "A-v1", label: "A" },
  { id: "B", label: "B" },
  { id: "C", label: "C" },
  { id: "D", label: "D" },
];
const modelDescriptions: Record<string, string> = {
  B: "가격 추세와 기술적 흐름을 중심으로 보는 순위입니다.",
  C: "현재 진입 조건의 상대적 강도를 중심으로 보는 순위입니다.",
  "A-v1": "기존 기술적 강도 공식을 보존한 연구 순위입니다.",
  "A-v2": "범위를 제한한 기술적 강도 후보 모델의 연구 순위입니다.",
  D: "여러 기술 신호를 결합해 비교하는 연구 순위입니다.",
};
const shortReferenceDate = (value: string) => {
  const parts = value.split("-");
  return parts.length === 3 ? `${Number(parts[1])}/${Number(parts[2])}` : value;
};

export default function TopStocksPanel({ onSelectStock, compact = false, onOpenFull }: TopStocksPanelProps) {
  const [activeTab, setActiveTab] = useState("B");
  const [selectingCode, setSelectingCode] = useState<string | null>(null);
  const [data, setData] = useState<TopStocksResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [requestVersion, setRequestVersion] = useState(0);
  const [intradayByCode, setIntradayByCode] = useState<Record<string, IntradayOverlay>>({});
  const intradayRequestVersionRef = useRef(0);
  const freshnessMessage = data?.freshness?.freshnessStatus === "stale"
    ? `최신 공식 일봉(${data.freshness.observedOfficialDate ?? "기준일 확인됨"}) 기준 순위 생성이 아직 완료되지 않았습니다. 현재 순위는 ${data.rankingAsOfDate} 기준입니다.`
    : data?.freshness?.freshnessStatus === "unavailable"
      ? `최신 공식 일봉 기준일을 확인할 수 없습니다. 현재 순위는 ${data.rankingAsOfDate} 기준입니다.`
      : null;

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      setLoading(true);
      setError(null);
      setData(null);
      try {
        const selectedTab = tabs.find((tab) => tab.id === activeTab) ?? tabs[0];
        const selectedVersion = "version" in selectedTab ? selectedTab.version : undefined;
        const versionQuery = selectedVersion ? `&version=${selectedVersion}` : "";
        const response = await fetch(`/api/top-stocks?model=${selectedTab.model}${versionQuery}&limit=${compact ? 5 : 50}`, { cache: "no-store", signal: controller.signal });
        const result = await response.json();
        if (!response.ok) throw new Error(result?.error?.message ?? "실제 TOP50 데이터를 불러오지 못했습니다.");
        if (result.dataMode !== "historySnapshot" || result.model !== selectedTab.model) throw new Error("TOP50 응답의 데이터 모드 또는 모델이 올바르지 않습니다.");
        if (selectedVersion && result.modelVersion !== selectedVersion) throw new Error("요청한 챌린저 모델 버전과 응답이 일치하지 않습니다.");
        setData(result as TopStocksResponse);
      } catch (loadError) {
        if (loadError instanceof Error && loadError.name === "AbortError") return;
        setError(loadError instanceof Error ? loadError.message : "실제 TOP50 데이터를 불러오지 못했습니다.");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    load();
    return () => controller.abort();
  }, [activeTab, compact, requestVersion]);

  useEffect(() => {
    const codes = data?.stocks.slice(0, 5).map((stock) => stock.code) ?? [];
    const requestVersion = ++intradayRequestVersionRef.current;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;

    const clearTimer = () => {
      if (timer) clearTimeout(timer);
      timer = null;
    };
    const schedule = () => {
      clearTimer();
      if (!disposed && !document.hidden && codes.length > 0) timer = setTimeout(loadQuotes, TOP_INTRADAY_POLL_MS);
    };
    async function loadQuotes() {
      if (disposed || document.hidden || codes.length === 0) return;
      let results;
      try {
        results = await Promise.all(codes.map(async (code) => {
          try {
            const response = await fetch(`/api/realtime?code=${code}`, { cache: "no-store", signal: controller.signal });
            const quote = response.ok ? await response.json() : null;
            return toTopIntradayOverlay(code, quote);
          } catch {
            return toTopIntradayOverlay(code, null);
          }
        }));
      } catch {
        return;
      }
      if (disposed || requestVersion !== intradayRequestVersionRef.current) return;
      setIntradayByCode(Object.fromEntries(results.map((overlay) => [overlay.code, overlay])));
      schedule();
    }
    const onVisibilityChange = () => {
      if (document.hidden) clearTimer();
      else if (!disposed) void loadQuotes();
    };

    if (codes.length > 0) void loadQuotes();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      disposed = true;
      clearTimer();
      controller.abort();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [data?.stocks]);

  return (
    <div className={`tb-card ${compact ? "mt-3 p-4" : "mt-6 p-4 sm:p-6"}`}>
      <p className={`${compact ? "text-[10px] font-medium tracking-[0.18em]" : "text-xs font-bold tracking-[0.15em]"} uppercase text-[var(--tb-orange)]`}>Daily model ranking</p>
      <div className="flex items-center justify-between gap-4"><h2 className={`${compact ? "mt-1 text-lg font-medium" : "mt-1 text-xl font-extrabold sm:text-2xl"} tracking-tight text-slate-950`}>{compact ? "모델 TOP 종목" : "시장 TOP 종목"}</h2>{compact && onOpenFull && <button type="button" onClick={onOpenFull} className="tb-focus rounded-lg px-2 py-1 text-xs font-medium text-[var(--tb-blue)] hover:bg-orange-50/50">전체 순위 보기 →</button>}</div>
      <p className={`${compact ? "mt-1 text-xs" : "mt-2 text-sm"} text-gray-600`}>{modelDescriptions[activeTab]}</p>

      {compact && <div className="mt-3 flex gap-5 border-b border-slate-200/70" role="tablist" aria-label="모델 선택">
        {compactTabs.map((tab) => <button key={tab.id} type="button" role="tab" aria-selected={activeTab === tab.id} onClick={() => setActiveTab(tab.id)} className={`tb-focus -mb-px border-b-2 px-1 pb-1.5 text-xs font-medium ${activeTab === tab.id ? "border-[var(--tb-orange)] text-[var(--tb-orange)]" : "border-transparent text-slate-400 hover:text-slate-700"}`}>모델 {tab.label}</button>)}
      </div>}

      {!compact && <div className="mt-6 grid grid-cols-2 gap-2" role="tablist" aria-label="활성 비교 모델">
        {primaryTabs.map((tab) => (
          <button key={tab.id} type="button" role="tab" aria-selected={activeTab === tab.id} onClick={() => setActiveTab(tab.id)}
            className={`tb-focus rounded-xl border px-3 py-3 text-sm transition-colors ${activeTab === tab.id ? "border-[var(--tb-orange)] bg-[var(--tb-orange)] font-semibold text-white" : "border-[var(--tb-border)] bg-white text-slate-700 hover:bg-orange-50"}`}>
            {tab.label}
          </button>
        ))}
      </div>}

      {!compact && <details className="mt-3 rounded-xl border border-gray-200 bg-gray-50">
        <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-gray-700">연구 모델 보기</summary>
        <div className="grid grid-cols-1 gap-2 border-t border-gray-200 p-3 sm:grid-cols-3" role="tablist" aria-label="연구 모델">
          {researchTabs.map((tab) => <button key={tab.id} type="button" role="tab" aria-selected={activeTab === tab.id} onClick={() => setActiveTab(tab.id)} className={`min-h-12 rounded-xl border px-3 py-2 text-sm leading-snug ${activeTab === tab.id ? "border-gray-900 bg-gray-900 font-semibold text-white" : "border-gray-200 bg-white text-gray-700 hover:bg-gray-100"}`}>{tab.label}</button>)}
        </div>
      </details>}

      {activeTab === "A-v2" && (
        <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <p className="font-semibold">검증 중인 챌린저 모델</p>
          <p className="mt-1 text-xs">운영 모델로 승인되지 않았으며 A-v1과 병렬 성과를 수집한 뒤 사용자 승인으로만 승격할 수 있습니다.</p>
        </div>
      )}

      {data && !compact && (
        <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <div className="flex flex-wrap gap-x-4 gap-y-1"><span><strong>데이터 기준일</strong> {data.rankingAsOfDate}</span><span>공식 일봉 데이터</span><span>분석 대상 {data.rankingUniverseCount ?? data.stocks[0]?.rankingUniverseCount ?? "정보 없음"}종목</span></div>
          <details className="mt-2 text-xs text-amber-800"><summary className="cursor-pointer font-medium">데이터 기준 자세히 보기</summary>
          <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
          <div>구조 검증: {data.structuralStatus === "passed" ? "통과" : "정보 없음"}</div><div>순위 기준일: {data.rankingAsOfDate}</div><div>가격 기준일: {data.priceAsOfDate}</div><div>가격 기준: 공식 일봉 종가</div><div>모델 버전: {data.modelVersion ?? "미등록"}</div><div>원래 종목: {data.originalUniverseCount ?? "정보 없음"}</div><div>품질 확인 종목: {data.qualityEligibleUniverseCount ?? "정보 없음"}</div><div>검토 제외 종목: {data.quarantinedCount ?? "정보 없음"}</div><div>부분 순위: {data.isPartialRanking ? "예" : "아니오"}</div><div>제외 정책: {data.exclusionPolicyVersion ?? "정보 없음"}</div><div>Manifest: {data.sourceManifestVersion ?? "도입 전"}</div>
          </div></details>
        </div>
      )}
      {freshnessMessage && <p className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs leading-5 text-amber-900">{freshnessMessage}</p>}
      {data && compact && <p className="mt-2 text-[10px] text-gray-500">데이터 기준일 {data.rankingAsOfDate} · 공식 일봉</p>}

      {loading && <div className="mt-5 rounded-xl border border-gray-200 bg-gray-50 px-4 py-12 text-center text-sm text-gray-500">실제 TOP50 데이터를 불러오는 중입니다...</div>}
      {!loading && error && (
        <div className="mt-5 rounded-xl border border-red-200 bg-red-50 px-4 py-10 text-center">
          <p className="text-sm font-medium text-red-700">{error}</p>
          <p className="mt-2 text-xs text-red-600">예시 데이터로 대체하지 않습니다.</p>
          <button type="button" onClick={() => setRequestVersion((version) => version + 1)} className="mt-4 rounded-lg border border-red-200 bg-white px-4 py-2 text-sm font-medium text-red-700">다시 시도</button>
        </div>
      )}
      {!loading && !error && data && data.stocks.length === 0 && <div className="mt-5 rounded-xl border border-gray-200 bg-gray-50 px-4 py-12 text-center text-sm text-gray-500">실제 TOP50 데이터가 없습니다. 최신 유효 모델 스냅샷을 생성해야 합니다.</div>}
      {!loading && !error && data && data.stocks.length > 0 && (
        <div className={`${compact ? "mt-3 rounded-xl" : "mt-5 rounded-2xl"} overflow-hidden border border-[var(--tb-border)] sm:overflow-x-auto`}>
          <div className="tb-mobile-ranking-surface divide-y divide-slate-200/80 sm:hidden" aria-label="모바일 모델 TOP 종목">
            {data.stocks.map((stock) => {
              const overlay = intradayByCode[stock.code];
              const quoteStatus = overlay?.status === "available"
                ? `${overlay.price.toLocaleString("ko-KR")}원${overlay.rate == null ? "" : ` · ${overlay.rate > 0 ? "+" : ""}${overlay.rate.toFixed(2)}%`}`
                : "시세 확인 불가";
              return (
                <div key={stock.code} className="tb-mobile-ranking-row grid grid-cols-[28px_minmax(0,1fr)_auto] items-center gap-2 px-3 py-2.5">
                  <span className="text-sm font-semibold text-[var(--tb-orange)]">{stock.rank}</span>
                  <button type="button" disabled={selectingCode !== null} aria-label={`${stock.name} ${stock.code} 검색`} onClick={async () => { if (!onSelectStock || selectingCode) return; setSelectingCode(stock.code); try { await onSelectStock({ code: stock.code, name: stock.name }); } finally { setSelectingCode(null); } }} className="tb-focus min-w-0 rounded-md py-0.5 text-left disabled:cursor-wait">
                    <span className="block truncate text-sm font-semibold text-slate-950">{stock.name}</span>
                    <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] leading-4"><span className="shrink-0 font-medium text-slate-500">{stock.code}</span><span aria-hidden="true" className="text-slate-300">·</span><span className="truncate text-slate-500">{quoteStatus}</span></span>
                  </button>
                  <span className="rounded-md bg-[rgba(169,88,53,0.11)] px-2 py-1 text-sm font-semibold tabular-nums text-[var(--tb-orange)]">{stock.score.toFixed(2)}</span>
                </div>
              );
            })}
          </div>
          <table className={`hidden w-full table-auto border-collapse text-sm sm:table ${compact ? "" : "min-w-[560px]"}`}>
            <thead className="bg-slate-50 text-left text-xs text-slate-500"><tr><th className="whitespace-nowrap px-3 py-3 font-medium sm:px-4">순위</th><th className="px-3 py-3 font-medium sm:px-4">종목명</th><th className="hidden px-4 py-3 font-medium sm:table-cell">시장</th><th className="whitespace-nowrap px-3 py-3 text-right font-medium sm:px-4">{shortReferenceDate(data.rankingAsOfDate)} 기준 점수</th>{!compact && <th className="whitespace-nowrap px-3 py-3 text-right font-medium sm:px-4">기준일 종가</th>}<th className="whitespace-nowrap px-3 py-3 text-right font-medium sm:px-4">KIS 최근 조회</th></tr></thead>
            <tbody className="divide-y divide-gray-100">
              {data.stocks.map((stock) => { const overlay = intradayByCode[stock.code]; const overlayView = overlay?.status === "available" ? <><strong className="block text-sm text-slate-900">{overlay.price.toLocaleString("ko-KR")}원</strong><span className={overlay.rate != null && overlay.rate < 0 ? "text-[var(--tb-negative)]" : overlay.rate != null && overlay.rate > 0 ? "text-[var(--tb-positive)]" : "text-slate-500"}>{overlay.rate == null ? "KIS 최근 조회" : `${overlay.rate > 0 ? "+" : ""}${overlay.rate.toFixed(2)}%`}</span><span className="mt-0.5 block text-[11px] text-slate-400">{overlay.asOfTime ? `KIS ${overlay.asOfTime}` : "기준시각 미확인"}</span></> : <span className="text-slate-400">시세 확인 불가</span>; const rowPadding = compact ? "py-2.5" : "py-4"; return <tr key={stock.code} className="transition-colors hover:bg-orange-50/40"><td className={`whitespace-nowrap px-3 ${rowPadding} font-medium text-[var(--tb-orange)] sm:px-4`}>{stock.rank}</td><td className={`px-3 ${rowPadding} sm:px-4`}><button type="button" disabled={selectingCode !== null} aria-label={`${stock.name} ${stock.code} 검색`} onClick={async () => { if (!onSelectStock || selectingCode) return; setSelectingCode(stock.code); try { await onSelectStock({ code: stock.code, name: stock.name }); } finally { setSelectingCode(null); } }} className="tb-focus cursor-pointer rounded text-left font-medium text-slate-900 hover:text-[var(--tb-orange)] hover:underline disabled:cursor-wait">{stock.name}<span className="block whitespace-nowrap text-xs font-normal text-slate-400 sm:ml-2 sm:inline">{stock.code}</span></button>{compact && <div className="mt-1 text-xs sm:hidden"><span className="text-slate-400">KIS 최근 조회 · </span>{overlayView}</div>}</td><td className={`hidden px-4 ${rowPadding} text-slate-500 sm:table-cell`}>{stock.market}</td><td className={`whitespace-nowrap px-3 ${rowPadding} text-right font-medium text-slate-800 sm:px-4`}><span className="rounded-md bg-[rgba(182,91,50,0.09)] px-2 py-0.5 text-[var(--tb-orange)]">{stock.score.toFixed(2)}</span></td>{!compact && <td className="whitespace-nowrap px-3 py-4 text-right text-slate-700 sm:px-4">{stock.closePrice.toLocaleString("ko-KR")}원</td>}<td className={`${compact ? "hidden sm:table-cell" : ""} whitespace-nowrap px-3 ${rowPadding} text-right text-xs sm:px-4`}>{overlayView}</td></tr>; })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
