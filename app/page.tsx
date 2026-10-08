"use client";

import { useState, useEffect, useMemo, useRef } from "react";
import TopStocksPanel from "../components/TopStocksPanel";
import ModelTopPerformancePanel from "../components/ModelTopPerformancePanel";
import ModelExplanationPanel from "../components/ModelExplanationPanel";
import MarketAnalysisPanel, { type MarketAnalysisResponse, type IntradayAnalysisResponse } from "../components/market-analysis/MarketAnalysisPanel";
import CompanyAnalysisPanel, { companyAnalysisRecordReasonLabel, type CompanyAnalysisResult } from "../components/company-analysis/CompanyAnalysisPanel";
import TechnicalStrengthPanel from "../components/TechnicalStrengthPanel";
import BrandMark from "../components/BrandMark";
import StockScreenerPanel from "../components/StockScreenerPanel";
import { searchApiErrorMessage, settleSearchRequest } from "../lib/search-request-isolation.mjs";
import { buildSearchTechnicalStrength } from "../lib/search-technical-strength.mjs";
import { buildSearchMarketAnalysis } from "../lib/search-market-analysis.mjs";
import { analysisAvailabilityMessage } from "../lib/analysis-availability.mjs";
import { isVerifiedKisRealtimeQuote } from "../lib/kis-quote-display-policy.mjs";
export default function Home() {
  const [query, setQuery] = useState("");
  const [searchedStock, setSearchedStock] = useState<string | null>(null);
const [activeTab, setActiveTab] = useState<"technical" | "company">("technical");
const [pageView, setPageView] = useState<"home" | "models" | "screener">("home");
const [modelPageTab, setModelPageTab] = useState<"top" | "performance" | "guide">("top");
const [mobileNavOpen, setMobileNavOpen] = useState(false);
const [realtimePrice, setRealtimePrice] = useState<{
  price: number;
  change: number;
  rate: number;
  volume: number;
  open: number | null;
  high: number;
  low: number;
  code: string;
  source: "KIS";
  priceBasis: "lastQuotedPrice";
  asOfDate: string | null;
  asOfTime: string | null;
  responseAt: string;
  marketStatus: "open" | "closed" | "unknown";
  isRealtime: boolean;
  freshnessStatus: "freshObservation" | "unverified";
  valueStatus: "valid";
  metadataAvailability: {
    status: "complete" | "incomplete";
    missingFields: Array<"asOfDate" | "asOfTime">;
    usableForDatedCalculation: boolean;
    usableForFreshness: boolean;
  };
} | null>(null);
// 기존 API 응답은 아직 공통 타입 계약이 없어 후속 타입화 전까지 legacy state로 격리합니다.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const [stockInfo, setStockInfo] = useState<any>(null);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const [priceInfo, setPriceInfo] = useState<any>(null);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const [investorData, setInvestorData] = useState<any>(null);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const [priceHistory, setPriceHistory] = useState<any[]>([]);
const [companyAnalysis, setCompanyAnalysis] = useState<CompanyAnalysisResult | null>(null);
const [companyAnalysisError, setCompanyAnalysisError] = useState<string | null>(null);
const [companyAnalysisLoading, setCompanyAnalysisLoading] = useState(false);
const [marketAnalysis, setMarketAnalysis] = useState<MarketAnalysisResponse | null>(null);
const [intradayAnalysis, setIntradayAnalysis] = useState<IntradayAnalysisResponse | null>(null);
const [marketAnalysisError, setMarketAnalysisError] = useState<string | null>(null);
const [intradayError, setIntradayError] = useState<string | null>(null);
const [loading, setLoading] = useState(false);
  const [searchError, setSearchError] = useState<"notFound" | "request" | null>(null);
const [realtimeError, setRealtimeError] = useState<string | null>(null);
const [priceError, setPriceError] = useState<string | null>(null);
const [priceRequestStatus, setPriceRequestStatus] = useState<"idle" | "loading" | "success" | "missing" | "error" | "unavailable">("idle");
const [priceMeta, setPriceMeta] = useState<{
  code: string;
  source: "officialDailyPrice";
  priceBasis: "officialDailyClose";
  asOfDate: string;
  closePrice: number;
} | null>(null);
const searchRequestIdRef = useRef(0);
const searchControllerRef = useRef<AbortController | null>(null);
const selectedCodeRef = useRef<string | null>(null);
const pageTopRef = useRef<HTMLElement | null>(null);
const searchInputRef = useRef<HTMLInputElement | null>(null);
const technicalStrength = useMemo(() => buildSearchTechnicalStrength({
  priceHistory,
  priceRequestStatus,
  realtimePrice,
}), [priceHistory, priceRequestStatus, realtimePrice]);
const marketAnalysisView = useMemo(() => buildSearchMarketAnalysis({
  priceHistory,
  priceRequestStatus,
  storedMarketData: marketAnalysis,
}), [priceHistory, priceRequestStatus, marketAnalysis]);
const verifiedRealtimePrice = isVerifiedKisRealtimeQuote(realtimePrice)
  ? realtimePrice
  : null;
useEffect(() => {
  if (!stockInfo || intradayAnalysis?.session?.sessionStatus !== "inferredOpen") return;

  const stockCode = stockInfo.srtnCd.replace(/^A/, "");
  let timer: ReturnType<typeof setTimeout> | null = null;
  let activeController: AbortController | null = null;
  let disposed = false;
  let pollingBlocked = false;
  let consecutiveFailures = 0;

  const clearTimer = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  const schedule = (delayMs: number) => {
    clearTimer();
    if (disposed || pollingBlocked || document.hidden || selectedCodeRef.current !== stockCode) return;
    timer = setTimeout(poll, delayMs);
  };
  const fail = (message: string) => {
    if (selectedCodeRef.current !== stockCode) return;
    consecutiveFailures += 1;
    setRealtimePrice(null);
    if (consecutiveFailures >= 3) {
      pollingBlocked = true;
      setRealtimeError(`${message} 자동 갱신을 중단했습니다.`);
      clearTimer();
      return;
    }
    setRealtimeError(message);
    schedule(5000 * 2 ** (consecutiveFailures - 1));
  };
  async function poll() {
    if (disposed || pollingBlocked || document.hidden || selectedCodeRef.current !== stockCode) return;
    activeController = new AbortController();
    try {
      const response = await fetch(`/api/intraday-market-analysis?code=${stockCode}`, { signal: activeController.signal, cache: "no-store" });
      const data = await response.json();
      if (!response.ok) return fail(searchApiErrorMessage(data, "장중 참고 분석 조회 실패"));
      if (selectedCodeRef.current !== stockCode) return;
      setIntradayAnalysis(data);
      if (data.session?.sessionStatus !== "inferredOpen") { pollingBlocked = true; clearTimer(); return; }
      consecutiveFailures = 0;
      schedule(5000);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      fail("현재 시세 조회 실패");
    } finally {
      activeController = null;
    }
  }

  const handleVisibility = () => {
    if (document.hidden) {
      clearTimer();
      activeController?.abort();
    } else if (!pollingBlocked) {
      schedule(0);
    }
  };
  document.addEventListener("visibilitychange", handleVisibility);
  schedule(5000);

  return () => {
    disposed = true;
    clearTimer();
    activeController?.abort();
    document.removeEventListener("visibilitychange", handleVisibility);
  };

}, [stockInfo, intradayAnalysis?.session?.sessionStatus]);
useEffect(() => {
  if (!stockInfo) return;

  const stockCode = stockInfo.srtnCd.replace(/^A/, "");
  const controller = new AbortController();

  const fetchInvestorData = async () => {
    try {
      const response = await fetch(`/api/investor?code=${stockCode}`, { signal: controller.signal });

      if (!response.ok) {
        if (selectedCodeRef.current === stockCode) setInvestorData(null);
        return;
      }

      const data = await response.json();
      if (selectedCodeRef.current !== stockCode) return;
      setInvestorData(data);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      if (selectedCodeRef.current === stockCode) setInvestorData(null);
    }
  };

  void fetchInvestorData();
  return () => controller.abort();
}, [stockInfo]);
async function handleSearch(selection?: { code: string; name: string }) {
  const searchTerm = selection?.name ?? query.trim();
  if (searchTerm === "") return;
  setSearchError(null);
  if (selection) setQuery(selection.name);
setPageView("home");
setActiveTab("technical");
const requestId = ++searchRequestIdRef.current;
searchControllerRef.current?.abort();
const searchController = new AbortController();
searchControllerRef.current = searchController;
selectedCodeRef.current = null;
setStockInfo(null);
setSearchedStock(null);
setRealtimePrice(null);
setPriceInfo(null);
setPriceHistory([]);
setPriceMeta(null);
setRealtimeError(null);
setPriceError(null);
setPriceRequestStatus("loading");
setInvestorData(null);
setCompanyAnalysis(null);
setCompanyAnalysisError(null);
setCompanyAnalysisLoading(true);
setMarketAnalysis(null); setIntradayAnalysis(null); setMarketAnalysisError(null); setIntradayError(null);
setLoading(true);
  try {
    const response = await fetch(
      `/api/stock?query=${encodeURIComponent(searchTerm)}`,
      { signal: searchController.signal }
    );

    const data = await response.json();
    if (requestId !== searchRequestIdRef.current) return;
    if (!response.ok) throw new Error(data?.error ?? "종목 검색에 실패했습니다.");

    if (data.items && data.items.length > 0) {
      const exactMatch = data.items.find(
  (item: { itmsNm: string; srtnCd: string }) => selection
    ? item.srtnCd.replace(/^A/, "") === selection.code
    : item.itmsNm === searchTerm
);

const selectedItem = exactMatch ?? data.items[0];
 setStockInfo(selectedItem);
setSearchedStock(selectedItem.itmsNm);
if (selection) requestAnimationFrame(() => pageTopRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));

const stockCode = selectedItem.srtnCd.replace(/^A/, "");
selectedCodeRef.current = stockCode;

const isCurrentSearch = () => requestId === searchRequestIdRef.current && selectedCodeRef.current === stockCode;
const tasks = [
  settleSearchRequest(fetch(`/api/price?code=${stockCode}`, { signal: searchController.signal }), "공식 종가 조회 실패").then((result) => {
    if (!isCurrentSearch()) return;
    const priceData = result.data;
    if (result.status === "success" && priceData?.code === stockCode && Array.isArray(priceData.items) && priceData.items.length > 0) {
      setPriceInfo(priceData.items[0]);
      setPriceHistory(priceData.items);
      setPriceMeta({ code: priceData.code, source: priceData.source, priceBasis: priceData.priceBasis, asOfDate: priceData.asOfDate, closePrice: priceData.closePrice });
      setPriceError(null);
      setPriceRequestStatus("success");
    } else {
      setPriceInfo(null);
      setPriceHistory([]);
      setPriceMeta(null);
      setPriceError(result.status === "success" ? "공식 종가 응답이 현재 종목과 일치하지 않습니다." : result.errorMessage);
      setPriceRequestStatus(result.status === "missing" ? "missing" : result.status === "unavailable" ? "unavailable" : "error");
    }
  }),
  settleSearchRequest(fetch(`/api/realtime?code=${stockCode}`, { signal: searchController.signal }), "현재 시세 조회 실패").then((result) => {
    if (!isCurrentSearch()) return;
    const realtimeData = result.data;
    if (result.status === "success" && realtimeData?.code === stockCode && Number.isFinite(realtimeData.price) && realtimeData.price > 0) {
      setRealtimePrice(realtimeData);
      setRealtimeError(null);
    } else {
      setRealtimePrice(null);
      setRealtimeError(result.status === "success" ? "현재 시세 응답이 올바르지 않습니다." : result.errorMessage);
    }
  }),
  settleSearchRequest(fetch(`/api/company-analysis?code=${stockCode}`, { signal: searchController.signal, cache: "no-store" }), "저장된 기업분석 결과가 없습니다.").then((result) => {
    if (!isCurrentSearch()) return;
    setCompanyAnalysis(result.status === "success" ? result.data : null);
    setCompanyAnalysisError(result.status === "success" ? null : result.errorMessage);
    setCompanyAnalysisLoading(false);
  }),
  settleSearchRequest(fetch(`/api/market-analysis?code=${stockCode}`, { signal: searchController.signal, cache: "no-store" }), "저장된 시장분석 결과가 없습니다.").then((result) => {
    if (!isCurrentSearch()) return;
    setMarketAnalysis(result.status === "success" ? result.data : null);
    setMarketAnalysisError(result.status === "success" ? null : result.errorMessage);
  }),
  settleSearchRequest(fetch(`/api/intraday-market-analysis?code=${stockCode}`, { signal: searchController.signal, cache: "no-store" }), "장중 참고 분석 조회 실패").then((result) => {
    if (!isCurrentSearch()) return;
    setIntradayAnalysis(result.status === "success" ? result.data : null);
    setIntradayError(result.status === "success" ? null : analysisAvailabilityMessage("INTRADAY_UNAVAILABLE"));
  }),
];
const taskResults = await Promise.allSettled(tasks);
const aborted = taskResults.find((result) => result.status === "rejected" && result.reason instanceof DOMException && result.reason.name === "AbortError");
if (aborted?.status === "rejected") throw aborted.reason;


} else {
      setSearchError("notFound");
    }
  } catch (error) {
    if (requestId !== searchRequestIdRef.current || (error instanceof DOMException && error.name === "AbortError")) return;
    console.error(error);
    setSearchError("request");
  }
  finally {
  if (requestId === searchRequestIdRef.current) setCompanyAnalysisLoading(false);
  if (requestId === searchRequestIdRef.current) setLoading(false);
}
}
function handleHome() {
  searchRequestIdRef.current += 1;
  searchControllerRef.current?.abort();
  searchControllerRef.current = null;
  selectedCodeRef.current = null;
  setQuery("");
  setSearchError(null);
  setSearchedStock(null);
  setStockInfo(null);
  setRealtimePrice(null);
  setPriceInfo(null);
  setPriceHistory([]);
  setPriceMeta(null);
  setInvestorData(null);
  setCompanyAnalysis(null);
  setCompanyAnalysisError(null);
  setCompanyAnalysisLoading(false);
  setMarketAnalysis(null);
  setIntradayAnalysis(null);
  setMarketAnalysisError(null);
  setIntradayError(null);
  setRealtimeError(null);
  setPriceError(null);
  setPriceRequestStatus("idle");
  setActiveTab("technical");
  setPageView("home");
  setLoading(false);
  requestAnimationFrame(() => pageTopRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
}
useEffect(() => {
  if (!mobileNavOpen) return;
  const handleEscape = (event: KeyboardEvent) => {
    if (event.key === "Escape") setMobileNavOpen(false);
  };
  document.addEventListener("keydown", handleEscape);
  return () => document.removeEventListener("keydown", handleEscape);
}, [mobileNavOpen]);
const openSearchFromNavigation = () => {
  handleHome();
  setMobileNavOpen(false);
  requestAnimationFrame(() => searchInputRef.current?.focus());
};
const openModelsFromNavigation = () => {
  handleHome();
  setModelPageTab("top");
  setPageView("models");
  setMobileNavOpen(false);
};
const openScreenerFromNavigation = () => {
  handleHome();
  setPageView("screener");
  setMobileNavOpen(false);
};
const navigationButtons = (closeOnSelect: boolean) => <>
  <button type="button" onClick={() => { handleHome(); if (closeOnSelect) setMobileNavOpen(false); }} className={`tb-focus flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm font-semibold ${pageView === "home" ? "bg-[rgba(182,91,50,0.13)] text-[var(--tb-orange)]" : "text-slate-300 hover:bg-white/10 hover:text-white"}`}><span aria-hidden="true">⌂</span> 홈</button>
  <button type="button" onClick={openSearchFromNavigation} className="tb-focus flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm font-medium text-slate-300 hover:bg-white/10 hover:text-white"><span aria-hidden="true">⌕</span> 종목 분석</button>
  <button type="button" onClick={openModelsFromNavigation} className={`tb-focus flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm font-semibold ${pageView === "models" ? "bg-[rgba(182,91,50,0.13)] text-[var(--tb-orange)]" : "text-slate-300 hover:bg-white/10 hover:text-white"}`}><span aria-hidden="true">▦</span> 모델</button>
  <div className="my-3 border-t border-white/10" />
  <button type="button" onClick={openScreenerFromNavigation} className={`tb-focus flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm font-semibold ${pageView === "screener" ? "bg-[rgba(182,91,50,0.13)] text-[var(--tb-orange)]" : "text-slate-300 hover:bg-white/10 hover:text-white"}`}><span aria-hidden="true">▽</span> 스크리닝</button>
  {[['▥', '시장 현황'], ['⌁', '백테스트'], ['☆', '관심 종목']].map(([icon, label]) => <div key={label} className="tb-muted-nav flex items-center gap-3 rounded-lg px-3 py-2 text-xs font-medium" aria-disabled="true"><span aria-hidden="true">{icon}</span><span>{label}</span><span className="ml-auto text-[8px] uppercase tracking-wider">준비 중</span></div>)}
</>;
return (
    <main ref={pageTopRef} className="tb-page-ambient min-h-screen text-slate-900">
      <header className="tb-brand-shell sticky top-0 z-30 border-b border-white/10 text-white shadow-[0_8px_25px_rgba(7,18,40,0.14)]">
        <div className="flex w-full items-center gap-3 px-3 py-2 sm:gap-4 sm:px-6 lg:px-6">
          <button type="button" onClick={() => setMobileNavOpen(true)} aria-label="메뉴 열기" aria-expanded={mobileNavOpen} className="tb-focus inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-white/15 text-xl leading-none text-white hover:bg-white/10 sm:hidden">☰</button>
          <button type="button" onClick={handleHome} className="tb-focus shrink-0 rounded-xl text-left" aria-label="Tight Budget 홈으로">
            <BrandMark inverse />
          </button>
          <form className="ml-auto hidden min-w-0 flex-1 gap-2 sm:flex sm:max-w-xl" onSubmit={(event) => { event.preventDefault(); void handleSearch(); }}>
            <label className="sr-only" htmlFor="header-stock-search">종목명 또는 종목코드 검색</label>
            <input id="header-stock-search" value={query} onChange={(event) => setQuery(event.target.value)} disabled={loading} placeholder="종목명 또는 종목코드 검색" className="tb-focus min-w-0 flex-1 rounded-full border border-white/15 bg-white/10 px-5 py-2.5 text-sm text-white placeholder:text-slate-300 focus:border-white/35 focus:bg-white/15 focus:outline-none" />
            <button type="submit" disabled={loading} className="tb-focus rounded-full bg-[var(--tb-orange)] px-5 py-2.5 text-sm font-bold text-white hover:bg-[var(--tb-orange-bright)] disabled:opacity-40">{loading ? "조회 중" : "검색"}</button>
          </form>
        </div>
        {searchedStock && <form className="flex gap-2 border-t border-white/10 px-4 py-2.5 sm:hidden" onSubmit={(event) => { event.preventDefault(); void handleSearch(); }}>
          <label className="sr-only" htmlFor="mobile-header-stock-search">종목명 또는 종목코드 검색</label>
          <input id="mobile-header-stock-search" value={query} onChange={(event) => setQuery(event.target.value)} disabled={loading} placeholder="종목명 또는 종목코드 검색" className="tb-focus min-w-0 flex-1 rounded-full border border-white/15 bg-white/10 px-4 py-2 text-sm text-white placeholder:text-slate-300 focus:outline-none" />
          <button type="submit" disabled={loading} className="tb-focus rounded-full bg-[var(--tb-orange)] px-4 py-2 text-sm font-bold text-white disabled:opacity-40">{loading ? "조회 중" : "검색"}</button>
        </form>}
      </header>
      {mobileNavOpen && <div className="fixed inset-0 z-50 sm:hidden" role="presentation">
        <button type="button" aria-label="메뉴 바깥 닫기" onClick={() => setMobileNavOpen(false)} className="absolute inset-0 h-full w-full bg-slate-950/55" />
        <aside role="dialog" aria-modal="true" aria-label="모바일 주요 메뉴" className="tb-sidebar-surface relative flex h-full w-[min(18rem,calc(100vw-2.5rem))] max-w-full flex-col overflow-y-auto px-3 py-4 shadow-2xl">
          <div className="mb-4 flex items-center justify-between gap-3 border-b border-white/10 px-2 pb-3"><span className="text-sm font-semibold text-white">주요 메뉴</span><button type="button" onClick={() => setMobileNavOpen(false)} aria-label="메뉴 닫기" className="tb-focus rounded-lg px-2 py-1 text-xl leading-none text-slate-200 hover:bg-white/10">×</button></div>
          <nav className="space-y-1" aria-label="모바일 주요 메뉴">{navigationButtons(true)}</nav>
        </aside>
      </div>}
      <div className="relative z-[1] flex w-full items-stretch">
        <aside className="tb-sidebar-surface hidden w-52 shrink-0 border-r border-[var(--tb-border)] px-3 py-4 lg:flex lg:min-h-[calc(100vh-60px)] lg:flex-col">
          <nav className="space-y-1" aria-label="주요 메뉴">
            {navigationButtons(false)}
          </nav>
        </aside>
        <div className="min-w-0 flex-1 px-3 py-3 sm:px-4 sm:py-4 lg:px-4 xl:px-5">
        {!searchedStock && pageView === "home" && <section className="mb-3 grid grid-cols-2 gap-2 xl:grid-cols-4" aria-label="시장 데이터 연결 상태">
          {[{ label: "KOSPI", note: "공식 지수 소스" }, { label: "KOSDAQ", note: "공식 지수 소스" }, { label: "KRW / USD", note: "검증 환율 소스" }, { label: "거래대금", note: "시장 집계 소스" }].map((item) => <div key={item.label} className="tb-market-status-panel px-4 py-3"><div className="flex items-center justify-between gap-3"><p className="text-[11px] font-medium tracking-[0.08em] text-slate-300">{item.label}</p><span className="rounded-full border border-white/10 px-2 py-0.5 text-[9px] text-slate-400">준비 중</span></div><p className="mt-1.5 text-sm font-light text-slate-100">데이터 연결 전</p><p className="mt-0.5 text-[10px] text-slate-400">{item.note} 확인 후 제공</p></div>)}
        </section>}
        {!searchedStock && pageView === "home" && <div>
        <section className="tb-matte-hero relative overflow-hidden rounded-[18px] px-6 py-6 text-white sm:px-8 sm:py-7">
          <div aria-hidden="true" className="absolute -bottom-10 right-1 z-[1] hidden opacity-90 lg:block"><BrandMark hero symbolOnly inverse /></div>
          <div className="relative z-[2] max-w-2xl lg:max-w-[74%]">
            <p className="text-sm font-medium text-[#d7a17f]">종목 검색</p>
          </div>
          <div className="relative z-[2] mt-4 flex flex-col gap-2 sm:max-w-2xl sm:flex-row lg:max-w-[74%]">
          <input
  ref={searchInputRef}
  type="text"
  value={query}
  onChange={(e) => setQuery(e.target.value)}
  onKeyDown={(e) => {
    if (e.key === "Enter") {
      void handleSearch();
    }
  }}
  disabled={loading}
  placeholder="종목명 또는 종목코드를 검색하세요"
className="tb-focus min-h-11 w-full rounded-full border border-white/20 bg-[rgba(247,246,242,0.94)] px-5 py-2.5 text-sm text-slate-950 shadow-[0_10px_30px_rgba(2,10,26,0.16)] placeholder:text-slate-400 focus:border-[#c6835d] focus:outline-none"/>

          <button
  onClick={() => void handleSearch()}
  disabled={loading}
  className="tb-focus min-h-11 whitespace-nowrap rounded-full bg-[var(--tb-orange)] px-7 py-2.5 text-sm font-medium text-white shadow-sm transition-colors hover:bg-[var(--tb-orange-bright)] disabled:opacity-40"
>
  {loading ? "검색 중" : "검색"}
</button>
          </div>
        </section>
        </div>}

        {searchError && <p role="alert" className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">{searchError === "notFound" ? "해당 종목을 찾을 수 없습니다." : "검색 중 문제가 발생했습니다. 잠시 후 다시 시도해 주세요."}</p>}
        {!searchedStock && pageView === "home" && <p className="mt-2 px-1 text-[10px] text-slate-600">
          종목명 또는 종목코드를 입력하세요.
        </p>}

        {!searchedStock && pageView === "models" && (
          <section aria-labelledby="models-heading">
            <div className="tb-card p-4 sm:p-6">
              <p className="text-xs font-bold uppercase tracking-[0.15em] text-[var(--tb-orange)]">Research models</p>
              <h1 id="models-heading" className="mt-1 text-2xl font-bold tracking-tight text-slate-950 sm:text-3xl">모델</h1>
              <p className="mt-2 text-sm text-slate-600">동결된 공식 일봉 순위와 확정된 과거 성과를 분리해 확인합니다.</p>
              <div className="mt-5 flex gap-1 border-b border-slate-200/80" role="tablist" aria-label="모델 화면 탭">
                <button type="button" role="tab" aria-selected={modelPageTab === "top"} onClick={() => setModelPageTab("top")} className={`tb-focus -mb-px border-b-2 px-4 py-2.5 text-sm font-semibold ${modelPageTab === "top" ? "border-[var(--tb-orange)] text-[var(--tb-orange)]" : "border-transparent text-slate-500 hover:text-slate-900"}`}>모델 TOP</button>
                <button type="button" role="tab" aria-selected={modelPageTab === "performance"} onClick={() => setModelPageTab("performance")} className={`tb-focus -mb-px border-b-2 px-4 py-2.5 text-sm font-semibold ${modelPageTab === "performance" ? "border-[var(--tb-orange)] text-[var(--tb-orange)]" : "border-transparent text-slate-500 hover:text-slate-900"}`}>모델 성과</button>
                <button type="button" role="tab" aria-selected={modelPageTab === "guide"} onClick={() => setModelPageTab("guide")} className={`tb-focus -mb-px border-b-2 px-4 py-2.5 text-sm font-semibold ${modelPageTab === "guide" ? "border-[var(--tb-orange)] text-[var(--tb-orange)]" : "border-transparent text-slate-500 hover:text-slate-900"}`}>모델 설명</button>
              </div>
            </div>
            {modelPageTab === "top" ? <TopStocksPanel onSelectStock={handleSearch} /> : modelPageTab === "performance" ? <ModelTopPerformancePanel /> : <ModelExplanationPanel />}
          </section>
        )}

        {!searchedStock && pageView === "screener" && <StockScreenerPanel onSelectStock={handleSearch} />}

        {searchedStock && (
          <div className="tb-card mt-8 overflow-hidden p-5 sm:p-7">
            <p className="text-xs font-bold uppercase tracking-[0.16em] text-[var(--tb-blue)]">Stock Detail</p>

            <h2 className="mt-2 text-3xl font-extrabold tracking-tight text-slate-950">
              {searchedStock}
            </h2>

           <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-gray-500">
  <span>{stockInfo?.srtnCd?.replace(/^A/, "")}</span><span>{stockInfo?.mrktCtg}</span>
</div>
{(priceInfo || realtimePrice || priceError || realtimeError) && (
  <div className="mt-5 rounded-xl bg-gray-50 p-4">
    <p className="text-sm font-semibold text-gray-900">
      최근 시세
    </p>

    <div className="mt-3 space-y-3 text-sm text-gray-700">
      <div className="flex items-end justify-between gap-4">
  <span className="text-gray-500">{verifiedRealtimePrice ? "KIS 최근 조회가" : "최근 거래일 공식 종가"}</span>
  <strong className="text-2xl text-gray-950">
  {verifiedRealtimePrice
    ? `${verifiedRealtimePrice.price.toLocaleString()}원`
    : priceMeta
    ? `${priceMeta.closePrice.toLocaleString()}원`
    : "-"}
</strong>
</div>
{(verifiedRealtimePrice || priceInfo) && <div className="flex justify-between"><span>전일 대비</span><strong className={(verifiedRealtimePrice?.rate ?? Number(priceInfo?.fltRt ?? 0)) > 0 ? "text-[var(--tb-positive)]" : (verifiedRealtimePrice?.rate ?? Number(priceInfo?.fltRt ?? 0)) < 0 ? "text-[var(--tb-negative)]" : "text-slate-700"}>{(verifiedRealtimePrice?.change ?? (priceInfo?.vs ? Number(priceInfo.vs) : 0)).toLocaleString()}원 · {(verifiedRealtimePrice?.rate ?? (priceInfo?.fltRt ? Number(priceInfo.fltRt) : 0)).toFixed(2)}%</strong></div>}
{realtimePrice && !verifiedRealtimePrice && priceMeta && <div className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800"><p className="font-semibold">실시간 시세 확인 불가</p><p>표시된 가격은 {priceMeta.asOfDate} 공식 종가 기준입니다.</p></div>}
{realtimeError && <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">실시간 시세를 확인할 수 없습니다.{priceMeta ? ` 표시된 가격은 ${priceMeta.asOfDate} 공식 종가 기준입니다.` : ""}</p>}
{priceError && <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">{priceError}</p>}
{(verifiedRealtimePrice || priceInfo) && (
<details className="rounded-lg border border-gray-200 bg-white"><summary className="cursor-pointer px-3 py-2.5 font-medium text-gray-600">시세 상세보기</summary><div className="space-y-2 border-t border-gray-100 p-3">
<div className="flex justify-between">
  <span>전일 종가</span>
  <span>
    {verifiedRealtimePrice
  ? (verifiedRealtimePrice.price - verifiedRealtimePrice.change).toLocaleString()
  : priceHistory[1]?.clpr
  ? Number(priceHistory[1].clpr).toLocaleString()
  : "-"}원
  </span>
</div>

      <div className="flex justify-between">
        <span>전일 대비</span>
        <span>
  {(
    verifiedRealtimePrice?.change ??
    (priceInfo?.vs ? Number(priceInfo.vs) : 0)
  ).toLocaleString()}원
</span>
      </div>

      <div className="flex justify-between">
  <span>등락률</span>
  <span>
  {(
    verifiedRealtimePrice?.rate ??
    (priceInfo?.fltRt ? Number(priceInfo.fltRt) : 0)
  ).toFixed(2)}%
</span>
</div>

      <div className="flex justify-between">
        <span>거래량</span>
        <span>
  {(
    verifiedRealtimePrice?.volume ??
    (priceInfo?.trqu ? Number(priceInfo.trqu) : 0)
  ).toLocaleString()}주
</span>
      </div>
      {priceInfo && (
      <>
      <div className="flex justify-between">
  <span>시가총액</span>
  <span>
    {Math.round(Number(priceInfo.mrktTotAmt) / 100000000).toLocaleString()}억
  </span>
</div>

      <div className="flex justify-between">
        <span>시가</span>
        <span>{Number(priceInfo.mkp).toLocaleString()}원</span>
      </div>
      </>
      )}

      <div className="flex justify-between">
        <span>고가</span>
        <span>
  {(
    verifiedRealtimePrice?.high ??
    (priceInfo?.hipr ? Number(priceInfo.hipr) : 0)
  ).toLocaleString()}원
</span>
      </div>

      <div className="flex justify-between">
        <span>저가</span>
        <span>
  {(
    verifiedRealtimePrice?.low ??
    (priceInfo?.lopr ? Number(priceInfo.lopr) : 0)
  ).toLocaleString()}원
</span>
      </div>

</div></details>
)}

      <div className="flex justify-between">
  <span>가격 기준</span>
  <span>
    {verifiedRealtimePrice
      ? `KIS · ${verifiedRealtimePrice.asOfDate}${verifiedRealtimePrice.asOfTime ? ` ${verifiedRealtimePrice.asOfTime}` : ""}`
      : priceMeta
      ? `${priceMeta.asOfDate} · 공식 일봉 종가`
      : "가격 정보 없음"}
  </span>
</div>
    </div>
  </div>
)}

<details className="mt-4 text-xs text-gray-500">
  <summary className="cursor-pointer font-medium text-gray-600">종목·가격 데이터 기준 자세히 보기</summary>
  <div className="mt-3 grid gap-2 rounded-xl bg-gray-50 p-4 sm:grid-cols-2">
    <span>법인명 {stockInfo?.corpNm || "정보 없음"}</span><span>ISIN {stockInfo?.isinCd || "정보 없음"}</span>
    <span>종목 기준일 {stockInfo?.basDt ? `${stockInfo.basDt.slice(0, 4)}-${stockInfo.basDt.slice(4, 6)}-${stockInfo.basDt.slice(6, 8)}` : "정보 없음"}</span>
    <span>{verifiedRealtimePrice ? "검증된 실시간 가격 적용" : "공식 일봉 가격 기준"}</span>
  </div>
</details>

            <section className="mt-6 border-t border-gray-100 pt-6">
              <div className="flex items-end justify-between gap-4"><div><p className="text-sm font-semibold text-gray-500">분석 요약</p><h3 className="mt-1 text-xl font-bold text-gray-950">핵심 결과를 한눈에</h3></div><span className="text-xs text-gray-400">검증된 데이터만 표시</span></div>
              <div className="mt-4 divide-y divide-slate-100 rounded-2xl border border-[var(--tb-border)] bg-slate-50/70 px-4 sm:grid sm:grid-cols-3 sm:divide-x sm:divide-y-0 sm:px-0">
                <div className="flex items-center justify-between py-4 sm:block sm:px-5"><span className="text-sm text-gray-500">기술 흐름</span><div className="text-right sm:mt-2 sm:text-left">{technicalStrength.status === "available" ? <><strong className="text-xl text-gray-950">{technicalStrength.score}</strong><span className="ml-1 text-xs text-gray-400">/ 100</span><p className="text-sm font-semibold text-gray-700">분석 모델 검증 중</p></> : <strong className="text-sm text-gray-700">{technicalStrength.status === "loading" ? "분석 준비 중" : analysisAvailabilityMessage(technicalStrength.reason)}</strong>}</div></div>
                <div className="flex items-center justify-between py-4 sm:block sm:px-5"><span className="text-sm text-gray-500">기업 재무</span><div className="max-w-52 text-right sm:mt-2 sm:text-left">{companyAnalysisLoading ? <strong className="text-sm text-gray-700">분석 준비 중</strong> : companyAnalysis?.record?.eligible ? <><strong className="text-xl text-gray-950">{companyAnalysis.record.totalScore}</strong><span className="ml-1 text-xs text-gray-400">/ 100</span><p className="text-sm font-semibold text-gray-700">{companyAnalysis.record.grade}</p></> : <strong className="text-sm text-gray-700">{companyAnalysis?.record?.ineligibleReasons?.[0] ? companyAnalysisRecordReasonLabel(companyAnalysis.record, companyAnalysis.record.ineligibleReasons[0]) : companyAnalysisError ? "기업분석을 이용할 수 없습니다." : "분석 준비 중"}</strong>}</div></div>
                <div className="flex items-center justify-between py-4 sm:block sm:px-5"><span className="text-sm text-gray-500">시장 흐름</span><div className="text-right sm:mt-2 sm:text-left">{marketAnalysisView.status === "available" ? <strong className="text-xl text-gray-950">{marketAnalysisView.data.record.technicalStatus}</strong> : <strong className="text-sm text-gray-700">{marketAnalysisView.status === "loading" ? "분석 준비 중" : analysisAvailabilityMessage(marketAnalysisView.reason, marketAnalysisError ?? undefined)}</strong>}</div></div>
              </div>
            </section>

            <div className="mt-7 grid grid-cols-2 gap-2 rounded-2xl bg-slate-100 p-1.5" role="tablist" aria-label="상세 분석">
              <button
  onClick={() => setActiveTab("technical")}
  role="tab" aria-selected={activeTab === "technical"}
  className={`tb-focus rounded-xl px-3 py-3 text-sm font-semibold ${activeTab === "technical" ? "bg-white text-[var(--tb-blue)] shadow-sm" : "text-slate-500"}`}
>
  기술·시장
</button>

              <button
  onClick={() => setActiveTab("company")}
  role="tab" aria-selected={activeTab === "company"}
  className={`tb-focus rounded-xl px-3 py-3 text-sm font-semibold ${activeTab === "company" ? "bg-white text-[var(--tb-blue)] shadow-sm" : "text-slate-500"}`}
>
  기업
</button>
            </div>
          </div>
        )}
{activeTab === "company" && searchedStock && (
  <CompanyAnalysisPanel result={companyAnalysis} loading={companyAnalysisLoading} error={companyAnalysisError} />
)}
{activeTab === "technical" && searchedStock && <TechnicalStrengthPanel view={technicalStrength} showScore={false} />}
{activeTab === "technical" && searchedStock && stockInfo?.srtnCd && (
  <MarketAnalysisPanel key={String(stockInfo.srtnCd)} data={marketAnalysisView.status === "available" ? marketAnalysisView.data : null} intraday={intradayAnalysis} investorData={investorData} loading={marketAnalysisView.status === "loading"} error={marketAnalysisView.status === "available" ? null : analysisAvailabilityMessage(marketAnalysisView.reason, marketAnalysisError ?? undefined)} source={marketAnalysisView.source ?? null} intradayError={intradayError} showHeadlineScore={false} />
)}
{false && searchedStock && (
  <div className="mt-6 rounded-2xl border border-gray-200 bg-white p-5">
    <p className="text-sm font-medium text-amber-700">데이터 준비 중</p>

    <h2 className="mt-1 text-xl font-bold text-gray-900">
      공매도 관련 시장 데이터
    </h2>
    <p className="mt-2 text-sm text-gray-500">공매도·대차잔고 데이터 연결 전이며 현재 분석 결과를 제공하지 않습니다.</p>

    <section className="mt-6">
      <div className="space-y-3 text-sm">
        <div className="flex justify-between">
          <span>공매도 거래 비중</span>
          <span>-</span>
        </div>

        <div className="flex justify-between">
          <span>공매도 잔고 비중</span>
          <span>-</span>
        </div>

        <div className="flex justify-between">
          <span>대차잔고 변화</span>
          <span>-</span>
        </div>

        <div className="flex justify-between">
          <span>최근 주가 변화</span>
          <span>-</span>
        </div>

        <div className="flex justify-between">
          <span>최근 거래량 변화</span>
          <span>-</span>
        </div>
      </div>
    </section>

    <section className="mt-8 border-t border-gray-100 pt-6">
      <h3 className="font-semibold text-gray-900">
        숏커버링 관련 관측 조건
      </h3>

      <div className="mt-3 flex justify-between text-sm">
        <span>충족 조건</span>
        <span>- / -</span>
      </div>

      <p className="mt-4 text-xs leading-5 text-gray-400">
        ※ 공매도, 대차, 가격 및 거래량 데이터에서 특정 조건의 동시 발생
        여부를 표시합니다. 향후 주가 상승 또는 숏스퀴즈 발생을 예측하지
        않습니다.
      </p>
    </section>
  </div>
)}
{false && searchedStock && (
  <div className="mt-6 rounded-2xl border border-gray-200 bg-white p-5">
    <p className="text-sm text-gray-500">Dividend View</p>

    <h2 className="mt-1 text-xl font-bold text-gray-900">
      배당 분석
    </h2>

    <section className="mt-8">
      <h3 className="font-semibold text-gray-900">
        배당 현황
      </h3>

      <div className="mt-3 space-y-2 text-sm">
        <div className="flex justify-between">
          <span>배당수익률</span>
          <span>-</span>
        </div>

        <div className="flex justify-between">
          <span>DPS</span>
          <span>-</span>
        </div>

        <div className="flex justify-between">
          <span>배당성향</span>
          <span>-</span>
        </div>
      </div>
    </section>

    <section className="mt-8">
      <h3 className="font-semibold text-gray-900">
        배당 성장
      </h3>

      <div className="mt-3 space-y-2 text-sm">
        <div className="flex justify-between">
          <span>최근 3년 DPS 변화</span>
          <span>-</span>
        </div>

        <div className="flex justify-between">
          <span>배당 성장률</span>
          <span>-</span>
        </div>
      </div>
    </section>

    <section className="mt-8">
      <h3 className="font-semibold text-gray-900">
        배당 지속성
      </h3>

      <div className="mt-3 space-y-2 text-sm">
        <div className="flex justify-between">
          <span>연속 배당 기간</span>
          <span>-</span>
        </div>

        <div className="flex justify-between">
          <span>최근 배당 중단 여부</span>
          <span>-</span>
        </div>
      </div>
    </section>

    <p className="mt-6 text-xs leading-5 text-gray-400">
      ※ 배당 관련 과거 및 현재 데이터를 표시하며, 향후 배당 지급 여부나
      배당 확대를 예측하지 않습니다.
    </p>
  </div>
)}
{searchedStock && <section className="mt-6 rounded-xl border border-dashed border-gray-300 bg-gray-50 px-5 py-4"><h2 className="text-sm font-semibold text-gray-800">추가 분석 준비 중</h2><p className="mt-1 text-sm text-gray-500">배당 · 공매도 · 대차잔고 데이터를 안전하게 연결하고 있습니다.</p></section>}
      </div>
      </div>
    </main>
  );
}
