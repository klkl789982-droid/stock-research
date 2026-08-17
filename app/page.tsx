"use client";

import { useState, useEffect, useRef } from "react";
import TopStocksPanel from "../components/TopStocksPanel";
import MarketAnalysisPanel from "../components/market-analysis/MarketAnalysisPanel";
import CompanyAnalysisPanel, { type CompanyAnalysisResult } from "../components/company-analysis/CompanyAnalysisPanel";
export default function Home() {
  const [query, setQuery] = useState("");
  const [searchedStock, setSearchedStock] = useState<string | null>(null);
const [activeTab, setActiveTab] = useState<string | null>(null);
const [realtimePrice, setRealtimePrice] = useState<{
  price: number;
  change: number;
  rate: number;
  volume: number;
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
const [loading, setLoading] = useState(false);
const [realtimeError, setRealtimeError] = useState<string | null>(null);
const [priceError, setPriceError] = useState<string | null>(null);
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
const apiErrorMessage = (data: unknown, fallback: string) => {
  if (!data || typeof data !== "object") return fallback;
  const error = (data as { error?: unknown }).error;
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string") return (error as { message: string }).message;
  return fallback;
};
useEffect(() => {
  if (!stockInfo) return;

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
      const response = await fetch(`/api/realtime?code=${stockCode}`, { signal: activeController.signal });
      const data = await response.json();
      if (!response.ok) return fail(apiErrorMessage(data, "현재 시세 조회 실패"));
      if (data.price === undefined || data.rate === undefined || data.volume === undefined || data.change === undefined || data.code !== stockCode || !Number.isFinite(data.price) || data.price <= 0) {
        return fail("현재 시세 응답이 올바르지 않습니다.");
      }
      if (selectedCodeRef.current !== stockCode) return;
      consecutiveFailures = 0;
      setRealtimePrice(data);
      setRealtimeError(null);
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

}, [stockInfo]);
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
  if (selection) setQuery(selection.name);
const requestId = ++searchRequestIdRef.current;
searchControllerRef.current?.abort();
const searchController = new AbortController();
searchControllerRef.current = searchController;
selectedCodeRef.current = null;
setRealtimePrice(null);
setPriceInfo(null);
setPriceHistory([]);
setPriceMeta(null);
setRealtimeError(null);
setPriceError(null);
setInvestorData(null);
setCompanyAnalysis(null);
setCompanyAnalysisError(null);
setCompanyAnalysisLoading(true);
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

const [
  priceResponse,
  realtimeResponse,
  companyResponse
] = await Promise.all([
  fetch(`/api/price?code=${stockCode}`, { signal: searchController.signal }),
  fetch(`/api/realtime?code=${stockCode}`, { signal: searchController.signal }),
  fetch(`/api/company-analysis?code=${stockCode}`, { signal: searchController.signal, cache: "no-store" }).catch((error) => {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    return null;
  })
]);

const priceData = await priceResponse.json();
if (requestId !== searchRequestIdRef.current || selectedCodeRef.current !== stockCode) return;

console.log("가격 API 원본:", priceData);

if (!priceResponse.ok) {
  setPriceInfo(null);
  setPriceHistory([]);
  setPriceMeta(null);
  setPriceError(priceData?.error ?? "공식 종가 조회 실패");
} else if (priceData.code === stockCode && priceData.items && priceData.items.length > 0) {
  setPriceInfo(priceData.items[0]);
  setPriceHistory(priceData.items);
  setPriceMeta({ code: priceData.code, source: priceData.source, priceBasis: priceData.priceBasis, asOfDate: priceData.asOfDate, closePrice: priceData.closePrice });
  setPriceError(null);

  console.log("priceHistory 개수:", priceData.items.length);
} else {
  setPriceInfo(null);
  setPriceHistory([]);
  setPriceMeta(null);
  setPriceError("공식 종가 응답이 현재 종목과 일치하지 않습니다.");
}
const companyData = companyResponse ? await companyResponse.json() : null;
if (requestId !== searchRequestIdRef.current || selectedCodeRef.current !== stockCode) return;
if (companyResponse?.ok) { setCompanyAnalysis(companyData); setCompanyAnalysisError(null); }
else { setCompanyAnalysis(null); setCompanyAnalysisError(apiErrorMessage(companyData, "저장된 기업분석 결과가 없습니다.")); }
setCompanyAnalysisLoading(false);
if (!realtimeResponse.ok) {
  console.error(
    "실시간 API 실패",
    realtimeResponse.status
  );
  const realtimeErrorData = await realtimeResponse.json();
  setRealtimePrice(null);
  setRealtimeError(apiErrorMessage(realtimeErrorData, `현재 시세 조회 실패 (HTTP ${realtimeResponse.status})`));
} else {
  const realtimeData = await realtimeResponse.json();
  if (requestId !== searchRequestIdRef.current || selectedCodeRef.current !== stockCode) return;
  if (realtimeData.code !== stockCode || !Number.isFinite(realtimeData.price) || realtimeData.price <= 0) {
    setRealtimePrice(null);
    setRealtimeError("현재 시세 응답이 올바르지 않습니다.");
  } else {
    setRealtimePrice(realtimeData);
    setRealtimeError(null);
  }
  console.log("실시간 데이터:", realtimeData);
}


} else {
      alert("종목을 찾을 수 없습니다.");
    }
  } catch (error) {
    console.error(error);
    alert("검색 중 오류가 발생했습니다.");
  }
  finally {
  if (requestId === searchRequestIdRef.current) setCompanyAnalysisLoading(false);
  if (requestId === searchRequestIdRef.current) setLoading(false);
}
}
return (
    <main ref={pageTopRef} className="min-h-screen bg-gray-50">
      <div className="mx-auto max-w-md px-5 py-16">
        <h1 className="text-3xl font-bold text-gray-900">
          Stock Research
        </h1>

        <p className="mt-3 text-gray-600">
          주식 데이터를 쉽고 객관적으로 분석합니다.
        </p>

        <div className="mt-10 flex gap-2">
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
  placeholder="종목명을 검색하세요"
className="w-full rounded-xl border border-gray-300 bg-white px-4 py-3 text-black placeholder:text-gray-400"/>

          <button
  onClick={() => void handleSearch()}
  disabled={loading}
  className="whitespace-nowrap rounded-xl bg-gray-900 px-5 py-4 font-medium text-white disabled:opacity-40"
>
  {loading ? "Loading..." : "검색"}
</button>
        </div>

        <p className="mt-4 text-sm text-gray-500">
          종목명 또는 종목코드를 입력하세요.
        </p>

        {searchedStock && (
          <div className="mt-10 rounded-2xl border border-gray-200 bg-white p-5">
            <p className="text-sm text-gray-500">검색 결과</p>

            <h2 className="mt-2 text-2xl font-bold text-gray-900">
              {searchedStock}
            </h2>

           <div className="mt-2 space-y-1 text-sm text-gray-600">
  <p>시장 : {stockInfo?.mrktCtg}</p>
  <p>종목코드 : {stockInfo?.srtnCd?.replace(/^A/, "")}</p>
  <p>법인명 : {stockInfo?.corpNm}</p>
  <p>ISIN : {stockInfo?.isinCd}</p>
  <p>
    기준일 :
    {stockInfo?.basDt
      ? `${stockInfo.basDt.slice(0, 4)}-${stockInfo.basDt.slice(4, 6)}-${stockInfo.basDt.slice(6, 8)}`
      : ""}
  </p>
</div>
{(priceInfo || realtimePrice || priceError || realtimeError) && (
  <div className="mt-5 rounded-xl bg-gray-50 p-4">
    <p className="text-sm font-semibold text-gray-900">
      최근 시세
    </p>

    <div className="mt-3 space-y-2 text-sm text-gray-700">
      <div className="flex justify-between">
  <span>{realtimePrice ? "마지막 조회가" : "최근 거래일 종가"}</span>
  <span>
  {realtimePrice
    ? `${realtimePrice.price.toLocaleString()}원`
    : priceMeta
    ? `${priceMeta.closePrice.toLocaleString()}원`
    : "-"}
</span>
</div>
{realtimeError && <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{realtimeError}. 이전 종목 가격을 표시하지 않습니다.</p>}
{priceError && <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">{priceError}</p>}
{(realtimePrice || priceInfo) && (
<>
<div className="flex justify-between">
  <span>전일 종가</span>
  <span>
    {realtimePrice
  ? (realtimePrice.price - realtimePrice.change).toLocaleString()
  : priceHistory[1]?.clpr
  ? Number(priceHistory[1].clpr).toLocaleString()
  : "-"}원
  </span>
</div>

      <div className="flex justify-between">
        <span>전일 대비</span>
        <span>
  {(
    realtimePrice?.change ??
    (priceInfo?.vs ? Number(priceInfo.vs) : 0)
  ).toLocaleString()}원
</span>
      </div>

      <div className="flex justify-between">
  <span>등락률</span>
  <span>
  {(
    realtimePrice?.rate ??
    (priceInfo?.fltRt ? Number(priceInfo.fltRt) : 0)
  ).toFixed(2)}%
</span>
</div>

      <div className="flex justify-between">
        <span>거래량</span>
        <span>
  {(
    realtimePrice?.volume ??
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
    realtimePrice?.high ??
    (priceInfo?.hipr ? Number(priceInfo.hipr) : 0)
  ).toLocaleString()}원
</span>
      </div>

      <div className="flex justify-between">
        <span>저가</span>
        <span>
  {(
    realtimePrice?.low ??
    (priceInfo?.lopr ? Number(priceInfo.lopr) : 0)
  ).toLocaleString()}원
</span>
      </div>

</>
)}

      <div className="flex justify-between">
  <span>가격 기준</span>
  <span>
    {realtimePrice
      ? `KIS · ${realtimePrice.asOfDate ?? "기준일 미제공"}${realtimePrice.asOfTime ? ` ${realtimePrice.asOfTime}` : ""} · ${realtimePrice.marketStatus === "closed" ? "휴장" : realtimePrice.marketStatus === "open" ? "장중" : "시장 상태 확인 불가"}`
      : priceMeta
      ? `${priceMeta.asOfDate} · 공식 일봉 종가`
      : "가격 정보 없음"}
  </span>
</div>
    </div>
  </div>
)}

            <div className="mt-6 grid grid-cols-2 gap-2 sm:grid-cols-4">
              <button
  onClick={() => setActiveTab("investor")}
  className="rounded-xl border border-gray-200 px-3 py-3 text-sm"
>
  기업 분석
</button>

              <button
  onClick={() => setActiveTab("trader")}
  className="rounded-xl border border-gray-200 px-3 py-3 text-sm"
>
  시장 분석
</button>

              <button
  onClick={() => setActiveTab("dividend")}
  className="rounded-xl border border-gray-200 px-3 py-3 text-sm"
>
  배당 분석
</button>

              <button
  onClick={() => setActiveTab("topStocks")}
  className="rounded-xl border border-gray-200 px-3 py-3 text-sm"
>
  시장 TOP 종목
</button>
            </div>
          </div>
        )}
{activeTab === "investor" && searchedStock && (
  <CompanyAnalysisPanel result={companyAnalysis} loading={companyAnalysisLoading} error={companyAnalysisError} />
)}
{activeTab === "trader" && searchedStock && stockInfo?.srtnCd && (
  <MarketAnalysisPanel key={String(stockInfo.srtnCd)} code={String(stockInfo.srtnCd).replace(/^A/, "")} investorData={investorData} />
)}
{activeTab === "trader" && searchedStock && (
  <div className="mt-6 rounded-2xl border border-gray-200 bg-white p-5">
    <p className="text-sm text-gray-500">Short Signal</p>

    <h2 className="mt-1 text-xl font-bold text-gray-900">
      공매도 관련 시장 데이터
    </h2>

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
{activeTab === "dividend" && searchedStock && (
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
{activeTab === "topStocks" && searchedStock && <TopStocksPanel onSelectStock={handleSearch} />}
      </div>
    </main>
  );
}
