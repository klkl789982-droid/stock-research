"use client";

import { useEffect, useRef, useState } from "react";
import WatchlistStar from "./WatchlistStar";
import { TOP_INTRADAY_POLL_MS, toTopIntradayOverlay } from "../lib/top-stocks-intraday-overlay.mjs";
import { shouldSelectKisEodTop } from "../lib/kis-eod-top-selection.mjs";
import { LiveCoverageSummary, type LiveCoverage } from "./PrivateLiveDeliveryPanel";

type ModelId = "A" | "B" | "C" | "D";
type TopStock = {
  rank: number;
  code: string;
  name: string;
  market: string;
  score: number;
  closePrice: number | null;
  quoteAsOfTime?: string;
  priceBasis: "officialDailyClose" | "intradayOfficialSignal" | "notPubliclyRedistributed";
  priceAsOfDate: string;
  rankingUniverseCount?: number;
  rankPercentile?: number;
};
type TopStocksResponse = {
  dataMode: "historySnapshot" | "intradayOfficialSignal" | "kisProvisionalEod";
  model: ModelId;
  modelName: string;
  modelVersion: string | null;
  modelRole?: "champion" | "challenger";
  promotionStatus?: "notApproved";
  rankingAsOfDate: string;
  priceAsOfDate: string;
  priceBasis: "officialDailyClose" | "intradayOfficialSignal" | "notPubliclyRedistributed";
  officialSnapshotReferenceDate?: string | null;
  liveMeta?: { coverage: LiveCoverage; revision: number | null; formulaHash: string; freshnessStatus: string; publishedAt: string | null; deliveryHash: string; transitionInputsRetained?: boolean };
  officialSignalTime?: string;
  collectionStartedAt?: string;
  collectionCompletedAt?: string;
  officialSignal?: { signalDate: string | null; status: "READY" | "FAILED" | "FAILED_COLLECTION" | "UNAVAILABLE"; reason: string | null; officialSignalTime: string | null };
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

type StockSelection = { code: string; name: string; market?: string };
type TopProfile = "1400" | "1430" | "daily";
type TopStocksPanelProps = { onSelectStock?: (stock: StockSelection) => void | Promise<void>; compact?: boolean; onOpenFull?: () => void; onOpenGuide?: () => void; initialTab?: string; onTabChange?: (tab: string) => void; initialProfile?: TopProfile; onProfileChange?: (profile: TopProfile) => void };
type IntradayOverlay = { code: string; status: "available"; price: number; rate: number | null; asOfDate: string | null; asOfTime: string | null; receivedAt: string | null; source: "KIS" | null } | { code: string; status: "unavailable" };
type IntradayModelTopResponse = NonNullable<TopStocksResponse["liveMeta"]> & { dataMode: "intradayOfficialSignal"; signalDate: string; officialSignalTime: string; model: ModelId; modelName: string | null; modelVersion: string; collectionStartedAt: string; collectionCompletedAt: string; rankingUniverse: { count: number }; count: number; stocks: Array<{ rank: number; code: string; name: string; market: string | null; score: number; observedPrice: number | null; quoteAsOfTime?: string }> };

const primaryTabs = [
  { id: "A-v1", model: "A" as const, label: "모델 A · 기술 강도" },
  { id: "B", model: "B" as const, label: "모델 B · 추세 강도" },
  { id: "C", model: "C" as const, label: "모델 C · 진입 강도" },
  { id: "D", model: "D" as const, label: "모델 D · 추세 + 진입" },
];
const researchTabs = [
  { id: "A-v2", model: "A" as const, version: "A-v2" as const, label: "A-v2 · 기술 강도 · 검증 중" },
];
const tabs = [...primaryTabs, ...researchTabs];
const compactTabs = [
  { id: "A-v1", label: "A" },
  { id: "B", label: "B" },
  { id: "C", label: "C" },
  { id: "D", label: "D" },
];
const modelDescriptions: Record<string, string> = {
  B: "이동평균선 구조·기울기·추세 지속성을 중심으로 보는 중기 추세 모델입니다.",
  C: "가격·거래량·단기 모멘텀·보조지표 전환을 중심으로 보는 현재 진입 강도 모델입니다.",
  "A-v1": "모멘텀·추세·거래량·MACD·RSI·52주 가격 위치 등을 종합한 기술적 강도 모델입니다.",
  "A-v2": "기술적 강도를 범위 제한 방식으로 검증 중인 챌린저 모델입니다.",
  D: "B와 C를 결합해 중기 추세와 현재 진입 강도를 함께 보는 모델입니다.",
};
const shortReferenceDate = (value: string) => {
  const parts = value.split("-");
  return parts.length === 3 ? `${Number(parts[1])}/${Number(parts[2])}` : value;
};

export default function TopStocksPanel({ onSelectStock, compact = false, onOpenFull, onOpenGuide, initialTab = "B", onTabChange, initialProfile = "1400", onProfileChange }: TopStocksPanelProps) {
  const [activeTab, setActiveTab] = useState(initialTab);
  const [localProfile, setProfile] = useState(initialProfile);
  const profile = onProfileChange ? initialProfile : localProfile;
  const [selectingCode, setSelectingCode] = useState<string | null>(null);
  const [data, setData] = useState<TopStocksResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [kisEodMessage, setKisEodMessage] = useState<string | null>(null);
  const [requestVersion, setRequestVersion] = useState(0);
  const [intradayByCode, setIntradayByCode] = useState<Record<string, IntradayOverlay>>({});
  const intradayRequestVersionRef = useRef(0);
  const freshnessMessage = data?.freshness?.freshnessStatus === "stale"
    ? `최신 공식 일봉(${data.freshness.observedOfficialDate ?? "기준일 확인됨"}) 기준 순위 생성이 아직 완료되지 않았습니다. 현재 순위는 ${data.rankingAsOfDate} 기준입니다.`
    : data?.freshness?.freshnessStatus === "unavailable"
      ? `최신 공식 일봉 기준일을 확인할 수 없습니다. 현재 순위는 ${data.rankingAsOfDate} 기준입니다.`
      : null;
  const officialSignalMessage = activeTab === "B" && profile === "1430" && data?.dataMode !== "intradayOfficialSignal" && data?.officialSignal?.status !== "READY"
    ? data?.officialSignal?.status === "FAILED" || data?.officialSignal?.status === "FAILED_COLLECTION"
      ? `최근 Official Signal 생성에 실패했습니다.${data.officialSignal.signalDate ? ` 실제 시도일: ${data.officialSignal.signalDate}` : " 시도일 확인 불가"}`
      : "이전 14:30 Official Signal 상태 확인 불가"
    : null;

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      setLoading(true);
      setError(null);
      setData(null);
      setKisEodMessage(null);
      try {
        const selectedTab = tabs.find((tab) => tab.id === activeTab) ?? tabs.find((tab) => tab.id === "B")!;
        const selectedVersion = "version" in selectedTab ? selectedTab.version : undefined;
        const versionQuery = selectedVersion ? `&version=${selectedVersion}` : "";
        const applyApprovedKisEod = async (baseline: TopStocksResponse) => {
          let selected = baseline;
          try {
            const response = await fetch(`/api/kis-eod-top-stocks?model=${selectedTab.model}${versionQuery}&limit=${compact ? 5 : 50}`, { cache: "no-store", signal: controller.signal });
            if (response.ok) {
              const provisional = await response.json();
              if (provisional.model === selectedTab.model && shouldSelectKisEodTop(provisional, baseline, selectedVersion ?? `${selectedTab.model}-v1`)) selected = provisional as TopStocksResponse;
              else if (!controller.signal.aborted && provisional.available === false) setKisEodMessage(provisional.reason === "ACTIVATION_REQUIRES_APPROVAL" ? "KIS 당일 잠정 EOD는 운영 승인 전입니다. 공식 일봉을 표시합니다." : "KIS 당일 잠정 EOD 갱신 대기 중입니다. 기존 유효 순위를 유지합니다.");
            }
          } catch {
            // A provisional feed failure must never hide a valid Daily/LIVE result.
          }
          if (!controller.signal.aborted) setData(selected);
        };
        if (!selectedVersion && profile !== "daily") {
          const intradayResponse = await fetch(`/api/intraday-model-top?model=${selectedTab.model}&limit=${compact ? 5 : 50}&profile=${profile}`, { cache: "no-store", signal: controller.signal });
          if (intradayResponse.ok) {
            const intraday = await intradayResponse.json() as IntradayModelTopResponse;
            if (intraday.model !== selectedTab.model || intraday.modelVersion !== selectedTab.model + "-v1" || !/^[a-f0-9]{64}$/u.test(intraday.formulaHash) ||
              intraday.officialSignalTime !== (profile === "1400" ? "14:00:00" : "14:30:00")) throw new Error("LIVE 모델·관측 기준을 확인할 수 없습니다.");
            if (!controller.signal.aborted) setData({ dataMode: "intradayOfficialSignal", model: intraday.model, modelName: intraday.modelName ?? selectedTab.model,
              modelVersion: intraday.modelVersion, rankingAsOfDate: intraday.signalDate, priceAsOfDate: intraday.signalDate,
              priceBasis: profile === "1400" ? "notPubliclyRedistributed" : "intradayOfficialSignal", officialSignalTime: intraday.officialSignalTime,
              collectionStartedAt: intraday.collectionStartedAt, collectionCompletedAt: intraday.collectionCompletedAt, generatedAt: intraday.collectionCompletedAt,
              liveMeta: profile === "1400" ? intraday : undefined, count: intraday.count, isPartialRanking: intraday.coverage?.status === "PARTIAL",
              stocks: intraday.stocks.map(stock => ({ ...stock, market: stock.market ?? "정보 없음", closePrice: stock.observedPrice,
                priceBasis: profile === "1400" ? "notPubliclyRedistributed" : "intradayOfficialSignal", priceAsOfDate: intraday.signalDate })), rankingUniverseCount: intraday.rankingUniverse.count });
            return;
          }
          const failure = await intradayResponse.json().catch(() => null);
          throw new Error(failure?.error?.message ?? (profile === "1400" ? "검증된 14:00 LIVE 순위를 불러오지 못했습니다. 홈에서 수집 현황을 확인할 수 있습니다." : "과거 14:30 관측을 불러오지 못했습니다."));
        }
        const response = await fetch(`/api/top-stocks?model=${selectedTab.model}${versionQuery}&limit=${compact ? 5 : 50}&basis=daily`, { cache: "no-store", signal: controller.signal });
        const result = await response.json();
        if (!response.ok) throw new Error(result?.error?.message ?? "실제 TOP50 데이터를 불러오지 못했습니다.");
        if (!["historySnapshot", "intradayOfficialSignal"].includes(result.dataMode) || result.model !== selectedTab.model) throw new Error("TOP50 응답의 데이터 모드 또는 모델이 올바르지 않습니다.");
        if (selectedVersion && result.modelVersion !== selectedVersion) throw new Error("요청한 챌린저 모델 버전과 응답이 일치하지 않습니다.");
        await applyApprovedKisEod(result as TopStocksResponse);
      } catch (loadError) {
        if (loadError instanceof Error && loadError.name === "AbortError") return;
        setError(loadError instanceof Error ? loadError.message : "실제 TOP50 데이터를 불러오지 못했습니다.");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    load();
    return () => controller.abort();
  }, [activeTab, compact, requestVersion, profile]);

  useEffect(() => {
    const refresh = () => {
      if (!document.hidden) setRequestVersion((version) => version + 1);
    };
    const timer = window.setInterval(refresh, 60_000);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, []);

  const quoteCodes = data?.stocks.slice(0, 5).map((stock) => stock.code).join(",") ?? "";
  useEffect(() => {
    const codes = quoteCodes ? quoteCodes.split(",") : [];
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
    let fetching = false;
    async function loadQuotes() {
      if (fetching || disposed || document.hidden || !codes.length) return;
      fetching = true;
      try {
        for (const code of codes) {
          if (disposed || document.hidden) break;
          let quote = null;
          try {
            const response = await fetch(`/api/realtime?code=${code}`, { cache: "no-store", signal: controller.signal });
            if (response.ok) quote = await response.json();
          } catch { /* Keep other tickers available. */ }
          if (disposed || requestVersion !== intradayRequestVersionRef.current) return;
          const overlay = toTopIntradayOverlay(code, quote) as IntradayOverlay;
          setIntradayByCode(previous => ({ ...previous, [code]: overlay }));
        }
      } finally {
        fetching = false;
        schedule();
      }
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
  }, [quoteCodes]);

  return (
    <>
    <div className={`tb-card min-w-0 ${compact ? "mt-3 p-4" : "p-4 sm:p-6"}`}>
      <div className="flex items-center justify-between gap-4"><h2 className={`${compact ? "text-lg font-medium" : "tb-page-title"} tracking-tight text-slate-950`}>모델 TOP</h2>{compact && onOpenFull && <button type="button" onClick={onOpenFull} className="tb-focus rounded-lg px-2 py-1 text-xs font-medium text-[var(--tb-blue)] hover:bg-blue-50/50">전체 순위 보기 →</button>}</div>
      {compact && <div className="tb-segmented mt-3" role="tablist" aria-label="모델 선택">
        {compactTabs.map((tab) => <button key={tab.id} type="button" role="tab" aria-selected={activeTab === tab.id} onClick={() => { setActiveTab(tab.id); onTabChange?.(tab.id); }} className="tb-focus">모델 {tab.label}</button>)}
      </div>}

      {!compact && <div className="tb-segmented mt-4" role="tablist" aria-label="활성 비교 모델">
        {primaryTabs.map((tab) => (
          <button key={tab.id} type="button" role="tab" aria-selected={activeTab === tab.id} onClick={() => { setActiveTab(tab.id); onTabChange?.(tab.id); }}
            className="tb-focus">
            {tab.label}
          </button>
        ))}
      </div>}


      {activeTab !== "A-v2" && <div className="tb-segmented mt-3" role="group" aria-label="순위 데이터 기준">
        {([["1400", "14:00 LIVE"], ["daily", "Daily EOD"]] as const).map(([id, label]) =>
          <button type="button" key={id} aria-pressed={profile === id} onClick={() => { setProfile(id); onProfileChange?.(id); }} className="tb-focus">{label}</button>)}
      </div>}
      {activeTab !== "A-v2" && <button type="button" aria-pressed={profile === "1430"} className="tb-secondary-link ml-2" onClick={() => { setProfile("1430"); onProfileChange?.("1430"); }}>과거 14:30 기록</button>}
      <div className="tb-rank-context">
        {data && <p role="status" className="font-semibold text-slate-700">{data.rankingAsOfDate} · {data.dataMode === "kisProvisionalEod" ? "KIS 잠정 EOD" : data.dataMode === "intradayOfficialSignal" ? `${data.officialSignalTime?.slice(0,5)} LIVE` : "Daily EOD"}{data.liveMeta && ` · ${({PARTIAL:"잠정",COMPLETE:"전체",WITHHELD:"게시 보류"})[data.liveMeta.coverage.status]} ${data.liveMeta.coverage.validCount}/${data.liveMeta.coverage.targetCount}종목`}{data.liveMeta?.freshnessStatus === "HISTORICAL" && " · 이전 거래일"}{!data.liveMeta && data.isPartialRanking && " · 부분 순위"}</p>}
        <div className="tb-data-actions">
          <details><summary>모델 설명</summary><p>{modelDescriptions[activeTab]}</p>{onOpenGuide && <button type="button" onClick={onOpenGuide} className="tb-secondary-link">전체 모델 설명</button>}</details>
          {data && <details><summary>데이터 상세</summary>{data?.liveMeta && <div className="mt-3"><LiveCoverageSummary coverage={data.liveMeta.coverage}/>
        <p className="text-xs text-slate-600">{data.liveMeta.freshnessStatus === "HISTORICAL" ? "이전 거래일 저장 관측 · " : ""}{data.rankingAsOfDate} · 관측 기간 {new Date(data.collectionStartedAt!).toLocaleTimeString("ko-KR",{timeZone:"Asia/Seoul"})} ~ {new Date(data.collectionCompletedAt!).toLocaleTimeString("ko-KR",{timeZone:"Asia/Seoul"})} KST
        {data.liveMeta.publishedAt && " · 게시 " + new Date(data.liveMeta.publishedAt).toLocaleString("ko-KR",{timeZone:"Asia/Seoul"}) + " KST"}</p>
        <div className="text-xs text-slate-600"><p className="break-all">{data.liveMeta.revision ? `r${data.liveMeta.revision} · ` : ""}{data.modelVersion} · 산식 {data.liveMeta.formulaHash} · 게시본 {data.liveMeta.deliveryHash}</p></div>
      </div>}<div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
          <div>분석 대상: {data.rankingUniverseCount ?? data.stocks[0]?.rankingUniverseCount ?? "정보 없음"}종목</div><div>구조 검증: {data.structuralStatus === "passed" ? "통과" : "정보 없음"}</div><div>데이터 기준일: {data.rankingAsOfDate}</div><div>가격 기준일: {data.priceAsOfDate}</div><div>가격 기준: {data.dataMode === "kisProvisionalEod" ? "원천 시세 미공개 · 점수만 표시" : data.dataMode === "intradayOfficialSignal" ? "KIS 관측가" : "공식 일봉 종가"}</div><div>모델 버전: {data.modelVersion ?? "미등록"}</div><div>원래 종목: {data.originalUniverseCount ?? "정보 없음"}</div><div>품질 확인 종목: {data.qualityEligibleUniverseCount ?? "정보 없음"}</div><div>검토 제외 종목: {data.quarantinedCount ?? "정보 없음"}</div><div>부분 순위: {data.isPartialRanking ? "예" : "아니오"}</div><div>제외 정책: {data.exclusionPolicyVersion ?? "정보 없음"}</div><div>Manifest: {data.sourceManifestVersion ?? "도입 전"}</div>
          </div></details>}
        </div>
      </div>
      {!compact && <details className="tb-research-link">
        <summary className="tb-secondary-link">연구 모델 보기</summary>
        <div className="tb-segmented m-3" role="tablist" aria-label="연구 모델">
          {researchTabs.map((tab) => <button key={tab.id} type="button" role="tab" aria-selected={activeTab === tab.id} onClick={() => { setActiveTab(tab.id); onTabChange?.(tab.id); }} className="tb-focus">{tab.label}</button>)}
        </div>
      </details>}

      {activeTab === "A-v2" && (
        <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <p className="font-semibold">검증 중인 챌린저 모델</p>
          <p className="mt-1 text-xs">운영 모델로 승인되지 않았으며 A-v1과 병렬 성과를 수집한 뒤 사용자 승인으로만 승격할 수 있습니다.</p>
        </div>
      )}

      {freshnessMessage && <p className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs leading-5 text-amber-900">{freshnessMessage}</p>}
      {kisEodMessage && !loading && <p className="mt-2 text-xs text-slate-600">{kisEodMessage}</p>}
      {data?.dataMode === "kisProvisionalEod" && <p className="mt-2 text-xs text-amber-900">{data.rankingAsOfDate} · KIS 당일 잠정 EOD · 공식 확정 EOD: {data.officialSnapshotReferenceDate ?? "확인 불가"}. 공식 성과·14:30 LIVE 성과에 포함하지 않습니다.</p>}
      {officialSignalMessage && <p className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs leading-5 text-amber-900">{officialSignalMessage}</p>}

      {loading && <div className="mt-5 rounded-xl border border-gray-200 bg-gray-50 px-4 py-12 text-center text-sm text-gray-500">순위 조회 중</div>}
      {!loading && error && (
        <div className="mt-5 rounded-xl border border-red-200 bg-red-50 px-4 py-10 text-center">
          <p className="text-sm font-medium text-red-700">{error}</p>
          <button type="button" onClick={() => setRequestVersion((version) => version + 1)} className="mt-4 rounded-lg border border-red-200 bg-white px-4 py-2 text-sm font-medium text-red-700">다시 시도</button>
        </div>
      )}
      {!loading && !error && data && data.stocks.length === 0 && <div className="mt-5 rounded-xl border border-gray-200 bg-gray-50 px-4 py-12 text-center text-sm text-gray-500">순위 데이터 없음 · 유효한 모델 스냅샷이 필요합니다.</div>}
      {!loading && !error && data && data.stocks.length > 0 && (
        <div className={`${compact ? "mt-3 rounded-xl" : "mt-5 rounded-2xl"} overflow-hidden border border-[var(--tb-border)] sm:overflow-x-auto`}>
          <div className="tb-mobile-ranking-surface divide-y divide-slate-200/80 sm:hidden" aria-label="모바일 모델 TOP 종목">
            {data.stocks.map((stock) => {
              const overlay = intradayByCode[stock.code];
              const quoteStatus = overlay?.status === "available"
                ? `${overlay.price.toLocaleString("ko-KR")}원${overlay.rate == null ? "" : ` · ${overlay.rate > 0 ? "+" : ""}${overlay.rate.toFixed(2)}%`}`
                : stock.rank > 5 ? "종목 상세에서 조회" : "시세 확인 불가";
              return (
                <div key={stock.code} className="tb-mobile-ranking-row grid grid-cols-[28px_minmax(0,1fr)_auto] items-center gap-2 px-3 py-2.5">
                  <span className="text-sm font-semibold text-[var(--tb-blue)]">{stock.rank}</span>
                  <button type="button" disabled={selectingCode !== null} aria-label={`${stock.name} ${stock.code} 검색`} onClick={async () => { if (!onSelectStock || selectingCode) return; setSelectingCode(stock.code); try { await onSelectStock({ code: stock.code, name: stock.name, market: stock.market }); } finally { setSelectingCode(null); } }} className="tb-focus min-w-0 rounded-md py-0.5 text-left disabled:cursor-wait">
                    <span className="block break-words text-sm font-semibold text-slate-950">{stock.name}</span>
                    <span className="block text-xs text-slate-600">{stock.code} · {stock.market}</span>
                  </button>
                  <div className="flex items-center gap-1"><span className="rounded-md tb-score px-2 py-1 text-sm font-semibold tabular-nums text-[var(--tb-blue)]">{stock.score.toFixed(2)}</span><WatchlistStar code={stock.code} name={stock.name}/></div>
                  <p className="col-start-2 col-span-2 text-xs font-medium tabular-nums text-slate-700">KIS 최근 조회 · {quoteStatus}</p>
                  <details className="col-start-2 col-span-2 min-w-0 text-xs leading-5 text-slate-600"><summary className="tb-focus w-fit cursor-pointer">시세 상세</summary>
                    <p>시장 {stock.market} · 점수 기준일 {data.rankingAsOfDate}</p>
                    {data.dataMode !== "kisProvisionalEod" && <p>{data.dataMode === "intradayOfficialSignal" ? `${data.officialSignalTime?.slice(0,5)} 관측` : "기준일 종가"} · {stock.closePrice === null ? (data.liveMeta?.transitionInputsRetained ? "원가격 비공개" : "가격 미보존") : `${stock.closePrice.toLocaleString("ko-KR")}원`}{stock.quoteAsOfTime && ` · ${stock.quoteAsOfTime} KST`}</p>}
                    {overlay?.status === "available" && <p>최근 체결 기준 {overlay.asOfDate} {overlay.asOfTime} KST</p>}
                  </details>
                </div>
              );
            })}
          </div>
          <table className={`tb-ranking-table tb-table hidden w-full table-auto border-collapse text-sm sm:table ${compact ? "" : "min-w-[560px]"}`}>
            <thead className="bg-slate-50 text-left text-xs text-slate-500"><tr><th className="whitespace-nowrap px-3 py-3 font-medium sm:px-4">순위</th><th className="px-3 py-3 font-medium sm:px-4">종목명</th><th className="whitespace-nowrap px-3 py-3 text-right font-medium sm:px-4">{shortReferenceDate(data.rankingAsOfDate)} 기준 점수</th>{!compact && data.dataMode !== "kisProvisionalEod" && <th className="whitespace-nowrap px-3 py-3 text-right font-medium sm:px-4">{data.dataMode === "intradayOfficialSignal" ? `${data.officialSignalTime?.slice(0,5)} 관측` : "기준일 종가"}</th>}<th className="whitespace-nowrap px-3 py-3 text-right font-medium sm:px-4">KIS 최근 조회</th></tr></thead>
            <tbody className="divide-y divide-gray-100">
              {data.stocks.map((stock) => { const overlay = intradayByCode[stock.code]; const overlayView = overlay?.status === "available" ? <><strong className="block text-sm text-slate-900">{overlay.price.toLocaleString("ko-KR")}원</strong><span className={overlay.rate != null && overlay.rate < 0 ? "text-[var(--tb-negative)]" : overlay.rate != null && overlay.rate > 0 ? "text-[var(--tb-positive)]" : "text-slate-500"}>{overlay.rate == null ? "KIS 최근 조회" : `${overlay.rate > 0 ? "+" : ""}${overlay.rate.toFixed(2)}%`}</span><details className="text-xs text-slate-600"><summary>{overlay.asOfTime ?? "기준시각 미확인"}</summary>{overlay.asOfDate} · KIS 체결 기준 KST</details></> : <span className="text-slate-600">{stock.rank > 5 ? "종목 상세에서 조회" : "시세 확인 불가"}</span>; const rowPadding = "py-2.5"; return <tr key={stock.code} className="transition-colors hover:bg-blue-50/40"><td className={`whitespace-nowrap px-3 ${rowPadding} font-medium text-[var(--tb-blue)] sm:px-4`}>{stock.rank}</td><td className={`px-3 ${rowPadding} sm:px-4`}><div className="flex items-center justify-between gap-2"><button type="button" disabled={selectingCode !== null} aria-label={`${stock.name} ${stock.code} 검색`} onClick={async () => { if (!onSelectStock || selectingCode) return; setSelectingCode(stock.code); try { await onSelectStock({ code: stock.code, name: stock.name, market: stock.market }); } finally { setSelectingCode(null); } }} className="tb-focus cursor-pointer rounded text-left font-medium text-slate-900 hover:text-[var(--tb-blue)] hover:underline disabled:cursor-wait">{stock.name}<span className="block whitespace-nowrap text-xs font-normal text-slate-600">{stock.code} · {stock.market}</span></button><WatchlistStar code={stock.code} name={stock.name}/></div>{compact && <div className="mt-1 text-xs sm:hidden"><span className="text-slate-400">KIS 최근 조회 · </span>{overlayView}</div>}</td><td className={`whitespace-nowrap px-3 ${rowPadding} text-right font-medium text-slate-800 sm:px-4`}><span className="rounded-md tb-score px-2 py-0.5 text-[var(--tb-blue)]">{stock.score.toFixed(2)}</span></td>{!compact && data.dataMode !== "kisProvisionalEod" && <td className="whitespace-nowrap px-3 py-4 text-right text-slate-700 sm:px-4">{stock.closePrice === null && data.liveMeta ? `${stock.quoteAsOfTime ?? "시각 미확인"} · ${data.liveMeta.transitionInputsRetained ? "원가격 비공개" : "가격 미보존"}` : stock.closePrice === null ? "정보 없음" : `${stock.closePrice.toLocaleString("ko-KR")}원`}</td>}<td className={`${compact ? "hidden sm:table-cell" : ""} whitespace-nowrap px-3 ${rowPadding} text-right text-xs sm:px-4`}>{overlayView}</td></tr>; })}
            </tbody>
          </table>
        </div>
      )}
    </div>
    </>
  );
}
