"use client";

import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import TopStocksPanel from "../components/TopStocksPanel";
import ModelTopPerformancePanel from "../components/ModelTopPerformancePanel";
import ModelExplanationPanel from "../components/ModelExplanationPanel";
import MarketAnalysisPanel, { type MarketAnalysisResponse, type IntradayAnalysisResponse } from "../components/market-analysis/MarketAnalysisPanel";
import CompanyAnalysisPanel, { companyAnalysisRecordReasonLabel, type CompanyAnalysisResult } from "../components/company-analysis/CompanyAnalysisPanel";
import TechnicalStrengthPanel from "../components/TechnicalStrengthPanel";
import WatchlistStar, { WatchlistProvider } from "../components/WatchlistStar";
import StockScreenerPanel from "../components/StockScreenerPanel";
import HomeDashboard from "../components/HomeDashboard";
import type { TransitionMode } from "../components/LiveTransitionDetails";
import DailyCandles, {type CandleData} from "../components/DailyCandles";
import StockResearchPanel from "../components/StockResearchPanel";
import AdminLogout from "../components/AdminLogout";
import WatchlistPanel from "../components/WatchlistPanel";
import MarketOverviewPanel from "../components/MarketOverviewPanel";
import BacktestPanel from "../components/BacktestPanel";
import { searchApiErrorMessage, settleSearchRequest, selectVerifiedStock, stockChoices } from "../lib/search-request-isolation.mjs";
import { buildSearchTechnicalStrength } from "../lib/search-technical-strength.mjs";
import { buildSearchMarketAnalysis } from "../lib/search-market-analysis.mjs";
import { analysisAvailabilityMessage } from "../lib/analysis-availability.mjs";
import { isVerifiedKisRealtimeQuote } from "../lib/kis-quote-display-policy.mjs";
const navigationPaths = {
  home: "m3 10 9-7 9 7v10H3z M9 20v-7h6v7",
  market: "M3 3v17h18 M6 14l4-4 4 2 6-7",
  top: "M8 6h12 M8 12h9 M8 18h5 M3 6h1 M3 12h1 M3 18h1",
  performance: "M3 3v17h18 M7 16v-5 M12 16V6 M17 16V9",
  screener: "M3 6h8m4 0h6 M3 12h3m4 0h11 M3 18h11m4 0h3 M11 4v4 M6 10v4 M14 16v4",
  watchlist: "m12 3 2.8 5.8 6.4.9-4.6 4.5 1.1 6.3-5.7-3-5.7 3 1.1-6.3-4.6-4.5 6.4-.9z",
  backtest: "M9 3h6 M10 3v6L4 19q0 2 2 2h12q2 0 2-2L14 9V3 M7 15h10",
  search: "M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0 M15.5 15.5 21 21",
  menu: "M3 6h18 M3 12h18 M3 18h18", close: "M5 5l14 14 M19 5 5 19",
};
const navigation = [
  { icon: "home", label: "홈" }, { icon: "market", label: "시장 현황" },
  { icon: "top", label: "모델 TOP" }, { icon: "performance", label: "모델 성과" },
  { icon: "screener", label: "스크리닝" }, { icon: "watchlist", label: "관심종목" },
  { icon: "backtest", label: "백테스트" }, { icon: "search", label: "종목 분석" },
] as const;
function NavIcon({ icon }: { icon: keyof typeof navigationPaths }) {
  return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className="h-[19px] w-[19px] shrink-0"><path d={navigationPaths[icon]}/></svg>;
}
type PageView = "home" | "models" | "screener" | "market" | "backtest" | "watchlist";
export default function Home() {
  return <WatchlistProvider><ResearchApp /></WatchlistProvider>;
}
function ResearchApp() {
  const [query, setQuery] = useState("");
  const [searchedStock, setSearchedStock] = useState<string | null>(null);
const [activeTab, setActiveTab] = useState<"technical" | "company">("technical");
const [pageView, setPageView] = useState<PageView>("home");
const [modelPageTab, setModelPageTab] = useState<"top" | "performance" | "guide">("top");
const [modelInitialTab, setModelInitialTab] = useState("B");
const [screenerEntry, setScreenerEntry] = useState<{ tab: "models" | "transition"; pair: string; state: string; direction?: string; mode?: TransitionMode }>({ tab: "models", pair: "5-20", state: "all" });
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
  lastTrade?: { code: string; price: number; asOfDate: string; asOfTime: string; source: string } | null;
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
  const [matches,setMatches]=useState<{code:string;name:string;market:string}[]>([]);
const [realtimeError, setRealtimeError] = useState<string | null>(null);
const [priceError, setPriceError] = useState<string | null>(null);
const [priceRequestStatus, setPriceRequestStatus] = useState<"idle" | "loading" | "success" | "missing" | "error" | "unavailable">("idle");
const [priceMeta, setPriceMeta] = useState<{
  code: string;
  source: "officialDailyPrice";
  priceBasis: "officialDailyClose";
  candles?: CandleData;
  asOfDate: string;
  closePrice: number;
} | null>(null);
const [modelProfile, setModelProfile] = useState<"1400" | "1430" | "daily">("1400");
const menuTrigger = useRef<HTMLButtonElement>(null);
const menuDialog = useRef<HTMLElement>(null);
const searchRequestIdRef = useRef(0);
const searchControllerRef = useRef<AbortController | null>(null);
const selectedCodeRef = useRef<string | null>(null);
const pageTopRef = useRef<HTMLElement | null>(null);
const searchInputRef = useRef<HTMLInputElement | null>(null);
const explorerOriginRef = useRef<{ view: PageView; query: string; scrollY: number } | null>(null);
const routeInitializedRef = useRef(false);
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
const handleSearch = useCallback(async (selection?: { code: string; name: string; market?: string }, updateHistory = true) => {
  const searchTerm = selection?.code ?? query.trim();
  if (searchTerm === "") return;
  setMatches([]);
  setSearchError(null);
  if (!explorerOriginRef.current) explorerOriginRef.current = { view: pageView, query, scrollY: window.scrollY };
  if (selection) setQuery(selection.name || selection.code);
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
if (!selection && !/^[0-9A-Z]{6}$/.test(searchTerm)) {
  const choices=stockChoices(data.items);
  if(choices.length>1){setMatches(choices);setLoading(false);setPriceRequestStatus("idle");return;}
}
const selectedItem = selectVerifiedStock(data.items, selection, searchTerm);
if (!selectedItem) { setSearchError("notFound"); return; }
 setStockInfo(selectedItem);
setSearchedStock(selectedItem.itmsNm);
if (selection) requestAnimationFrame(() => pageTopRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));

const stockCode = selectedItem.srtnCd.replace(/^A/, "");
selectedCodeRef.current = stockCode;
if (updateHistory) {
  const url = new URL(window.location.href); url.searchParams.set("stock", stockCode);
  const state = { ...window.history.state, tbStock: { code: stockCode, name: selectedItem.itmsNm, market: selectedItem.mrktCtg, returnToExplorer: window.history.state?.tbStock?.returnToExplorer || !new URL(window.location.href).searchParams.has("stock") } };
  if (new URL(window.location.href).searchParams.has("stock")) window.history.replaceState(state, "", url);
  else window.history.pushState(state, "", url);
}

const isCurrentSearch = () => requestId === searchRequestIdRef.current && selectedCodeRef.current === stockCode;
const tasks = [
  settleSearchRequest(fetch(`/api/price?code=${stockCode}`, { signal: searchController.signal }), "공식 종가 조회 실패").then((result) => {
    if (!isCurrentSearch()) return;
    const priceData = result.data;
    if (result.status === "success" && priceData?.code === stockCode && Array.isArray(priceData.items) && priceData.items.length > 0) {
      setPriceInfo(priceData.items[0]);
      setPriceHistory(priceData.items);
      setPriceMeta({ code: priceData.code, source: priceData.source, priceBasis: priceData.priceBasis, asOfDate: priceData.asOfDate, closePrice: priceData.closePrice, candles:priceData.candles });
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
}, [pageView, query]);
const handleHome = useCallback((clearRoute = true) => {
  searchRequestIdRef.current += 1;
  searchControllerRef.current?.abort();
  searchControllerRef.current = null;
  selectedCodeRef.current = null;
  setQuery("");
  setMatches([]);
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
  if (clearRoute) {
    explorerOriginRef.current = null;
    const url = new URL(window.location.href); url.searchParams.delete("stock");
    const state = { ...window.history.state }; delete state.tbStock;
    window.history.replaceState(state, "", url);
  }
  requestAnimationFrame(() => pageTopRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
}, []);
const restoreExplorer = useCallback(() => {
  const origin = explorerOriginRef.current;
  handleHome(false);
  if (origin) { setPageView(origin.view); setQuery(origin.query); requestAnimationFrame(() => window.scrollTo({ top: origin.scrollY, behavior: "instant" })); }
  explorerOriginRef.current = null;
}, [handleHome]);
useEffect(() => {
  const restoreRoute = () => {
    const code = new URL(window.location.href).searchParams.get("stock");
    if (!code) { if (explorerOriginRef.current) restoreExplorer(); return; }
    if (!/^[0-9A-Z]{6}$/u.test(code)) return;
    const saved = window.history.state?.tbStock;
    void handleSearch({ code, name: saved?.code === code ? saved.name : "", market: saved?.code === code ? saved.market : undefined }, false);
  };
  window.addEventListener("popstate", restoreRoute);
  if (!routeInitializedRef.current) { routeInitializedRef.current = true; if (new URL(window.location.href).searchParams.has("stock")) restoreRoute(); }
  return () => window.removeEventListener("popstate", restoreRoute);
}, [handleSearch, restoreExplorer]);
useEffect(() => {
  if (!mobileNavOpen) return;
  const previousOverflow = document.body.style.overflow;
  document.body.style.overflow = "hidden";
  const dialog = menuDialog.current;
  dialog?.querySelector<HTMLButtonElement>("button")?.focus();
  const handleEscape = (event: KeyboardEvent) => {
    if (event.key === "Escape") { setMobileNavOpen(false); menuTrigger.current?.focus(); }
    if (event.key !== "Tab" || !dialog) return;
    const buttons = Array.from(dialog.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
    const first = buttons[0], last = buttons.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  };
  const desktop = window.matchMedia("(min-width: 1024px)");
  const closeAtDesktop = () => { if (desktop.matches) setMobileNavOpen(false); };
  desktop.addEventListener("change", closeAtDesktop);
  document.addEventListener("keydown", handleEscape);
  return () => { document.body.style.overflow = previousOverflow; document.removeEventListener("keydown", handleEscape); desktop.removeEventListener("change", closeAtDesktop); };
}, [mobileNavOpen]);
const openSearchFromNavigation = () => {
  handleHome();
  setMobileNavOpen(false);
  requestAnimationFrame(() => searchInputRef.current?.focus());
};
const openModelsFromNavigation = () => {
  handleHome();
  setModelPageTab("top");
  setModelInitialTab("B");
  setModelProfile("1400");
  setPageView("models");
  setMobileNavOpen(false);
};
const openScreenerFromNavigation = () => {
  handleHome();
  setPageView("screener");
  setScreenerEntry({ tab: "models", pair: "5-20", state: "all" });
  setMobileNavOpen(false);
};
const openTool = (view: "market" | "watchlist" | "backtest") => { handleHome(); setPageView(view); };
const navActions = {
  home: () => handleHome(), market: () => openTool("market"), top: openModelsFromNavigation,
  performance: () => { openModelsFromNavigation(); setModelPageTab("performance"); },
  screener: openScreenerFromNavigation, watchlist: () => openTool("watchlist"),
  backtest: () => openTool("backtest"), search: openSearchFromNavigation,
};
const selectedView = searchedStock ? "search" : pageView === "models"
  ? (modelPageTab === "performance" ? "performance" : "top") : pageView;
const navigationButtons = navigation.map(item =>
  <button key={item.icon} type="button" aria-current={selectedView === item.icon ? "page" : undefined}
    className="tb-focus flex min-h-11 w-full items-center gap-3 rounded-xl px-3.5 py-2.5 text-left text-[15px] font-medium text-slate-600 hover:bg-slate-50 aria-[current=page]:bg-[#eaf2ff] aria-[current=page]:font-semibold aria-[current=page]:text-[var(--tb-blue)]"
    onClick={() => { navActions[item.icon](); setMobileNavOpen(false); }}>
    <NavIcon icon={item.icon} />{item.label}
  </button>);
const closeMobileMenu = () => { setMobileNavOpen(false); menuTrigger.current?.focus(); };
return (
    <main ref={pageTopRef} className="min-h-dvh bg-[var(--tb-page)] text-[var(--tb-text)]">
      <a className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-2 focus:z-50 focus:rounded-lg focus:bg-white focus:p-3" href="#research-content">본문으로 이동</a>
      <header className="sticky top-0 z-30 border-b border-[var(--tb-border)] bg-white">
        <div className="flex w-full flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 sm:flex-nowrap sm:gap-5 sm:px-6 xl:px-8">
          <button type="button" ref={menuTrigger} onClick={() => setMobileNavOpen(true)} aria-label="메뉴 열기" aria-expanded={mobileNavOpen} aria-controls="mobile-navigation" className="tb-focus inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl hover:bg-slate-100 lg:hidden"><NavIcon icon="menu" /></button>
          <button type="button" onClick={() => handleHome()} className="tb-focus shrink-0 rounded-lg text-left text-[21px] font-bold tracking-tight" aria-label="Tight Budget 홈으로">Tight Budget</button>
          <form role="search" className="order-last flex w-full min-w-0 items-center gap-2 sm:order-none sm:ml-auto sm:max-w-md" onSubmit={(event) => { event.preventDefault(); void handleSearch(); }}>
            <label className="flex min-h-11 min-w-0 flex-1 items-center gap-2.5 rounded-xl bg-[#f5f7fb] px-3.5 text-slate-500 focus-within:ring-2 focus-within:ring-[var(--tb-blue)]" htmlFor="header-stock-search">
              <NavIcon icon="search" /><span className="sr-only">종목명 또는 종목코드 검색</span>
              <input ref={searchInputRef} id="header-stock-search" value={query} onChange={(event) => setQuery(event.target.value)} disabled={loading} placeholder="종목명 또는 종목코드 검색" className="min-w-0 flex-1 bg-transparent py-2 text-base text-[var(--tb-text)] outline-none placeholder:text-slate-500" />
            </label>
            <button type="submit" disabled={loading} className="tb-focus min-h-11 shrink-0 rounded-xl bg-[var(--tb-blue)] px-4 text-sm font-semibold text-white disabled:opacity-50">{loading ? "조회 중" : "검색"}</button>
          </form>
          <AdminLogout />
        </div>
      </header>
      {mobileNavOpen && <div className="fixed inset-0 z-50 lg:hidden" role="presentation">
        <button type="button" tabIndex={-1} aria-label="메뉴 바깥 닫기" onClick={closeMobileMenu} className="absolute inset-0 h-full w-full bg-slate-950/35" />
        <aside ref={menuDialog} id="mobile-navigation" role="dialog" aria-modal="true" aria-label="모바일 주요 메뉴" className="relative flex h-full w-[min(18rem,calc(100vw-2.5rem))] flex-col overflow-y-auto bg-white px-4 py-4 shadow-lg">
          <div className="mb-3 flex items-center justify-between border-b border-[var(--tb-border)] pb-2 pl-2"><span className="text-base font-semibold">메뉴</span><button type="button" onClick={closeMobileMenu} aria-label="메뉴 닫기" className="tb-focus inline-flex h-11 w-11 items-center justify-center rounded-xl hover:bg-slate-100"><NavIcon icon="close" /></button></div>
          <nav className="space-y-1" aria-label="모바일 주요 메뉴">{navigationButtons}</nav>
        </aside>
      </div>}
      <div className="flex w-full items-stretch">
        <aside className="hidden w-[190px] shrink-0 border-r border-[var(--tb-border)] bg-white px-3 lg:block xl:w-[200px]">
          <nav className="sticky top-[69px] max-h-[calc(100dvh-69px)] space-y-1 overflow-y-auto py-6" aria-label="주요 메뉴">
            {navigationButtons}
          </nav>
        </aside>
        <div id="research-content" tabIndex={-1} className="min-w-0 flex-1 px-4 py-5 sm:px-6 lg:px-7 lg:py-7 xl:px-9">
        {matches.length>1&&<section aria-label="검색 결과 선택" className="tb-card mb-4 p-4"><h2 className="font-semibold">조회할 종목을 선택하세요</h2>
          <ul>{matches.map(m=><li key={m.code}><button type="button" className="tb-focus min-h-11 text-left" onClick={()=>void handleSearch(m)}>{m.name} · {m.code} · {m.market}</button></li>)}</ul>
          <button type="button" onClick={()=>setMatches([])}>닫기</button></section>}
        {searchError && <p role="alert" className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">{searchError === "notFound" ? "해당 종목을 찾을 수 없습니다." : "검색 중 문제가 발생했습니다. 잠시 후 다시 시도해 주세요."}</p>}
        {pageView === "home" && <div hidden={Boolean(searchedStock)}><HomeDashboard
          onSelectStock={handleSearch}
          onOpenModel={(model, source) => { openModelsFromNavigation(); setModelInitialTab(model); setModelProfile(source === "EOD" ? "daily" : "1400"); }}
          onOpenPerformance={() => { openModelsFromNavigation(); setModelPageTab("performance"); }}
          onOpenTransition={(pair, state, direction, mode) => { openScreenerFromNavigation(); setScreenerEntry({ tab: "transition", pair, state, direction, mode }); }}
        /></div>}

        {!searchedStock && pageView === "models" && (
          <section aria-label="모델 분석">
            {modelPageTab === "top" ? <TopStocksPanel key={modelInitialTab} initialTab={modelInitialTab} onTabChange={setModelInitialTab} initialProfile={modelProfile} onProfileChange={setModelProfile} onSelectStock={handleSearch} onOpenGuide={() => setModelPageTab("guide")} /> : modelPageTab === "performance" ? <ModelTopPerformancePanel /> : <ModelExplanationPanel />}
          </section>
        )}

        {pageView === "screener" && <div hidden={Boolean(searchedStock)}><StockScreenerPanel onSelectStock={handleSearch} key={`${screenerEntry.tab}:${screenerEntry.pair}:${screenerEntry.state}:${screenerEntry.direction}:${screenerEntry.mode}`} initialTab={screenerEntry.tab} initialPair={screenerEntry.pair} initialState={screenerEntry.state} initialDirection={screenerEntry.direction} initialMode={screenerEntry.mode} /></div>}

        {!searchedStock && (pageView === "watchlist" || pageView === "market" || pageView === "backtest") &&
          <div className="tb-tool-page">{pageView === "watchlist" ? <WatchlistPanel onSelectStock={handleSearch} /> :
            pageView === "market" ? <MarketOverviewPanel /> : <BacktestPanel />}</div>}
        {searchedStock && (
          <div className="tb-card min-w-0 p-4 sm:p-6">
            <button type="button" onClick={() => { if (window.history.state?.tbStock?.returnToExplorer) window.history.back(); else { restoreExplorer(); const url = new URL(window.location.href); url.searchParams.delete("stock"); window.history.replaceState(window.history.state, "", url); } }} className="tb-focus rounded-lg border border-slate-200 px-3 py-2 text-xs font-medium">← 돌아가기</button>
            <div className="mt-2 flex items-center gap-2"><h1 className="min-w-0 break-words text-2xl font-bold tracking-tight text-slate-950 sm:text-[28px]">{searchedStock}</h1>
              {stockInfo && <WatchlistStar code={String(stockInfo.srtnCd).replace(/^A/, "")} name={searchedStock} />}</div>

           <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-gray-500">
  <span>{stockInfo?.srtnCd?.replace(/^A/, "")}</span><span>{stockInfo?.mrktCtg}</span><span>공식 EOD {priceMeta?.asOfDate ?? "기준일 미확인"}</span>

</div>
{(priceInfo || realtimePrice || priceError || realtimeError) && (
  <div className="mt-3 rounded-xl bg-[#f5f7fb] p-3">
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
{!verifiedRealtimePrice && realtimePrice?.lastTrade?.source === "KIS_MINUTE_TRADE" && realtimePrice.lastTrade.code === realtimePrice.code && <p className="text-xs text-slate-700">KIS 최근 확인 체결가 <strong>{realtimePrice.lastTrade.price.toLocaleString()}원</strong> · {realtimePrice.lastTrade.asOfDate} {realtimePrice.lastTrade.asOfTime} KST</p>}
{realtimePrice && !verifiedRealtimePrice && !realtimePrice.lastTrade && priceMeta && <div className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800"><p className="font-semibold">실시간 시세 확인 불가</p><p>표시된 가격은 {priceMeta.asOfDate} 공식 종가 기준입니다.</p></div>}
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

{stockInfo && <DailyCandles key={String(stockInfo.srtnCd)+":"+priceMeta?.asOfDate}
  title={searchedStock+" "+String(stockInfo.srtnCd).replace(/^A(?=.{6}$)/,"")} unit="원"
  data={priceMeta?.code===String(stockInfo.srtnCd).replace(/^A(?=.{6}$)/,"") ? priceMeta?.candles : null}
  loading={priceRequestStatus==="loading"} source="금융위원회 주식시세정보 · 한국거래소 · 공공데이터포털"
  retry={()=>void handleSearch({code:String(stockInfo.srtnCd).replace(/^A(?=.{6}$)/,""),name:searchedStock,market:stockInfo.mrktCtg},false)}/>}

<details className="mt-3 text-xs text-gray-500">
  <summary className="cursor-pointer font-medium text-gray-600">종목·가격 데이터 기준 자세히 보기</summary>
  <div className="mt-3 grid gap-2 rounded-xl bg-gray-50 p-4 sm:grid-cols-2">
    <span>법인명 {stockInfo?.corpNm || "정보 없음"}</span><span>ISIN {stockInfo?.isinCd || "정보 없음"}</span>
    <span>종목 기준일 {stockInfo?.basDt ? `${stockInfo.basDt.slice(0, 4)}-${stockInfo.basDt.slice(4, 6)}-${stockInfo.basDt.slice(6, 8)}` : "정보 없음"}</span>
    <span>{verifiedRealtimePrice ? "검증된 실시간 가격 적용" : "공식 일봉 가격 기준"}</span>
  </div>
</details>

            <section id="stock-technical" className="mt-3 scroll-mt-32 border-t border-gray-100 pt-3">
              <h3 className="text-xl font-bold text-gray-950">분석 요약</h3>
              <div className="mt-4 divide-y divide-slate-100 rounded-2xl border border-[var(--tb-border)] bg-slate-50/70 px-4 sm:grid sm:grid-cols-3 sm:divide-x sm:divide-y-0 sm:px-0">
                <div className="flex items-center justify-between py-4 sm:block sm:px-5"><span className="text-sm text-gray-500">기술 흐름</span><div className="text-right sm:mt-2 sm:text-left">{technicalStrength.status === "available" ? <><strong className="text-xl text-gray-950">{technicalStrength.score}</strong><span className="ml-1 text-xs text-gray-400">/ 100</span><p className="text-sm font-semibold text-gray-700">분석 모델 검증 중</p></> : <strong className="text-sm text-gray-700">{technicalStrength.status === "loading" ? "분석 준비 중" : analysisAvailabilityMessage(technicalStrength.reason)}</strong>}</div></div>
                <div className="flex items-center justify-between py-4 sm:block sm:px-5"><span className="text-sm text-gray-500">기업 재무</span><div className="max-w-52 text-right sm:mt-2 sm:text-left">{companyAnalysisLoading ? <strong className="text-sm text-gray-700">분석 준비 중</strong> : companyAnalysis?.record?.eligible ? <><strong className="text-xl text-gray-950">{companyAnalysis.record.totalScore}</strong><span className="ml-1 text-xs text-gray-400">/ 100</span><p className="text-sm font-semibold text-gray-700">{companyAnalysis.record.grade}</p></> : <strong className="text-sm text-gray-700">{companyAnalysis?.record?.ineligibleReasons?.[0] ? companyAnalysisRecordReasonLabel(companyAnalysis.record, companyAnalysis.record.ineligibleReasons[0]) : companyAnalysisError ? "기업분석을 이용할 수 없습니다." : "분석 준비 중"}</strong>}</div></div>
                <div className="flex items-center justify-between py-4 sm:block sm:px-5"><span className="text-sm text-gray-500">시장 흐름</span><div className="text-right sm:mt-2 sm:text-left">{marketAnalysisView.status === "available" ? <strong className="text-xl text-gray-950">{marketAnalysisView.data.record.technicalStatus}</strong> : <strong className="text-sm text-gray-700">{marketAnalysisView.status === "loading" ? "분석 준비 중" : analysisAvailabilityMessage(marketAnalysisView.reason, marketAnalysisError ?? undefined)}</strong>}</div></div>
              </div>
            </section>

            {stockInfo?.srtnCd && <StockResearchPanel key={String(stockInfo.srtnCd)} code={String(stockInfo.srtnCd).replace(/^A/, "")} />}
            <div className="mt-3 grid grid-cols-2 gap-2 rounded-xl bg-slate-100 p-1.5" role="tablist" aria-label="상세 분석">
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
      </div>
      </div>
    </main>
  );
}
