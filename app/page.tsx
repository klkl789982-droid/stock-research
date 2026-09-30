"use client";

import { useState, useEffect, useMemo, useRef } from "react";
import TopStocksPanel from "../components/TopStocksPanel";
import MarketAnalysisPanel, { type MarketAnalysisResponse, type IntradayAnalysisResponse } from "../components/market-analysis/MarketAnalysisPanel";
import CompanyAnalysisPanel, { companyAnalysisRecordReasonLabel, type CompanyAnalysisResult } from "../components/company-analysis/CompanyAnalysisPanel";
import TechnicalStrengthPanel from "../components/TechnicalStrengthPanel";
import { searchApiErrorMessage, settleSearchRequest } from "../lib/search-request-isolation.mjs";
import { buildSearchTechnicalStrength } from "../lib/search-technical-strength.mjs";
import { buildSearchMarketAnalysis } from "../lib/search-market-analysis.mjs";
import { analysisAvailabilityMessage } from "../lib/analysis-availability.mjs";
import { isVerifiedKisRealtimeQuote } from "../lib/kis-quote-display-policy.mjs";
export default function Home() {
  const [query, setQuery] = useState("");
  const [searchedStock, setSearchedStock] = useState<string | null>(null);
const [activeTab, setActiveTab] = useState<"technical" | "company">("technical");
const [showFullTop, setShowFullTop] = useState(false);
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
setShowFullTop(false);
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
  setShowFullTop(false);
  setLoading(false);
  requestAnimationFrame(() => pageTopRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
}
return (
    <main ref={pageTopRef} className="min-h-screen bg-[var(--tb-page)] text-slate-900">
      <header className="sticky top-0 z-30 border-b border-[var(--tb-border)] bg-white/95 backdrop-blur-sm">
        <div className="mx-auto flex max-w-7xl items-center gap-4 px-4 py-3 sm:px-6 lg:px-8">
          <button type="button" onClick={handleHome} className="tb-focus group flex shrink-0 items-center gap-3 rounded-xl text-left" aria-label="Tight Budget 홈으로">
            <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-[var(--tb-blue)] text-base font-black tracking-tighter text-white shadow-sm transition-transform group-hover:-translate-y-0.5">TB</span>
            <span className="hidden sm:block"><span className="block text-lg font-extrabold tracking-tight text-slate-950">Tight <span className="font-medium">Budget</span></span><span className="block text-[11px] text-slate-500">Data-driven stock research</span></span>
          </button>
          {searchedStock && <form className="ml-auto flex min-w-0 flex-1 gap-2 sm:max-w-xl" onSubmit={(event) => { event.preventDefault(); void handleSearch(); }}>
            <label className="sr-only" htmlFor="header-stock-search">종목명 또는 종목코드 검색</label>
            <input id="header-stock-search" value={query} onChange={(event) => setQuery(event.target.value)} disabled={loading} placeholder="종목명 또는 종목코드 검색" className="tb-focus min-w-0 flex-1 rounded-xl border border-[var(--tb-border)] bg-slate-50 px-4 py-2.5 text-sm text-slate-950 placeholder:text-slate-400 focus:border-blue-400 focus:bg-white focus:outline-none" />
            <button type="submit" disabled={loading} className="tb-focus rounded-xl bg-[var(--tb-blue)] px-4 py-2.5 text-sm font-bold text-white hover:bg-[var(--tb-blue-dark)] disabled:opacity-40">{loading ? "조회 중" : "검색"}</button>
          </form>}
          <div className="ml-auto hidden items-center gap-2 text-sm font-semibold text-slate-500 lg:flex">
            <button type="button" onClick={handleHome} className="tb-focus rounded-lg px-3 py-2 text-[var(--tb-blue)]">홈</button>
            {searchedStock && <span className="rounded-lg px-3 py-2 text-slate-700">종목 분석</span>}
            <button type="button" onClick={() => { handleHome(); setShowFullTop(true); }} className="tb-focus rounded-lg px-3 py-2 hover:bg-slate-50 hover:text-slate-900">모델 TOP</button>
          </div>
        </div>
      </header>
      <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 sm:py-8 lg:px-8">
        {!searchedStock && <section className="relative overflow-hidden rounded-[28px] bg-[#071a3b] px-6 py-9 text-white shadow-[0_20px_45px_rgba(17,39,78,0.16)] sm:px-10 sm:py-12 lg:px-14 lg:py-14">
          <div aria-hidden="true" className="absolute -right-20 -top-24 h-80 w-80 rounded-full border-[52px] border-blue-500/25" />
          <div aria-hidden="true" className="absolute -bottom-36 right-16 h-72 w-72 rounded-full border-[42px] border-red-500/25" />
          <div className="relative max-w-2xl">
            <p className="text-sm font-semibold uppercase tracking-[0.18em] text-blue-200">Tight Budget</p>
            <h1 className="mt-3 text-3xl font-extrabold tracking-tight sm:text-5xl">데이터로 시작하는 종목 분석</h1>
            <p className="mt-4 max-w-xl text-sm leading-6 text-slate-300 sm:text-base">공식 가격과 저장된 기술·재무 분석, 검증 중인 모델 순위를 한곳에서 명확한 기준일과 함께 확인하세요.</p>
          </div>
        </section>}

        {!searchedStock && <div className="relative z-10 mx-auto -mt-5 flex max-w-3xl flex-col gap-2 px-3 sm:-mt-6 sm:flex-row">
          <input
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
className="tb-focus min-h-13 w-full rounded-2xl border border-[var(--tb-border)] bg-white px-5 py-3.5 text-slate-950 shadow-[0_8px_24px_rgba(17,39,78,0.08)] placeholder:text-slate-400 focus:border-blue-400 focus:outline-none"/>

          <button
  onClick={() => void handleSearch()}
  disabled={loading}
  className="tb-focus min-h-13 whitespace-nowrap rounded-2xl bg-[var(--tb-blue)] px-7 py-3.5 font-bold text-white shadow-sm transition-colors hover:bg-[var(--tb-blue-dark)] disabled:opacity-40"
>
  {loading ? "검색 중" : "검색"}
</button>
        </div>}

        {searchError && <p role="alert" className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">{searchError === "notFound" ? "해당 종목을 찾을 수 없습니다." : "검색 중 문제가 발생했습니다. 잠시 후 다시 시도해 주세요."}</p>}
        {!searchedStock && <p className="mx-auto mt-3 max-w-3xl px-3 text-sm text-slate-500">
          종목명 또는 종목코드를 입력하세요.
        </p>}

        {!searchedStock && !showFullTop && <TopStocksPanel compact onSelectStock={handleSearch} onOpenFull={() => setShowFullTop(true)} />}
        {!searchedStock && showFullTop && <><button type="button" onClick={() => setShowFullTop(false)} className="mt-8 text-sm font-semibold text-gray-600 hover:text-gray-950">← 검색 화면으로</button><TopStocksPanel onSelectStock={handleSearch} /></>}

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
    </main>
  );
}
